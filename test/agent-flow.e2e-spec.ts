import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';

describe('Agent Flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.ENVIRONMENT = 'development';
    process.env.JWT_SECRET = 'synexa-dev-jwt-secret-nao-usar-em-producao-2026';
    const sessionStore = new Map<string, unknown>();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue({
        set: jest.fn((key: string, value: unknown) =>
          sessionStore.set(key, value),
        ),
        get: jest.fn((key: string) => sessionStore.get(key) ?? null),
        del: jest.fn((key: string) => sessionStore.delete(key)),
        addToSet: jest.fn(),
        getSetMembers: jest.fn().mockResolvedValue([]),
        removeFromSet: jest.fn(),
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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Seed verification - agents with transitions', () => {
    it('deve ter agentes com transitions preenchidas', async () => {
      const agents = await prisma.painel_agents.findMany({
        where: { is_active: true },
        orderBy: { execution_order: 'asc' },
      });

      expect(agents.length).toBeGreaterThanOrEqual(4);

      const reception = agents.find((a) => a.service_step === 'reception');
      expect(reception).toBeDefined();
      expect(reception!.transitions).toBeDefined();

      const transitionObj = reception!.transitions as {
        type: string;
        rules: Array<{ target: string; keywords: string[] }>;
      };
      expect(transitionObj.type).toBe('keyword');
      expect(Array.isArray(transitionObj.rules)).toBe(true);
      expect(transitionObj.rules.length).toBeGreaterThanOrEqual(2);

      const supportTransition = transitionObj.rules.find(
        (r) => r.target === 'suporte_tecnico',
      );
      expect(supportTransition).toBeDefined();
      expect(supportTransition!.keywords).toContain('suporte');
    });

    it('deve ter agentes em ordem de execucao crescente', async () => {
      const agents = await prisma.painel_agents.findMany({
        where: { is_active: true },
        orderBy: { execution_order: 'asc' },
      });

      for (let i = 1; i < agents.length; i++) {
        expect(agents[i].execution_order).toBeGreaterThanOrEqual(
          agents[i - 1].execution_order!,
        );
      }
    });

    it('deve ter client_id consistente entre agentes', async () => {
      const agents = await prisma.painel_agents.findMany({
        where: { is_active: true },
      });

      const clientIds = agents.map((a) => a.client_id);
      const uniqueIds = new Set(clientIds);
      expect(uniqueIds.size).toBe(1);
    });
  });

  describe('2. Agent chaining - transition rules', () => {
    it('deve existir rota reception → suporte_tecnico', async () => {
      const reception = await prisma.painel_agents.findFirst({
        where: { service_step: 'reception' },
      });

      const transitionObj = reception!.transitions as {
        rules: Array<{ target: string; keywords: string[] }>;
      };
      const route = transitionObj.rules.find(
        (r) => r.target === 'suporte_tecnico',
      );
      expect(route).toBeDefined();
      expect(route!.keywords.length).toBeGreaterThanOrEqual(3);
    });

    it('deve existir rota suporte_tecnico → financeiro', async () => {
      const support = await prisma.painel_agents.findFirst({
        where: { service_step: 'suporte_tecnico' },
      });

      const transitionObj = support!.transitions as {
        rules: Array<{ target: string; keywords: string[] }>;
      };
      const route = transitionObj.rules.find((r) => r.target === 'financeiro');
      expect(route).toBeDefined();
      expect(route!.keywords.length).toBeGreaterThanOrEqual(1);
    });

    it('deve existir rota suporte_tecnico → humano', async () => {
      const support = await prisma.painel_agents.findFirst({
        where: { service_step: 'suporte_tecnico' },
      });

      const transitionObj = support!.transitions as {
        rules: Array<{ target: string; keywords: string[] }>;
      };
      const route = transitionObj.rules.find((r) => r.target === 'humano');
      expect(route).toBeDefined();
    });
  });

  describe('3. Auth + API access with seeded data', () => {
    it('deve logar com admin local e acessar client endpoints', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'admin@synexa.com.br', password: 'SynexaAdmin2026!' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.email).toBe('admin@synexa.com.br');
      expect(res.body.user.role).toBe('platform_admin');
      expect(res.headers['set-cookie']).toEqual(
        expect.arrayContaining([
          expect.stringContaining('synexa_session='),
          expect.stringContaining('synexa_csrf='),
        ]),
      );
    });

    it('deve rejeitar credenciais invalidas no login local', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'admin@synexa.com.br', password: 'wrong-password' });

      expect(res.status).toBe(401);
    });

    it('deve listar apis do cliente com is_active consistente', async () => {
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent
        .post('/api/auth/login')
        .send({ email: 'admin@synexa.com.br', password: 'SynexaAdmin2026!' });

      const agents = await prisma.painel_agents.findFirst({
        where: { is_active: true },
      });
      const apisRes = await agent.get(`/api/clients/${agents!.client_id}/apis`);

      expect(apisRes.status).toBe(200);
      expect(Array.isArray(apisRes.body)).toBe(true);
      expect(apisRes.body.length).toBeGreaterThanOrEqual(3);

      for (const api of apisRes.body) {
        expect(api.is_active).toBeDefined();
        expect(api.visible_to_agent).toBeDefined();
      }
    });

    it('deve carregar o usuário atual pela sessão HttpOnly', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/auth/login')
        .send({ email: 'admin@synexa.com.br', password: 'SynexaAdmin2026!' });

      const me = await agent.get('/api/auth/me');

      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('admin@synexa.com.br');
      expect(me.body).not.toHaveProperty('access_token');
    });

    it('deve rejeitar mutação autenticada sem CSRF', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/auth/login')
        .send({ email: 'admin@synexa.com.br', password: 'SynexaAdmin2026!' });

      const response = await agent.post('/api/clients').send({});

      expect(response.status).toBe(403);
    });
  });
});
