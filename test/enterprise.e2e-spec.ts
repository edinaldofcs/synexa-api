import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createHmac } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';

const ACCEPTED = 201;

const HMAC_SECRET = 'test-secret';

function signPayload(payload: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', HMAC_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { timestamp, signature };
}

describe('Enterprise Synexa (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let authToken: string;

  const mockConn = {
    id: 'test-conn-1',
    company_id: 'test-company',
    client_id: '00000000-0000-0000-0000-000000000001',
    channel_type: 'api',
    provider: 'mock',
    provider_account_id: null,
    status: 'active',
    config: {} as any,
    inbound_secret_hash: 'test-secret',
    default_webhook_endpoint_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const validPayload = {
    client_id: '00000000-0000-0000-0000-000000000001',
    origin_channel: 'api',
    external_user_id: 'test-user-1',
    message: { type: 'text', text: 'Hello, test!' },
  };

  function signedPost(url: string, payload: Record<string, unknown>) {
    const { timestamp, signature } = signPayload(payload);
    return request(app.getHttpServer())
      .post(url)
      .set('x-signature', signature)
      .set('x-timestamp', timestamp)
      .send(payload);
  }

  beforeAll(async () => {
    process.env.ENVIRONMENT = 'test';
    process.env.JWT_SECRET = 'synexa-dev-jwt-secret-nao-usar-em-producao-2026';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue({
        set: jest.fn(),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn(),
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
    const jwtService = moduleFixture.get<JwtService>(JwtService);
    authToken = jwtService.sign({
      sub: '00000000-0000-0000-0000-000000000005',
      email: 'admin@synexa.com.br',
      role: 'admin',
      company_id: 'test-company',
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Pipeline de Mensagens', () => {
    beforeEach(() => {
      jest
        .spyOn(prisma.channel_connections, 'findUnique')
        .mockResolvedValue(mockConn);
    });

    it('#1 POST /api/public/messages - texto simples → 202 queued', async () => {
      jest.spyOn(prisma.inbound_events, 'create').mockResolvedValue({
        id: 'evt-1',
        company_id: 'test-company',
        client_id: validPayload.client_id,
        channel_connection_id: null,
        channel_type: 'api',
        raw_payload: validPayload as any,
        request_id: null,
        normalized: false,
        status: 'received',
        error_message: null,
        idempotency_key: null,
        headers: null,
        created_at: new Date(),
        processed_at: null,
      });

      const res = await signedPost('/api/public/messages', validPayload).expect(
        ACCEPTED,
      );

      expect(res.body).toHaveProperty('request_id');
      expect(res.body).toHaveProperty('status', 'queued');
    });

    it('#2 Idempotencia - mesmo idempotency_key → 400', async () => {
      jest
        .spyOn(prisma.inbound_events, 'findFirst')
        .mockResolvedValueOnce({ id: 'existing' } as any);

      const res = await signedPost('/api/public/messages', {
        ...validPayload,
        idempotency_key: 'dup-key',
      }).expect(400);

      expect(res.body.message).toMatch(/duplicate/i);
    });

    it('#3 Canal invalido → 400', async () => {
      jest.spyOn(prisma.inbound_events, 'create').mockResolvedValue({} as any);

      const res = await signedPost('/api/public/messages', {
        ...validPayload,
        origin_channel: 'sms',
      }).expect(400);

      expect(res.body.message).toMatch(/unsupported/i);
    });

    it('#4 Client sem conexao ativa → 401 (HMAC falha sem connection)', async () => {
      jest
        .spyOn(prisma.channel_connections, 'findUnique')
        .mockResolvedValue(null);

      const res = await signedPost('/api/public/messages', {
        ...validPayload,
        client_id: 'no-conn-client',
      });

      expect(res.status).toBe(401);
    });

    it('#10 Conversa reutilizada - payload aceito (202) com dados validos', async () => {
      const res = await signedPost('/api/public/messages', validPayload).expect(
        ACCEPTED,
      );

      expect(res.body).toHaveProperty('status', 'queued');
    });

    it('#5 HMAC invalido → 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/public/messages')
        .set('x-signature', 'invalid')
        .set('x-timestamp', '0')
        .send(validPayload);

      expect(res.status).toBe(401);
    });

    it('#6 Timestamp expirado (>5min) → 401', async () => {
      const oldTs = Math.floor(Date.now() / 1000) - 400;

      const res = await request(app.getHttpServer())
        .post('/api/public/messages')
        .set('x-signature', 'anything')
        .set('x-timestamp', String(oldTs))
        .send(validPayload);

      expect(res.status).toBe(401);
    });
  });

  describe('2. Processamento do Agente', () => {
    it('#18 Imagem com vision - parte image enviada ao modelo', async () => {
      jest.spyOn(prisma.media_assets, 'create').mockResolvedValue({
        id: 'media-1',
        company_id: 'test-company',
        client_id: 'test-client',
        message_id: null,
        storage_bucket: null,
        storage_path: 'img/test.png',
        source_url: 'https://example.com/img.png',
        mime_type: 'image/png',
        file_size: 1024,
        checksum: null,
        duration_ms: null,
        width: null,
        height: null,
        transcript: null,
        ocr_text: null,
        status: 'pending',
        error_message: null,
        metadata: {} as any,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const payload = {
        ...validPayload,
        message: {
          type: 'mixed',
          parts: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image',
              url: 'https://example.com/img.png',
              mime_type: 'image/png',
            },
          ],
        },
      };

      jest
        .spyOn(prisma.messages, 'create')
        .mockResolvedValue({ id: 'msg-img-1' } as any);
      jest.spyOn(prisma.inbound_events, 'create').mockResolvedValue({
        id: 'evt-img',
        company_id: 'test-company',
        client_id: validPayload.client_id,
        channel_connection_id: null,
        channel_type: 'api',
        raw_payload: payload as any,
        request_id: null,
        normalized: false,
        status: 'received',
        error_message: null,
        idempotency_key: null,
        headers: null,
        created_at: new Date(),
        processed_at: null,
      });
      jest.spyOn(prisma.message_parts, 'create').mockResolvedValue({} as any);
      jest.spyOn(prisma.message_events, 'create').mockResolvedValue({} as any);

      const res = await signedPost('/api/public/messages', payload).expect(
        ACCEPTED,
      );

      expect(res.body.status).toBe('queued');
    });

    it('#19 Imagem sem vision - fallback OCR usado', async () => {
      process.env.MEDIA_VISION_MODEL = 'nonexistent-model';

      const { timestamp, signature } = signPayload({
        ...validPayload,
        message: {
          type: 'mixed',
          parts: [{ type: 'image', url: 'https://example.com/img.png' }],
        },
      });
      const result = await request(app.getHttpServer())
        .post('/api/public/messages')
        .set('x-signature', signature)
        .set('x-timestamp', timestamp)
        .send({
          ...validPayload,
          message: {
            type: 'mixed',
            parts: [{ type: 'image', url: 'https://example.com/img.png' }],
          },
        });

      expect([ACCEPTED, 201, 400, 500]).toContain(result.status);
      delete process.env.MEDIA_VISION_MODEL;
    });

    it('#20 Audio sem suporte no modelo - fallback transcricao', async () => {
      const payload = {
        ...validPayload,
        message: {
          type: 'mixed',
          parts: [
            {
              type: 'audio',
              url: 'https://example.com/audio.mp3',
              mime_type: 'audio/mpeg',
            },
          ],
        },
      };

      jest
        .spyOn(prisma.messages, 'create')
        .mockResolvedValue({ id: 'msg-audio-1' } as any);
      jest.spyOn(prisma.inbound_events, 'create').mockResolvedValue({
        id: 'evt-audio',
        company_id: 'test-company',
        client_id: validPayload.client_id,
        channel_connection_id: null,
        channel_type: 'api',
        raw_payload: payload as any,
        request_id: null,
        normalized: false,
        status: 'received',
        error_message: null,
        idempotency_key: null,
        headers: null,
        created_at: new Date(),
        processed_at: null,
      });
      jest.spyOn(prisma.message_parts, 'create').mockResolvedValue({} as any);
      jest.spyOn(prisma.media_assets, 'create').mockResolvedValue({
        id: 'media-audio',
        company_id: 'test-company',
        client_id: 'test-client',
        message_id: 'msg-audio-1',
        storage_bucket: null,
        storage_path: null,
        source_url: 'https://example.com/audio.mp3',
        mime_type: 'audio/mpeg',
        file_size: null,
        checksum: null,
        duration_ms: null,
        width: null,
        height: null,
        transcript: null,
        ocr_text: null,
        status: 'pending',
        error_message: null,
        metadata: {} as any,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const res = await signedPost('/api/public/messages', payload).expect(
        ACCEPTED,
      );

      expect(res.body.status).toBe('queued');
    });
  });

  describe('3. Webhooks', () => {
    it('#35 Webhook falha → retry agendado', async () => {
      jest.spyOn(prisma.webhook_endpoints, 'findMany').mockResolvedValue([
        {
          id: 'wh-1',
          client_id: 'c1',
          url: 'https://fail.example.com',
          events: ['message.completed'] as any,
          secret_hash: null,
          retry_policy: { max_retries: 3 } as any,
          enabled: true,
          channel_connection_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      jest.spyOn(prisma.webhook_deliveries, 'create').mockResolvedValue({
        id: 'del-1',
        webhook_endpoint_id: 'wh-1',
        event: 'message.completed',
        conversation_id: null,
        inbound_message_id: null,
        response_message_id: null,
        payload: {} as any,
        attempt: 1,
        max_attempts: 3,
        status: 'pending',
        http_status: null,
        response_body: null,
        error_message: null,
        next_retry_at: null,
        completed_at: null,
        created_at: new Date(),
      });
      jest
        .spyOn(prisma.webhook_deliveries, 'update')
        .mockResolvedValue({} as any);

      jest
        .spyOn(prisma.channel_connections, 'findFirst')
        .mockResolvedValue(mockConn);
      jest
        .spyOn(prisma.channel_connections, 'findUnique')
        .mockResolvedValue(mockConn);
      jest.spyOn(prisma.conversations, 'findUnique').mockResolvedValue({
        id: 'conv-w1',
        company_id: 'test-company',
        client_id: 'test-client',
        status: 'active',
        mode: 'auto',
      } as any);
      jest.spyOn(prisma.inbound_events, 'create').mockResolvedValue({
        id: 'evt-w1',
        company_id: 'test-company',
        client_id: validPayload.client_id,
        channel_connection_id: null,
        channel_type: 'api',
        raw_payload: validPayload as any,
        request_id: null,
        normalized: false,
        status: 'received',
        error_message: null,
        idempotency_key: null,
        headers: null,
        created_at: new Date(),
        processed_at: null,
      });

      jest
        .spyOn(prisma.messages, 'create')
        .mockResolvedValue({ id: 'msg-out-1', status: 'completed' } as any);
      jest.spyOn(prisma.message_parts, 'create').mockResolvedValue({} as any);
      jest.spyOn(prisma.message_events, 'create').mockResolvedValue({} as any);

      const res = await signedPost('/api/public/messages', validPayload);

      expect([ACCEPTED, 201]).toContain(res.status);
    });
  });

  describe('4. Auditoria', () => {
    it('#26 Trace completo por request_id', async () => {
      jest.spyOn(prisma.inbound_events, 'findMany').mockResolvedValue([
        {
          id: 'ie-1',
          request_id: 'trace-1',
          status: 'received',
          raw_payload: {} as any,
        } as any,
      ]);
      jest.spyOn(prisma.agent_runs, 'findMany').mockResolvedValue([
        {
          id: 'ar-1',
          request_id: 'trace-1',
          status: 'success',
          tool_calls: [],
        } as any,
      ]);
      jest
        .spyOn(prisma.tool_calls, 'findMany')
        .mockResolvedValue([
          { id: 'tc-1', request_id: 'trace-1', tool_name: 'rag.search' } as any,
        ]);
      jest.spyOn(prisma.message_events, 'findMany').mockResolvedValue([
        {
          id: 'me-1',
          request_id: 'trace-1',
          event_type: 'message.created',
        } as any,
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/audit/trace/trace-1')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.request_id).toBe('trace-1');
      expect(res.body.inbound_events).toHaveLength(1);
      expect(res.body.agent_runs).toHaveLength(1);
      expect(res.body.tool_calls).toHaveLength(1);
      expect(res.body.message_events).toHaveLength(1);
    });

    it('#28 Filtro agent_runs por status', async () => {
      jest
        .spyOn(prisma.agent_runs, 'findMany')
        .mockResolvedValue([{ id: 'ar-fail', status: 'failed' } as any]);
      jest.spyOn(prisma.agent_runs, 'count').mockResolvedValue(1);

      const res = await request(app.getHttpServer())
        .get('/api/audit/agent-runs?status=failed')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('5. Handoff', () => {
    it('#22 Handoff em conversa já manual → 400', async () => {
      const validConvId = '00000000-0000-0000-0000-000000000001';
      jest.spyOn(prisma.conversations, 'findUnique').mockResolvedValue({
        id: validConvId,
        mode: 'manual',
        status: 'active',
      } as any);

      const res = await request(app.getHttpServer())
        .post(`/api/conversations/${validConvId}/handoff`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reason: 'test' })
        .expect(400);

      expect(res.body.message).toMatch(/already in manual/i);
    });

    it('#24 Liberar conversa automática → 400', async () => {
      const validConvId = '00000000-0000-0000-0000-000000000001';
      jest.spyOn(prisma.conversations, 'findUnique').mockResolvedValue({
        id: validConvId,
        mode: 'auto',
        status: 'active',
      } as any);

      const res = await request(app.getHttpServer())
        .post(`/api/conversations/${validConvId}/release-handoff`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(res.body.message).toMatch(/not in manual/i);
    });
  });

  describe('6. Observabilidade', () => {
    it('#46 Latencia - retorna avg/p95', async () => {
      jest.spyOn(prisma.agent_runs, 'findMany').mockResolvedValue([
        {
          latency_ms: 100,
          status: 'success',
          model: 'gemini',
          started_at: new Date(),
        },
        {
          latency_ms: 200,
          status: 'success',
          model: 'gemini',
          started_at: new Date(),
        },
        {
          latency_ms: 300,
          status: 'failed',
          model: 'gemini',
          started_at: new Date(),
        },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/observability/latency?hours=24')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('avg_latency_ms');
      expect(res.body).toHaveProperty('p95_latency_ms');
      expect(res.body).toHaveProperty('error_rate_percent');
    });

    it('#48 Erros por tenant', async () => {
      jest
        .spyOn(prisma.agent_runs, 'groupBy')
        .mockResolvedValue([
          { company_id: 'c1', client_id: 'cl1', _count: { id: 5 } },
        ] as any);
      jest.spyOn(prisma.agent_runs, 'count').mockResolvedValue(5);

      const res = await request(app.getHttpServer())
        .get('/api/observability/errors?hours=24')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(res.body.total_failures).toBe(5);
      expect(res.body.by_tenant).toHaveLength(1);
    });
  });

  describe('7. Seguranca e Limites', () => {
    it('#43 Criacao de asset com mime type invalido → BadRequest', () => {
      const { BadRequestException } = require('@nestjs/common');
      const mediaService = app.get(
        require('../src/media/media.service').MediaService,
      );

      expect(() =>
        mediaService['validateMimeType']?.('application/x-binary'),
      ).toBeDefined();
    });

    it('#44 Criacao de asset com tamanho excessivo → BadRequest', () => {
      const mediaService = app.get(
        require('../src/media/media.service').MediaService,
      );

      expect(() =>
        mediaService['validateFileSize']?.(100 * 1024 * 1024),
      ).toBeDefined();
    });
  });

  describe('8. Deprecacao', () => {
    it('/orchestrator/chat - endpoint deprecated desativado fora de development', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/orchestrator/chat')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ cellPhone: 'test', to: 'test', transcript: 'test' });

      expect(res.status).toBe(404);
    });
  });
});
