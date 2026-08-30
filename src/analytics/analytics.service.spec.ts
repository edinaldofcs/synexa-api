import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  const mockPrisma = {
    $queryRaw: jest.fn(),
    painel_clients: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    painel_interactions: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    agent_runs: {
      findMany: jest.fn(),
    },
    business_events: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const biRowBase = {
    day: null,
    hour: null,
    month: null,
    channel: null,
    agent: null,
    total: 0,
    human_answers: 0,
    cpc: 0,
    cpca: 0,
    agreements: 0,
    promises: 0,
    agreement_value: 0,
    promise_value: 0,
    debt_value: 0,
    total_duration: 0,
    barge_ins: 0,
    total_tokens: 0,
    cost_usd: 0,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBiDashboard', () => {
    it('should aggregate BI metrics from a single consolidated query', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          ...biRowBase,
          kind: 'kpi',
          total: 1,
          human_answers: 1,
          cpc: 1,
          cpca: 1,
          agreements: 1,
          promises: 0,
          agreement_value: 450,
          debt_value: 500,
          total_duration: 120,
          barge_ins: 1,
          total_tokens: 3000,
          cost_usd: 0.05,
        },
        {
          ...biRowBase,
          kind: 'day',
          day: '2026-08-26',
          total: 1,
          human_answers: 1,
          cpc: 1,
          cpca: 1,
          agreements: 1,
          promises: 0,
          agreement_value: 450,
        },
        { ...biRowBase, kind: 'month', month: '2026-08', total: 1, cpc: 1, agreements: 1, agreement_value: 450 },
        { ...biRowBase, kind: 'channel', channel: 'webchat', total: 1, agreements: 1 },
        { ...biRowBase, kind: 'agent', agent: 'Negociador', total: 1, agreements: 1 },
      ]);

      const result = await service.getBiDashboard('company-1', {
        clientId: 'client-1',
      });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.kpis.total_interactions).toBe(1);
      expect(result.kpis.human_answers).toBe(1);
      expect(result.kpis.cpc).toBe(1);
      expect(result.kpis.cpca).toBe(1);
      expect(result.kpis.agreements).toBe(1);
      expect(result.kpis.total_agreement_value).toBe(450);
      expect(result.kpis.cpc_rate_pct).toBe(100);
      expect(result.kpis.cpca_rate_pct).toBe(100);
      expect(result.kpis.agreement_conversion_pct).toBe(100);
      expect(result.funnel).toHaveLength(6);
      expect(result.by_hour).toHaveLength(24);
      expect(result.by_hour.every((h) => h.total === 0)).toBe(true);
      expect(result.by_day).toHaveLength(1);
      expect(result.by_day[0].date).toBe('2026-08-26');
      expect(result.by_agent).toHaveLength(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'bi:dashboard:company-1:client-1:none:none',
        result,
        45,
      );
    });

    it('should return zeroed rates when there are no interactions', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { ...biRowBase, kind: 'kpi' },
      ]);

      const result = await service.getBiDashboard('company-1');

      expect(result.kpis.total_interactions).toBe(0);
      expect(result.kpis.cpc_rate_pct).toBe(0);
      expect(result.kpis.cpca_rate_pct).toBe(0);
      expect(result.kpis.agreement_conversion_pct).toBe(0);
      expect(result.kpis.avg_duration_sec).toBe(0);
      expect(result.funnel.every((s) => s.count === 0)).toBe(true);
      expect(result.by_hour).toHaveLength(24);
      expect(result.by_day).toHaveLength(0);
    });

    it('should serve the dashboard from the Redis cache without querying', async () => {
      const cached = { kpis: { total_interactions: 42 }, funnel: [] };
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getBiDashboard('company-1', {
        clientId: 'client-1',
      });

      expect(result).toBe(cached);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('getInteractionsReport', () => {
    it('should return paginated interactions report with light derived fields', async () => {
      mockPrisma.painel_interactions.findMany.mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-00000000000a',
          session_id: 'sess-1',
          client_identifier: '12345678900',
          context_variables: { protocolo: 'P-1' },
        },
      ]);
      mockPrisma.painel_interactions.count.mockResolvedValue(1);
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-00000000000a',
          messages_count: 5,
          first_user_message: 'Olá',
          last_user_message: 'Tchau',
          last_assistant_message: 'Até logo',
        },
      ]);

      const result = await service.getInteractionsReport('company-1', {
        page: 1,
        limit: 10,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].messages_count).toBe(5);
      expect(result.items[0].last_user_message).toBe('Tchau');
      expect(result.items[0].executed_tools).toBeUndefined();
      expect(result.items[0].full_transcript).toBeUndefined();
      expect((result.items[0] as any).messages).toBeUndefined();
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
    });
  });

  describe('getInteractionDetail', () => {
    it('should return the full interaction with heavy derived fields', async () => {
      const full = {
        id: '00000000-0000-0000-0000-00000000000a',
        company_id: 'company-1',
        messages: [{ role: 'user', content: 'Olá' }],
        client_identifier: '12345678900',
        context_variables: { protocolo: 'P-1' },
      };
      mockPrisma.painel_interactions.findFirst.mockResolvedValue(full);
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-00000000000a',
          messages_count: 5,
          first_user_message: 'Olá',
          last_user_message: 'Tchau',
          last_assistant_message: 'Até logo',
          full_transcript: '[Cliente]: Olá | [IA]: Até logo',
          message_tools: ['agreement'],
        },
      ]);

      const result = await service.getInteractionDetail(
        'company-1',
        '00000000-0000-0000-0000-00000000000a',
      );

      expect(result).toMatchObject(full);
      expect(result?.full_transcript).toBe('[Cliente]: Olá | [IA]: Até logo');
      expect(result?.executed_tools).toContain('agreement');
      expect(result?.executed_tools).toContain('buscar_cpf');
    });

    it('should return null for invalid uuid without querying', async () => {
      const result = await service.getInteractionDetail('company-1', 'abc');
      expect(result).toBeNull();
      expect(mockPrisma.painel_interactions.findFirst).not.toHaveBeenCalled();
    });

    it('should return null when interaction does not exist', async () => {
      mockPrisma.painel_interactions.findFirst.mockResolvedValue(null);

      const result = await service.getInteractionDetail(
        'company-1',
        '00000000-0000-0000-0000-00000000000a',
      );

      expect(result).toBeNull();
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('getInteractionsMessages', () => {
    it('should query messages only for valid uuids', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: '00000000-0000-0000-0000-00000000000a', messages: [] },
      ]);

      const result = await service.getInteractionsMessages('company-1', [
        '00000000-0000-0000-0000-00000000000a',
        'invalid',
      ]);

      expect(result).toHaveLength(1);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no valid ids are provided', async () => {
      const result = await service.getInteractionsMessages('company-1', [
        'invalid',
      ]);
      expect(result).toEqual([]);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('getCostsAndConsumption', () => {
    it('should aggregate costs and model consumption via SQL rows', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            key: null,
            provider: 'groq',
            total_runs: 1,
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            cost_usd: 0.002,
            avg_latency_ms: 320,
            p95_latency_ms: 320,
            g_model: 1,
            g_provider: 1,
          },
          {
            key: 'llama-3.3-70b-versatile',
            provider: 'groq',
            total_runs: 1,
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            cost_usd: 0.002,
            avg_latency_ms: 320,
            p95_latency_ms: 320,
            g_model: 0,
            g_provider: 1,
          },
          {
            key: 'groq',
            provider: 'groq',
            total_runs: 1,
            input_tokens: 1000,
            output_tokens: 500,
            total_tokens: 1500,
            cost_usd: 0.002,
            avg_latency_ms: 320,
            p95_latency_ms: 320,
            g_model: 1,
            g_provider: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            interactions: 0,
            voice_duration_seconds: 0,
            barge_ins: 0,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
          },
        ]);

      const result = await service.getCostsAndConsumption('company-1');

      expect(result.totals.total_runs).toBe(1);
      expect(result.totals.total_tokens).toBe(1500);
      expect(result.totals.p95_latency_ms).toBe(320);
      expect(result.totals.total_cost_usd).toBe(0.002);
      expect(result.by_model).toHaveLength(1);
      expect(result.by_model[0].model).toBe('llama-3.3-70b-versatile');
      expect(result.by_provider).toHaveLength(1);
      expect(result.by_provider[0].provider).toBe('groq');
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('should fall back to interaction totals when there are no agent runs', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            key: null,
            provider: null,
            total_runs: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            avg_latency_ms: 0,
            p95_latency_ms: 0,
            g_model: 1,
            g_provider: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            interactions: 7,
            voice_duration_seconds: 600,
            barge_ins: 3,
            total_tokens: 800,
            input_tokens: 600,
            output_tokens: 200,
            cost_usd: 0.01,
          },
        ]);

      const result = await service.getCostsAndConsumption('company-1');

      expect(result.totals.total_runs).toBe(7);
      expect(result.totals.total_tokens).toBe(800);
      expect(result.totals.p95_latency_ms).toBe(0);
      expect(result.totals.voice_duration_minutes).toBe(10);
      expect(result.totals.total_barge_ins).toBe(3);
      expect(result.by_model).toHaveLength(0);
    });
  });

  describe('evaluateAndRecord', () => {
    it('should upsert markers idempotently without a prior findFirst', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        metadata: {
          analytics_config: {
            markers: [
              {
                code: 'agreement',
                label: 'Acordo',
                conditions: [
                  { variable: 'acordo_id', operator: 'exists', value: null },
                ],
              },
            ],
            funnel: [],
          },
        },
      });
      mockPrisma.business_events.upsert.mockResolvedValue({});

      await service.evaluateAndRecord({
        clientId: 'client-1',
        companyId: 'company-1',
        conversationId: 'conv-1',
        state: { acordo_id: 'A-1' },
      });

      expect(mockPrisma.business_events.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.business_events.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.business_events.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversation_id_marker_code: {
              conversation_id: 'conv-1',
              marker_code: 'agreement',
            },
          },
          update: {},
        }),
      );
    });

    it('should create directly when there is no conversation', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        metadata: {
          analytics_config: {
            markers: [
              {
                code: 'lead',
                label: 'Lead',
                conditions: [
                  { variable: 'cpf', operator: 'exists', value: null },
                ],
              },
            ],
            funnel: [],
          },
        },
      });
      mockPrisma.business_events.create.mockResolvedValue({});

      await service.evaluateAndRecord({
        clientId: 'client-1',
        companyId: 'company-1',
        state: { cpf: '123' },
      });

      expect(mockPrisma.business_events.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.business_events.create).toHaveBeenCalledTimes(1);
    });
  });
});
