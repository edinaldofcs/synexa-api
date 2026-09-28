import {
  applyTenantInjection,
  TENANT_SUPPORTED_MODELS,
  TENANT_RELATION_PATHS,
  PrismaService,
} from './prisma.service';
import { tenantLocalStorage } from '../auth/tenant-context';
import { randomUUID } from 'crypto';
import { KnowledgeService } from '../../knowledge/knowledge.service';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';

describe('applyTenantInjection', () => {
  it('covers every model that has company_id in schema.prisma (except companies)', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    const modelsWithCompanyId: string[] = [];
    let current: string | null = null;
    for (const line of schema.split('\n')) {
      if (current && /^\}/.test(line)) {
        current = null;
        continue;
      }
      if (current && line.includes('company_id')) {
        modelsWithCompanyId.push(current);
        continue;
      }
      const m = line.match(/^model (\w+) \{/);
      if (m) current = m[1];
    }

    const missing = modelsWithCompanyId.filter(
      (m) => !TENANT_SUPPORTED_MODELS.includes(m),
    );
    // Todos os modelos com coluna company_id devem estar cobertos pelo escopo de tenant
    expect(modelsWithCompanyId.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('injects company_id into where for previously unscoped models (regression)', () => {
    for (const model of [
      'credential_audit_logs',
      'provider_credentials',
      'voice_session_telemetry',
      'telephony_endpoints',
    ]) {
      const args: any = { where: { status: 'active' } };
      applyTenantInjection(model, 'findMany', args, COMPANY_ID);
      expect(args.where.company_id).toBe(COMPANY_ID);
    }
  });

  it('overrides where.company_id coming from caller (defense in depth)', () => {
    const args: any = { where: { company_id: 'other-company' } };
    applyTenantInjection('provider_credentials', 'findMany', args, COMPANY_ID);
    expect(args.where.company_id).toBe(COMPANY_ID);
  });

  it('injects company_id into create data for scoped models', () => {
    const args: any = { data: { provider: 'gemini' } };
    applyTenantInjection('provider_credentials', 'create', args, COMPANY_ID);
    expect(args.data.company_id).toBe(COMPANY_ID);
  });

  it('injects company_id into each item of createMany', () => {
    const args: any = { data: [{ a: 1 }, { b: 2 }] };
    applyTenantInjection(
      'credential_audit_logs',
      'createMany',
      args,
      COMPANY_ID,
    );
    expect(args.data).toEqual([
      { a: 1, company_id: COMPANY_ID },
      { b: 2, company_id: COMPANY_ID },
    ]);
  });

  it('does nothing without tenant context (worker/voice/queue)', () => {
    const args: any = { where: { id: 'x' } };
    const result = applyTenantInjection(
      'telephony_endpoints',
      'findUnique',
      args,
      undefined,
    );
    expect(result.where).toEqual({ id: 'x' });
  });

  it('scopes subordinate models through their parent without a company_id column', () => {
    const args: any = { where: { id: 'x' } };
    applyTenantInjection('painel_agents', 'findMany', args, COMPANY_ID);
    expect(args.where.company_id).toBeUndefined();
    expect(args.where.AND).toEqual([
      { painel_clients: { company_id: COMPANY_ID } },
    ]);
  });

  it.each(Object.entries(TENANT_RELATION_PATHS))(
    'scopes reads and mutations of %s without overwriting filters',
    (model, path) => {
      for (const operation of [
        'findUnique',
        'findMany',
        'count',
        'update',
        'updateMany',
        'delete',
        'deleteMany',
        'upsert',
      ]) {
        const existing = { is_active: true };
        const args: any = {
          where: {
            id: 'foreign-id',
            AND: existing,
            OR: [{ client_id: 'foreign-client' }],
          },
        };
        applyTenantInjection(model, operation, args, COMPANY_ID);
        expect(args.where.id).toBe('foreign-id');
        expect(args.where.OR).toEqual([{ client_id: 'foreign-client' }]);
        const scope = path.reduceRight(
          (value, relation) => ({ [relation]: value }),
          { company_id: COMPANY_ID } as any,
        );
        expect(args.where.AND).toEqual([existing, scope]);
      }
    },
  );

  it('forces tenant on findUnique by id (blocks cross-tenant by-id access)', () => {
    const args: any = { where: { id: 'target-id' } };
    applyTenantInjection('telephony_endpoints', 'delete', args, COMPANY_ID);
    expect(args.where).toEqual({
      id: 'target-id',
      company_id: COMPANY_ID,
    });
  });

  it('bypasses tenant injection for platform_admin', () => {
    const args: any = { where: { status: 'active' } };
    applyTenantInjection(
      'painel_clients',
      'findMany',
      args,
      COMPANY_ID,
      'platform_admin',
    );
    expect(args.where.company_id).toBeUndefined();
    expect(args.where.status).toBe('active');
  });
});

const tenantTestUrl = process.env.TENANT_ISOLATION_TEST_DATABASE_URL;
(tenantTestUrl ? describe : describe.skip)(
  'tenant isolation on disposable PostgreSQL',
  () => {
    let prisma: PrismaService;
    let previousUrl: string | undefined;
    const companyA = randomUUID(),
      companyB = randomUUID();
    const clientA = randomUUID(),
      clientB = randomUUID();
    const agentA = randomUUID(),
      agentB = randomUUID();

    beforeAll(async () => {
      const url = new URL(tenantTestUrl!);
      if (
        url.hostname !== '127.0.0.1' ||
        url.pathname !== '/tenant_isolation_test'
      ) {
        throw new Error(
          'Requires the disposable loopback tenant_isolation_test database',
        );
      }
      previousUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = tenantTestUrl;
      prisma = new PrismaService();
      await prisma.$connect();
      await prisma.companies.createMany({
        data: [
          { id: companyA, name: 'A' },
          { id: companyB, name: 'B' },
        ],
      });
      await prisma.painel_clients.createMany({
        data: [
          {
            id: clientA,
            company_id: companyA,
            company_name: 'A',
            agent_name: 'A',
          },
          {
            id: clientB,
            company_id: companyB,
            company_name: 'B',
            agent_name: 'B',
          },
        ],
      });
      await prisma.painel_agents.createMany({
        data: [
          { id: agentA, client_id: clientA, service_step: 'A' },
          { id: agentB, client_id: clientB, service_step: 'B' },
        ],
      });
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.companies.deleteMany({
          where: { id: { in: [companyA, companyB] } },
        });
        await prisma.$disconnect();
      }
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    });

    it('blocks foreign IDs, OR filters, writes and deletes while allowing own records', async () => {
      await tenantLocalStorage.run(
        { companyId: companyA, role: 'company_admin' },
        async () => {
          expect(
            await prisma.painel_agents.findUnique({ where: { id: agentB } }),
          ).toBeNull();
          expect(
            await prisma.painel_agents.findMany({
              where: { OR: [{ id: agentA }, { id: agentB }] },
            }),
          ).toEqual([expect.objectContaining({ id: agentA })]);
          await expect(
            prisma.painel_agents.update({
              where: { id: agentB },
              data: { service_step: 'changed' },
            }),
          ).rejects.toMatchObject({ code: 'P2025' });
          await expect(
            prisma.painel_agents.delete({ where: { id: agentB } }),
          ).rejects.toMatchObject({ code: 'P2025' });
          expect(
            await prisma.painel_agents.updateMany({
              data: { service_step: 'own changed' },
            }),
          ).toEqual({ count: 1 });
          await prisma.$transaction(async (tx) => {
            expect(
              await tx.painel_agents.findUnique({ where: { id: agentB } }),
            ).toBeNull();
          });
        },
      );
      expect(
        (
          await prisma.painel_agents.findUniqueOrThrow({
            where: { id: agentB },
          })
        ).service_step,
      ).toBe('B');
    });

    it('does not expose a foreign document through an inconsistent knowledge relationship', async () => {
      const baseA = randomUUID(),
        baseB = randomUUID();
      const docA = randomUUID(),
        docB = randomUUID();
      const chunkA = randomUUID(),
        corruptChunk = randomUUID();
      await prisma.knowledge_bases.createMany({
        data: [
          { id: baseA, client_id: clientA, company_id: companyA, name: 'A' },
          { id: baseB, client_id: clientB, company_id: companyB, name: 'B' },
        ],
      });
      await prisma.knowledge_documents.createMany({
        data: [
          {
            id: docA,
            knowledge_base_id: baseA,
            client_id: clientA,
            company_id: companyA,
            title: 'Allowed',
          },
          {
            id: docB,
            knowledge_base_id: baseB,
            client_id: clientB,
            company_id: companyB,
            title: 'Private B',
          },
        ],
      });
      await prisma.knowledge_chunks.createMany({
        data: [
          {
            id: chunkA,
            knowledge_base_id: baseA,
            document_id: docA,
            client_id: clientA,
            company_id: companyA,
            content: 'Own content',
            chunk_index: 0,
          },
          {
            id: corruptChunk,
            knowledge_base_id: baseA,
            document_id: docB,
            client_id: clientA,
            company_id: companyA,
            content: 'Foreign link',
            chunk_index: 1,
          },
        ],
      });
      const embedding = Array.from({ length: 1536 }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      for (const chunk of [chunkA, corruptChunk]) {
        await prisma.$executeRaw`INSERT INTO knowledge_embeddings
          (id, company_id, client_id, knowledge_base_id, chunk_id, provider, model, dimensions, embedding)
          VALUES (${randomUUID()}::uuid, ${companyA}::uuid, ${clientA}::uuid, ${baseA}::uuid, ${chunk}::uuid,
            'test', 'test', 1536, ${JSON.stringify(embedding)}::vector)`;
      }
      const knowledge = new KnowledgeService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      jest
        .spyOn(knowledge as any, 'createEmbedding')
        .mockResolvedValue(embedding);
      await tenantLocalStorage.run(
        { companyId: companyA, userId: 'tester', role: 'company_admin' },
        async () => {
          const results = await knowledge.search(
            baseA,
            { query: 'text', limit: 5 },
            'tester',
          );
          expect(results).toEqual([
            expect.objectContaining({ id: chunkA, document_title: 'Allowed' }),
          ]);
          await expect(
            knowledge.search(baseB, { query: 'text' }, 'tester'),
          ).rejects.toThrow('Knowledge base not found');
        },
      );
    });

    it('does not update another tenant metadata through Prisma', async () => {
      await prisma.painel_clients.update({
        where: { id: clientB },
        data: { metadata: { sentinel: 'private' } },
      });
      await tenantLocalStorage.run(
        { companyId: companyA, role: 'company_admin' },
        async () => {
          await prisma.painel_clients.updateMany({
            where: { id: clientB },
            data: { metadata: { changed: true } },
          });
          await prisma.painel_clients.updateMany({
            where: { id: clientA },
            data: { metadata: { configured: true } },
          });
        },
      );
      expect(
        (
          await prisma.painel_clients.findUniqueOrThrow({
            where: { id: clientB },
          })
        ).metadata,
      ).toEqual({ sentinel: 'private' });
      expect(
        (
          await prisma.painel_clients.findUniqueOrThrow({
            where: { id: clientA },
          })
        ).metadata,
      ).toEqual(expect.objectContaining({ configured: true }));
    });

    it('preserves authorized platform administration and scopes impersonation', async () => {
      await tenantLocalStorage.run(
        { companyId: companyA, role: 'platform_admin' },
        async () => {
          expect(
            await prisma.painel_agents.count({
              where: { id: { in: [agentA, agentB] } },
            }),
          ).toBe(2);
        },
      );
      await tenantLocalStorage.run(
        { companyId: companyB, role: 'company_admin' },
        async () => {
          expect(
            await prisma.painel_agents.findUnique({ where: { id: agentA } }),
          ).toBeNull();
          expect(
            await prisma.painel_agents.findUnique({ where: { id: agentB } }),
          ).not.toBeNull();
        },
      );
    });
  },
);
