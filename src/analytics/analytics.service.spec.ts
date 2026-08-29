import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../common/prisma/prisma.service';

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
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBiDashboard', () => {
    it('should aggregate BI metrics and funnel correctly', async () => {
      mockPrisma.$queryRaw.mockImplementation((query: { sql?: string }) => {
        const sql: string = query?.sql ?? String(query);
        if (sql.includes('/* bi_kpi */')) {
          return Promise.resolve([
            {
              total: 1,
              human_answers: 1,
              cpc: 1,
              cpca: 1,
              agreements: 1,
              promises: 0,
              agreement_value: 450,
              promise_value: 0,
              debt_value: 500,
              total_duration: 120,
              barge_ins: 1,
              total_tokens: 3000,
              cost_usd: 0.05,
            },
          ]);
        }
        if (sql.includes('/* bi_by_day */')) {
          return Promise.resolve([
            {
              date: '2026-08-26',
              total: 1,
              human_answers: 1,
              cpc: 1,
              cpca: 1,
              agreements: 1,
              promises: 0,
              agreement_value: 450,
            },
          ]);
        }
        if (sql.includes('/* bi_by_hour */')) return Promise.resolve([]);
        if (sql.includes('/* bi_by_month */')) {
          return Promise.resolve([
            {
              month: '2026-08',
              total: 1,
              cpc: 1,
              agreements: 1,
              agreement_value: 450,
            },
          ]);
        }
        if (sql.includes('/* bi_by_channel */')) {
          return Promise.resolve([
            { channel: 'webchat', total: 1, agreements: 1 },
          ]);
        }
        if (sql.includes('/* bi_by_agent */')) {
          return Promise.resolve([
            { agent: 'Negociador', total: 1, agreements: 1 },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getBiDashboard('company-1', {
        clientId: 'client-1',
      });

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
    });

    it('should return zeroed rates when there are no interactions', async () => {
      mockPrisma.$queryRaw.mockImplementation((query: { sql?: string }) => {
        const sql: string = query?.sql ?? String(query);
        if (sql.includes('/* bi_kpi */')) {
          return Promise.resolve([
            {
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
            },
          ]);
        }
        return Promise.resolve([]);
      });

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
  });

  describe('getInteractionsReport', () => {
    it('should return paginated interactions report with derived fields', async () => {
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
          full_transcript: '[Cliente]: Olá | [IA]: Até logo',
          message_tools: ['agreement'],
        },
      ]);

      const result = await service.getInteractionsReport('company-1', {
        page: 1,
        limit: 10,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].messages_count).toBe(5);
      expect(result.items[0].last_user_message).toBe('Tchau');
      expect(result.items[0].executed_tools).toContain('agreement');
      expect(result.items[0].executed_tools).toContain('buscar_cpf');
      expect((result.items[0] as any).messages).toBeUndefined();
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
    });
  });

  describe('getInteractionDetail', () => {
    it('should return the full interaction for the company', async () => {
      const full = { id: '00000000-0000-0000-0000-00000000000a', messages: [] };
      mockPrisma.painel_interactions.findFirst.mockResolvedValue(full);

      const result = await service.getInteractionDetail(
        'company-1',
        '00000000-0000-0000-0000-00000000000a',
      );

      expect(result).toBe(full);
      expect(mockPrisma.painel_interactions.findFirst).toHaveBeenCalledWith({
        where: {
          id: '00000000-0000-0000-0000-00000000000a',
          company_id: 'company-1',
        },
      });
    });

    it('should return null for invalid uuid without querying', async () => {
      const result = await service.getInteractionDetail('company-1', 'abc');
      expect(result).toBeNull();
      expect(mockPrisma.painel_interactions.findFirst).not.toHaveBeenCalled();
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
    it('should aggregate costs and model consumption correctly', async () => {
      mockPrisma.painel_interactions.findMany.mockResolvedValue([]);
      mockPrisma.agent_runs.findMany.mockResolvedValue([
        {
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
          cost: 0.002,
          latency_ms: 320,
          status: 'success',
          started_at: new Date(),
        },
      ]);

      const result = await service.getCostsAndConsumption('company-1');

      expect(result.totals.total_runs).toBe(1);
      expect(result.totals.total_tokens).toBe(1500);
      expect(result.by_model).toHaveLength(1);
      expect(result.by_model[0].model).toBe('llama-3.3-70b-versatile');
      expect(result.by_provider).toHaveLength(1);
    });
  });
});
