import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { patchConversationState } from './conversation-state';
import { anonymizeConversationConsumption } from './consumption-erasure';
import { tenantLocalStorage } from '../auth/tenant-context';
import { ApisRepository } from '../../apis/repositories/apis.repository';
import { AgentsRepository } from '../../agents/repositories/agents.repository';

const integration = process.env.STRUCTURE_TEST_DATABASE_URL
  ? describe
  : describe.skip;
integration('Operational schema against disposable PostgreSQL', () => {
  const db = new PrismaClient(
    process.env.STRUCTURE_TEST_DATABASE_URL
      ? {
          datasources: { db: { url: process.env.STRUCTURE_TEST_DATABASE_URL } },
        }
      : undefined,
  );
  const company = randomUUID(),
    client = randomUUID(),
    conversation = randomUUID();
  beforeAll(async () => {
    await db.companies.create({
      data: { id: company, name: 'Structure regression' },
    });
    await db.painel_clients.create({
      data: {
        id: client,
        company_id: company,
        company_name: 'Test',
        agent_name: 'Agent',
      },
    });
    await db.conversations.create({
      data: { id: conversation, company_id: company, client_id: client },
    });
  });
  afterAll(async () => {
    await db.agent_runs.deleteMany({ where: { company_id: company } });
    await db.voice_session_telemetry.deleteMany({
      where: { company_id: company },
    });
    await db.companies.delete({ where: { id: company } });
    await db.$disconnect();
  });
  it('merges concurrent patches with exact JSON types, version and timestamp', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        patchConversationState(db as any, conversation, { ['Key' + i]: i }),
      ),
    );
    await patchConversationState(db as any, conversation, {
      CPF: '00012',
      F: false,
      N: null,
      O: { a: [0, false] },
    });
    const record = await db.conversation_state.findUniqueOrThrow({
      where: { conversation_id: conversation },
    });
    expect(record.version).toBe(13);
    expect(Object.keys(record.state as any)).toHaveLength(16);
    expect(record.state).toMatchObject({
      CPF: '00012',
      F: false,
      N: null,
      O: { a: [0, false] },
    });
    expect(record.updated_at!.getTime()).toBeGreaterThanOrEqual(
      record.created_at!.getTime(),
    );
  });
  it('scopes raw state updates to the authenticated company', async () => {
    await tenantLocalStorage.run(
      { companyId: randomUUID(), role: 'company_admin' },
      async () => {
        await expect(
          patchConversationState(db as any, conversation, { CPF: 'wrong' }),
        ).rejects.toThrow('conversation_state_not_found');
      },
    );
  });
  it('keeps API controls out of HTTP headers on create, read and update', async () => {
    const repo = new ApisRepository(db as any);
    const api = await repo.create(client, {
      name: 'Consulta',
      headers: { 'X-Configured': 'value' },
      next_api_id: 'configured-target',
      request_schema: { A: 'B' },
    });
    expect(api.headers).toEqual({ 'X-Configured': 'value' });
    expect(api.next_api_id).toBe('configured-target');
    await repo.update(api.id, {
      field_description: 'Control',
      headers: { 'X-New': 'only' },
    });
    const stored = await db.painel_apis.findUniqueOrThrow({
      where: { id: api.id },
    });
    expect(stored.headers).toEqual({ 'X-New': 'only' });
    expect(stored.config).toMatchObject({
      next_api_id: 'configured-target',
      field_description: 'Control',
    });
  });
  it('serializes concurrent initial agent selection', async () => {
    const repo = new AgentsRepository(db as any);
    await Promise.all(
      [1, 2, 3].map((i) =>
        repo.create(client, {
          service_step: 'Agent ' + i,
          is_initial: true,
          is_active: true,
        }),
      ),
    );
    expect(
      await db.painel_agents.count({
        where: { client_id: client, is_initial: true, is_active: true },
      }),
    ).toBe(1);
  });
  it('rejects a cross-tenant reference even without the Prisma tenant extension', async () => {
    await expect(
      db.agent_runs.create({
        data: {
          company_id: randomUUID(),
          client_id: client,
          conversation_id: conversation,
        },
      }),
    ).rejects.toThrow();
  });
  it('keeps tool identifiers stable and unique when names collide or change', async () => {
    const repo = new ApisRepository(db as any);
    const first = await repo.create(client, { name: 'Duplicada' });
    const second = await repo.create(client, { name: 'Duplicada' });
    expect(first.function_name).not.toBe(second.function_name);
    const renamed = await repo.update(first.id, { name: 'Outro nome' });
    expect(renamed.function_name).toBe(first.function_name);
  });
  it('allows an incomplete draft but rejects activating its agent', async () => {
    const draft = await db.painel_clients.create({
      data: { company_id: company },
    });
    await expect(
      db.painel_agents.create({
        data: { client_id: draft.id, is_active: true },
      }),
    ).rejects.toThrow();
    await db.painel_agents.create({
      data: { client_id: draft.id, is_active: false },
    });
  });
  it('erases personal content while preserving billable usage', async () => {
    await db.agent_runs.create({
      data: {
        company_id: company,
        client_id: client,
        conversation_id: conversation,
        total_tokens: 123,
        cost: new Prisma.Decimal('0.012345'),
        trace: { private: 'content' },
      },
    });
    await db.voice_session_telemetry.create({
      data: {
        company_id: company,
        client_id: client,
        conversation_id: conversation,
        total_tokens: 456,
        cost_usd: 0.12345,
        caller_number: 'test',
      },
    });
    await db.$transaction(async (tx) => {
      await anonymizeConversationConsumption(tx, company, [conversation]);
      await tx.conversations.delete({ where: { id: conversation } });
    });
    const run = await db.agent_runs.findFirstOrThrow({
      where: { company_id: company },
    });
    const voice = await db.voice_session_telemetry.findFirstOrThrow({
      where: { company_id: company },
    });
    expect(run.cost?.toString()).toBe('0.012345');
    expect(run.total_tokens).toBe(123);
    expect(run.trace).toBeNull();
    expect(run.conversation_id).toBeNull();
    expect(voice.cost_usd).toBe(0.12345);
    expect(voice.total_tokens).toBe(456);
    expect(voice.caller_number).toBeNull();
    await expect(
      db.painel_clients.delete({ where: { id: client } }),
    ).rejects.toThrow();
    await expect(
      db.companies.delete({ where: { id: company } }),
    ).rejects.toThrow();
  });
});
