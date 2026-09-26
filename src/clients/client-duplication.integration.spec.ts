import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { ClientDuplicationService } from './client-duplication.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { AgentConfigResolver } from '../orchestrator/services/agent-config-resolver.service';
import { ApiToolExecutorService } from '../orchestrator/services/api-tool-executor.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MockEmbeddingProvider } from '../knowledge/providers/mock-embedding.provider';
import { encrypt, decrypt } from '../common/utils/crypto.util';

jest.mock('../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
}));
const databaseUrl = process.env.FLOW_DUPLICATION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('complete flow duplication on disposable PostgreSQL', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl || 'postgresql://unused' } },
  });
  const actor = {
    id: randomUUID(),
    company_id: randomUUID(),
    role: 'company_admin',
  };
  const sourceId = randomUUID(),
    otherCompany = randomUUID();
  const firstAgent = randomUUID(),
    secondAgent = randomUUID(),
    subagentId = randomUUID();
  const firstApi = randomUUID(),
    nextApi = randomUUID(),
    baseId = randomUUID(),
    docId = randomUUID(),
    chunkId = randomUUID(),
    assetId = randomUUID();
  const prodEndpoint = randomUUID(),
    testEndpoint = randomUUID();
  const secret = randomUUID(),
    encryptionKey = randomUUID();
  let root: string;
  let service: ClientDuplicationService;
  const media = { copyFlowFile: jest.fn(), removeFlowFile: jest.fn() };
  const resolver = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const countCopies = () =>
    prisma.painel_clients.count({ where: { company_id: actor.company_id } });
  const endpoints = () => [
    { source_endpoint_id: prodEndpoint, did_number: randomUUID() },
    { source_endpoint_id: testEndpoint, did_number: randomUUID() },
  ];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/flow_duplication_test'
    )
      throw new Error(
        'Requires the explicit disposable loopback flow_duplication_test database',
      );
    root = await fs.mkdtemp(join(tmpdir(), 'synexa-flow-copy-'));
    media.copyFlowFile.mockImplementation(
      async (bucket: string, source: string, target: string) => {
        await fs.mkdir(dirname(join(root, bucket, target)), {
          recursive: true,
        });
        await fs.copyFile(
          join(root, bucket, source),
          join(root, bucket, target),
        );
      },
    );
    media.removeFlowFile.mockImplementation(
      async (bucket: string, path: string) => {
        await fs.unlink(join(root, bucket, path)).catch(() => undefined);
      },
    );
    service = new ClientDuplicationService(
      prisma as any,
      media,
      new ClientMetadataService(prisma as any),
      resolver as any,
    );
    await prisma.companies.createMany({
      data: [
        { id: actor.company_id, name: 'Flow copy tests' },
        { id: otherCompany, name: 'Other tenant' },
      ],
    });
    await prisma.users.create({
      data: { id: actor.id, company_id: actor.company_id, role: actor.role },
    });
    await prisma.painel_clients.create({
      data: {
        id: sourceId,
        company_id: actor.company_id,
        company_name: 'Original',
        agent_name: 'Assistant',
        metadata: {
          voice_engine: 'live_api',
          voice_behavior: { idleEnabled: true },
          sessionId: 'must-not-copy',
          tentativas: 9,
          test_sip_extension: '7001',
          llm_providers: {
            gemini: { apiKey: `enc:${encrypt(secret, encryptionKey)}` },
          },
        },
      },
    });
    await prisma.painel_agents.createMany({
      data: [
        {
          id: firstAgent,
          client_id: sourceId,
          service_step: 'Initial',
          execution_order: 1,
          is_initial: true,
          system_prompt: 'Original prompt',
          allowed_tool_names: ['lookup'],
          transitions: {
            allowed_subagents: [subagentId],
            allowed_knowledge_base_ids: [baseId],
            target_agent_id: secondAgent,
          },
        },
        {
          id: secondAgent,
          client_id: sourceId,
          service_step: 'Next',
          execution_order: 2,
          activation_conditions: {
            logic: 'AND',
            conditions: [
              { variable: 'phase', operator: 'equals', value: 'next' },
            ],
          },
        },
      ],
    });
    await prisma.painel_subagents.create({
      data: {
        id: subagentId,
        client_id: sourceId,
        name: 'Specialist',
        description: 'Test specialist',
        system_prompt: 'Specialist prompt',
        allowed_knowledge_base_ids: [baseId],
      },
    });
    await prisma.painel_apis.createMany({
      data: [
        {
          id: firstApi,
          client_id: sourceId,
          agent_id: firstAgent,
          name: 'lookup',
          url: 'https://example.com/lookup',
          headers: { next_api_id: nextApi, headers: { Authorization: secret } },
          next_tool: nextApi,
        },
        {
          id: nextApi,
          client_id: sourceId,
          agent_id: secondAgent,
          name: 'finish',
          url: 'https://example.com/finish',
        },
        {
          client_id: sourceId,
          agent_id: null,
          name: 'shared_tool',
          url: 'https://example.com/shared',
        },
      ],
    });
    await prisma.painel_tracks.create({
      data: {
        client_id: sourceId,
        agent_id: firstAgent,
        code: 'support',
        label: 'Support',
        description: 'Support flow',
      },
    });
    await prisma.provider_credentials.create({
      data: {
        company_id: actor.company_id,
        client_id: sourceId,
        provider: 'gemini',
        api_key_enc: `enc:${encrypt(secret, encryptionKey)}`,
        last_used_at: new Date(),
      },
    });
    await prisma.knowledge_bases.create({
      data: {
        id: baseId,
        company_id: actor.company_id,
        client_id: sourceId,
        name: 'Help',
      },
    });
    await fs.mkdir(join(root, 'test'), { recursive: true });
    await fs.writeFile(join(root, 'test', 'original.txt'), 'Original document');
    await prisma.media_assets.create({
      data: {
        id: assetId,
        company_id: actor.company_id,
        client_id: sourceId,
        storage_bucket: 'test',
        storage_path: 'original.txt',
        mime_type: 'text/plain',
        status: 'ready',
      },
    });
    await prisma.knowledge_documents.create({
      data: {
        id: docId,
        company_id: actor.company_id,
        client_id: sourceId,
        knowledge_base_id: baseId,
        media_asset_id: assetId,
        title: 'Support document',
        status: 'ready',
        metadata: { raw_content: 'Support answer' },
      },
    });
    await prisma.knowledge_chunks.create({
      data: {
        id: chunkId,
        company_id: actor.company_id,
        client_id: sourceId,
        knowledge_base_id: baseId,
        document_id: docId,
        content: 'Support answer',
        chunk_index: 0,
      },
    });
    const vector = new MockEmbeddingProvider().generateEmbedding(
      'Support answer',
    );
    await prisma.$executeRaw(
      Prisma.sql`INSERT INTO knowledge_embeddings (company_id, client_id, knowledge_base_id, chunk_id, provider, model, dimensions, embedding) VALUES (${actor.company_id}::uuid, ${sourceId}::uuid, ${baseId}::uuid, ${chunkId}::uuid, 'mock', 'mock', ${vector.length}, ${JSON.stringify(vector)}::vector)`,
    );
    await prisma.telephony_endpoints.createMany({
      data: [
        {
          id: prodEndpoint,
          company_id: actor.company_id,
          client_id: sourceId,
          provider: 'audiosocket',
          did_number: '6001',
          inbound_secret_hash: 'old-hash',
        },
        {
          id: testEndpoint,
          company_id: actor.company_id,
          client_id: sourceId,
          provider: 'audiosocket',
          did_number: '7001',
          agent_step: 'test',
        },
      ],
    });
    await prisma.conversations.create({
      data: {
        company_id: actor.company_id,
        client_id: sourceId,
        origin_channel: 'voice',
      },
    });
  }, 30000);

  afterAll(async () => {
    await prisma.conversations.deleteMany({
      where: { company_id: actor.company_id },
    });
    await prisma.users.deleteMany({ where: { id: actor.id } });
    await prisma.companies.deleteMany({
      where: { id: { in: [actor.company_id, otherCompany] } },
    });
    await prisma.$disconnect();
    if (
      root &&
      dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith('synexa-flow-copy-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  afterEach(() => jest.restoreAllMocks());

  it('previews only public counts and endpoint identities', async () => {
    const preview = await service.preview(sourceId, actor);
    expect(preview.company_name).toBe('Original (Cópia)');
    expect(preview.counts.painel_apis).toBe(3);
    expect(preview.endpoints).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain(secret);
    expect(JSON.stringify(preview)).not.toContain('old-hash');
  });

  it('copies the complete graph, credentials, vectors and independent files; executes the copied flow', async () => {
    const replacement = endpoints();
    const copy = await service.duplicate(
      sourceId,
      { company_name: 'Independent copy', endpoints: replacement },
      actor,
    );
    expect(copy.id).not.toBe(sourceId);
    expect(copy.company_id).toBe(actor.company_id);
    expect(copy).not.toHaveProperty('metadata');
    const client = await prisma.painel_clients.findUniqueOrThrow({
      where: { id: copy.id },
    });
    expect(client.metadata).toMatchObject({
      voice_engine: 'live_api',
      test_sip_extension: replacement[1].did_number,
    });
    expect((client.metadata as any).sessionId).not.toBe('must-not-copy');
    const agents = await prisma.painel_agents.findMany({
      where: { client_id: copy.id },
      orderBy: { execution_order: 'asc' },
    });
    const base = await prisma.knowledge_bases.findFirstOrThrow({
      where: { client_id: copy.id },
    });
    const subagent = await prisma.painel_subagents.findFirstOrThrow({
      where: { client_id: copy.id },
    });
    expect(agents[0].transitions).toMatchObject({
      target_agent_id: agents[1].id,
      allowed_subagents: [subagent.id],
      allowed_knowledge_base_ids: [base.id],
    });
    const credential = await prisma.provider_credentials.findFirstOrThrow({
      where: { client_id: copy.id },
    });
    expect(decrypt(credential.api_key_enc.slice(4), encryptionKey)).toBe(
      secret,
    );
    expect(credential.last_used_at).toBeNull();
    const tools = await prisma.painel_apis.findMany({
      where: { client_id: copy.id },
    });
    const lookup = tools.find((t) => t.name === 'lookup')!;
    expect(lookup.agent_id).toBe(agents[0].id);
    expect(lookup.next_tool).toBe(tools.find((t) => t.name === 'finish')!.id);
    expect((lookup.headers as any).next_api_id).toBe(lookup.next_tool);
    expect(tools.find((t) => t.name === 'shared_tool')!.agent_id).toBeNull();
    const clonedEndpoints = await prisma.telephony_endpoints.findMany({
      where: { client_id: copy.id },
    });
    expect(clonedEndpoints.map((e) => e.did_number).sort()).toEqual(
      replacement.map((e) => e.did_number).sort(),
    );
    expect(
      clonedEndpoints.find((e) => e.agent_step !== 'test')!.inbound_secret_hash,
    ).not.toBe('old-hash');
    const asset = await prisma.media_assets.findFirstOrThrow({
      where: { client_id: copy.id },
    });
    expect(asset.storage_path).not.toBe('original.txt');
    expect(
      await fs.readFile(join(root, 'test', asset.storage_path!), 'utf8'),
    ).toBe('Original document');
    expect(
      await prisma.conversations.count({ where: { client_id: copy.id } }),
    ).toBe(0);
    const vectors = await prisma.$queryRaw<any[]>(
      Prisma.sql`SELECT embedding::text AS value FROM knowledge_embeddings WHERE client_id IN (${sourceId}::uuid, ${copy.id}::uuid)`,
    );
    expect(vectors).toHaveLength(2);
    expect(vectors[0].value).toBe(vectors[1].value);
    const agentResolver = new AgentConfigResolver(prisma as any);
    const initial = await agentResolver.resolveAgentConfig(
      copy.id,
      {},
      'voice',
    );
    expect(initial.agentId).toBe(agents[0].id);
    const next = await agentResolver.resolveAgentConfig(
      copy.id,
      { pending_agent_id: (agents[0].transitions as any).target_agent_id },
      'voice',
    );
    expect(next.agentId).toBe(agents[1].id);
    const executor = new ApiToolExecutorService(
      prisma as any,
      {} as any,
      {} as any,
    );
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ phase: 'next' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const executed = await executor.executeToolCall({
      tool: { ...lookup, functionName: 'lookup' },
      functionName: 'lookup',
      args: {},
      context: { message: 'help', callLlm: jest.fn() },
    });
    expect(executed.result).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const knowledge = new KnowledgeService(
      prisma as any,
      {} as any,
      {
        get: (key: string) =>
          key === 'ENVIRONMENT' ? 'development' : undefined,
      } as any,
      new MockEmbeddingProvider(),
      { resolveApiKey: jest.fn().mockResolvedValue(null) } as any,
    );
    const matches = (await knowledge.search(
      base.id,
      { query: 'Support answer' },
      actor.id,
    )) as any[];
    expect(matches[0].content).toBe('Support answer');
    await prisma.painel_agents.update({
      where: { id: agents[0].id },
      data: { system_prompt: 'Changed copy' },
    });
    expect(
      (
        await prisma.painel_agents.findUniqueOrThrow({
          where: { id: firstAgent },
        })
      ).system_prompt,
    ).toBe('Original prompt');
    await prisma.painel_clients.delete({ where: { id: copy.id } });
    await fs.unlink(join(root, 'test', asset.storage_path!));
    expect(await fs.readFile(join(root, 'test', 'original.txt'), 'utf8')).toBe(
      'Original document',
    );
    expect(
      await prisma.knowledge_bases.findUnique({ where: { id: baseId } }),
    ).not.toBeNull();
  }, 30000);

  it('supports legacy bodyless duplication without copying any telephony', async () => {
    const copy = await service.duplicate(sourceId, {}, actor);
    expect(
      await prisma.telephony_endpoints.count({ where: { client_id: copy.id } }),
    ).toBe(0);
    const saved = await prisma.painel_clients.findUniqueOrThrow({
      where: { id: copy.id },
    });
    expect(saved.company_name).toBe('Original (Cópia)');
    expect(saved.metadata).not.toHaveProperty('test_sip_extension');
  });

  it('rejects other tenants, non-admins and unrelated endpoint IDs', async () => {
    const before = await countCopies();
    await expect(
      service.duplicate(sourceId, {}, { ...actor, company_id: otherCompany }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.duplicate(sourceId, {}, { ...actor, role: 'operator' }),
    ).rejects.toMatchObject({ status: 403 });
    const replacement = endpoints();
    replacement[0].source_endpoint_id = randomUUID();
    await expect(
      service.duplicate(sourceId, { endpoints: replacement }, actor),
    ).rejects.toMatchObject({ status: 400 });
    expect(await countCopies()).toBe(before);
  });

  it('rejects pending documents without creating a partial copy', async () => {
    const before = await countCopies();
    await prisma.knowledge_documents.update({
      where: { id: docId },
      data: { status: 'processing' },
    });
    try {
      await expect(
        service.duplicate(sourceId, {}, actor),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await prisma.knowledge_documents.update({
        where: { id: docId },
        data: { status: 'ready' },
      });
    }
    expect(await countCopies()).toBe(before);
  });

  it('rolls back database rows and prepared files on an intermediate database failure', async () => {
    const before = await countCopies();
    const removedBefore = media.removeFlowFile.mock.calls.length;
    await expect(
      service.duplicate(sourceId, {}, { ...actor, id: 'invalid-uuid' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await countCopies()).toBe(before);
    expect(media.removeFlowFile.mock.calls.length).toBe(removedBefore + 1);
    const [bucket, path] = media.removeFlowFile.mock.calls.at(-1)!;
    await expect(fs.stat(join(root, bucket, path))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cleans files and creates no client when storage fails', async () => {
    const before = await countCopies();
    media.copyFlowFile.mockRejectedValueOnce(new Error('storage failure'));
    await expect(service.duplicate(sourceId, {}, actor)).rejects.toMatchObject({
      status: 500,
    });
    expect(await countCopies()).toBe(before);
  });

  it('rejects occupied numbers across companies without moving the endpoint', async () => {
    const replacement = endpoints();
    const occupied = await prisma.telephony_endpoints.create({
      data: {
        company_id: otherCompany,
        provider: 'audiosocket',
        did_number: replacement[0].did_number,
      },
    });
    const before = await countCopies();
    await expect(
      service.duplicate(sourceId, { endpoints: replacement }, actor),
    ).rejects.toMatchObject({
      status: 409,
      response: { source_endpoint_id: prodEndpoint },
    });
    expect(await countCopies()).toBe(before);
    expect(
      (
        await prisma.telephony_endpoints.findUniqueOrThrow({
          where: { id: occupied.id },
        })
      ).company_id,
    ).toBe(otherCompany);
  });

  it('allows only one of two concurrent copies to claim the same numbers', async () => {
    const replacement = endpoints();
    const before = await countCopies();
    const results = await Promise.allSettled([
      service.duplicate(sourceId, { endpoints: replacement }, actor),
      service.duplicate(sourceId, { endpoints: replacement }, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    expect(await countCopies()).toBe(before + 1);
  }, 30000);
  it('rejects configuration edits during file preparation and compensates files', async () => {
    const before = await countCopies();
    const normalCopy = media.copyFlowFile.getMockImplementation()!;
    media.copyFlowFile.mockImplementationOnce(async (...args: any[]) => {
      await normalCopy(...args);
      await prisma.painel_agents.update({
        where: { id: firstAgent },
        data: { system_prompt: 'Changed during copy' },
      });
    });
    try {
      await expect(
        service.duplicate(sourceId, {}, actor),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await prisma.painel_agents.update({
        where: { id: firstAgent },
        data: { system_prompt: 'Original prompt' },
      });
    }
    expect(await countCopies()).toBe(before);
  });

  it('does not reject an active flow just because credential usage changes', async () => {
    const normalCopy = media.copyFlowFile.getMockImplementation()!;
    media.copyFlowFile.mockImplementationOnce(async (...args: any[]) => {
      await normalCopy(...args);
      await prisma.provider_credentials.updateMany({
        where: { client_id: sourceId },
        data: { last_used_at: new Date() },
      });
    });
    await expect(
      service.duplicate(sourceId, {}, actor),
    ).resolves.toHaveProperty('id');
  });

  it('rejects dangling internal references rather than leaving links to another flow', async () => {
    const source = await prisma.painel_agents.findUniqueOrThrow({
      where: { id: firstAgent },
    });
    await prisma.painel_agents.update({
      where: { id: firstAgent },
      data: { transitions: { allowed_knowledge_base_ids: [randomUUID()] } },
    });
    try {
      await expect(
        service.duplicate(sourceId, {}, actor),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await prisma.painel_agents.update({
        where: { id: firstAgent },
        data: { transitions: source.transitions as any },
      });
    }
  });

  it('duplicates a client with no agents, documents or endpoints', async () => {
    const source = await prisma.painel_clients.create({
      data: { company_id: actor.company_id, company_name: 'Empty flow' },
    });
    const copy = await service.duplicate(source.id, { endpoints: [] }, actor);
    expect(copy.company_name).toBe('Empty flow (Cópia)');
    expect(
      await prisma.painel_agents.count({ where: { client_id: copy.id } }),
    ).toBe(0);
  });
});
