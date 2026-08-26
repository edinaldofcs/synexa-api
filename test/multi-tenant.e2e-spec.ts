import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const CLIENT_A = '55555555-5555-4555-8555-555555555555';
const CLIENT_B = '66666666-6666-4666-8666-666666666666';
const CONVERSATION_A = '77777777-7777-4777-8777-777777777777';
const CHANNEL_A = '88888888-8888-4888-8888-888888888888';

const PASSWORD = 'TenantTest2026!';

describe('Multi-tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: any;

  const loginAgent = async (
    email: string,
  ): Promise<{ agent: any; csrf: string }> => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    const rawCookies = (res.headers['set-cookie'] ?? []) as unknown;
    const cookieList = Array.isArray(rawCookies)
      ? (rawCookies as string[])
      : [String(rawCookies)];
    const csrfCookie = cookieList.find((c) => c.startsWith('synexa_csrf='));
    expect(csrfCookie).toBeDefined();
    const csrf = decodeURIComponent(
      csrfCookie!.split(';')[0].replace('synexa_csrf=', ''),
    );
    return { agent, csrf };
  };

  beforeAll(async () => {
    process.env.ENVIRONMENT = 'development';
    process.env.JWT_SECRET = 'synexa-dev-jwt-secret-nao-usar-em-producao-2026';

    const sessionStore = new Map<string, unknown>();
    const resetStore = new Map<string, unknown>();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue({
        set: jest.fn((key: string, value: unknown, _ttl?: number) =>
          key.startsWith('auth:reset:')
            ? resetStore.set(key, value)
            : sessionStore.set(key, value),
        ),
        get: jest.fn((key: string) =>
          key.startsWith('auth:reset:')
            ? (resetStore.get(key) ?? null)
            : (sessionStore.get(key) ?? null),
        ),
        del: jest.fn((key: string) => {
          sessionStore.delete(key);
          resetStore.delete(key);
        }),
        addToSet: jest.fn(),
        removeFromSet: jest.fn(),
        getSetMembers: jest.fn().mockResolvedValue([]),
        expire: jest.fn(),
        acquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn(),
        checkRateLimit: jest.fn().mockResolvedValue({
          allowed: true,
          remaining: 99,
          resetAt: new Date(),
        }),
        rpush: jest.fn(),
        lrange: jest.fn().mockResolvedValue([]),
        quit: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();

    // Tenants
    for (const [id, name] of [
      [COMPANY_A, 'Tenant A'],
      [COMPANY_B, 'Tenant B'],
    ] as const) {
      await prisma.companies.upsert({
        where: { id },
        update: {},
        create: { id, name },
      });
    }

    // Users
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, companyId, email] of [
      [USER_A, COMPANY_A, 'tenant-a@isolation.test'],
      [USER_B, COMPANY_B, 'tenant-b@isolation.test'],
    ] as const) {
      await prisma.users.upsert({
        where: { email },
        update: { password_hash: passwordHash },
        create: {
          id,
          company_id: companyId,
          email,
          name: `User ${companyId.slice(0, 2)}`,
          role: 'admin',
          password_hash: passwordHash,
        },
      });
    }

    // Clients
    for (const [id, companyId, companyName] of [
      [CLIENT_A, COMPANY_A, 'Client A'],
      [CLIENT_B, COMPANY_B, 'Client B'],
    ] as const) {
      await prisma.painel_clients.upsert({
        where: { id },
        update: {},
        create: { id, company_id: companyId, company_name: companyName },
      });
    }

    // Resources of tenant A (targets of the cross-tenant attempts)
    await prisma.conversations.upsert({
      where: { id: CONVERSATION_A },
      update: {},
      create: {
        id: CONVERSATION_A,
        company_id: COMPANY_A,
        client_id: CLIENT_A,
        origin_channel: 'api',
        status: 'active',
      },
    });

    await prisma.channel_connections.upsert({
      where: { id: CHANNEL_A },
      update: {},
      create: {
        id: CHANNEL_A,
        company_id: COMPANY_A,
        client_id: CLIENT_A,
        channel_type: 'api',
        provider: 'mock',
        status: 'active',
      },
    });
  });

  afterAll(async () => {
    await prisma.channel_connections
      .deleteMany({ where: { id: CHANNEL_A } })
      .catch(() => {});
    await prisma.messages
      .deleteMany({ where: { conversation_id: CONVERSATION_A } })
      .catch(() => {});
    await prisma.conversations
      .deleteMany({ where: { id: CONVERSATION_A } })
      .catch(() => {});
    await prisma.painel_clients
      .deleteMany({ where: { id: { in: [CLIENT_A, CLIENT_B] } } })
      .catch(() => {});
    await prisma.users
      .deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
      .catch(() => {});
    await prisma.companies
      .deleteMany({ where: { id: { in: [COMPANY_A, COMPANY_B] } } })
      .catch(() => {});
    await app.close();
  });

  describe('tenant B tentando acessar recursos do tenant A', () => {
    let agentB: any;
    let csrfB: string;

    beforeAll(async () => {
      const login = await loginAgent('tenant-b@isolation.test');
      agentB = login.agent;
      csrfB = login.csrf;
    });

    it('nao le conversa de outro tenant (404)', async () => {
      const res = await agentB.get(`/api/conversations/${CONVERSATION_A}`);
      expect(res.status).toBe(404);
    });

    it('nao le mensagens de outro tenant (404)', async () => {
      const res = await agentB.get(
        `/api/conversations/${CONVERSATION_A}/messages`,
      );
      expect(res.status).toBe(404);
    });

    it('nao injeta mensagem em conversa de outro tenant (404)', async () => {
      const res = await agentB
        .post(`/api/conversations/${CONVERSATION_A}/messages`)
        .set('X-CSRF-Token', csrfB)
        .send({ content: 'cross-tenant injection' });
      expect(res.status).toBe(404);
    });

    it('nao altera conversa de outro tenant (404)', async () => {
      const res = await agentB
        .patch(`/api/conversations/${CONVERSATION_A}`)
        .set('X-CSRF-Token', csrfB)
        .send({ status: 'closed' });
      expect(res.status).toBe(404);
    });

    it('nao solicita handoff em conversa de outro tenant (404)', async () => {
      const res = await agentB
        .post(`/api/conversations/${CONVERSATION_A}/handoff`)
        .set('X-CSRF-Token', csrfB)
        .send({ reason: 'test' });
      expect(res.status).toBe(404);
    });

    it('nao le canal de outro tenant (404)', async () => {
      const res = await agentB.get(`/api/channels/${CHANNEL_A}`);
      expect(res.status).toBe(404);
    });

    it('nao altera cliente de outro tenant', async () => {
      const res = await agentB
        .patch(`/api/clients/${CLIENT_A}`)
        .send({ company_name: 'hacked' });
      expect([403, 404]).toContain(res.status);
    });

    it('nao ve canal nem cliente A na listagem', async () => {
      const channels = await agentB.get('/api/channels');
      expect(channels.status).toBe(200);
      const ids = (channels.body as any[]).map((c) => c.id);
      expect(ids).not.toContain(CHANNEL_A);

      const clients = await agentB.get('/api/clients');
      expect(clients.status).toBe(200);
      const clientIds = (
        Array.isArray(clients.body) ? clients.body : (clients.body.data ?? [])
      ).map((c: any) => c.id);
      expect(clientIds).not.toContain(CLIENT_A);
    });
  });

  describe('acesso legitimo dentro do proprio tenant', () => {
    it('tenant A acessa os proprios recursos', async () => {
      const { agent: agentA, csrf } = await loginAgent(
        'tenant-a@isolation.test',
      );

      const conv = await agentA.get(`/api/conversations/${CONVERSATION_A}`);
      expect(conv.status).toBe(200);

      const messages = await agentA
        .post(`/api/conversations/${CONVERSATION_A}/messages`)
        .set('X-CSRF-Token', csrf)
        .send({ content: 'mensagem legitima' });
      expect(messages.status).toBe(201);

      const channel = await agentA.get(`/api/channels/${CHANNEL_A}`);
      expect(channel.status).toBe(200);
      expect(channel.body.company_id).toBe(COMPANY_A);
    });
  });
});
