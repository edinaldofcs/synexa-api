import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../common/prisma/prisma.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  const mockPrisma = {
    painel_clients: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    painel_interactions: {
      findMany: jest.fn(),
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
      const now = new Date('2026-08-26T14:30:00.000Z');
      mockPrisma.painel_interactions.findMany.mockResolvedValue([
        {
          id: '1',
          channel: 'webchat',
          agent_name: 'Negociador',
          has_human_answer: true,
          is_right_party: true,
          is_debt_presented: true,
          is_agreement_reached: true,
          is_promise_to_pay: false,
          debt_amount: 500,
          agreement_amount: 450,
          promise_amount: 0,
          duration_seconds: 120,
          barge_in_count: 1,
          total_tokens: 3000,
          estimated_cost_usd: 0.05,
          status: 'completed',
          disposition: 'AGREEMENT_CLOSED',
          created_at: now,
        },
      ]);

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
      expect(result.by_day).toHaveLength(1);
    });
  });

  describe('getInteractionsReport', () => {
    it('should return paginated interactions report', async () => {
      mockPrisma.painel_interactions.findMany.mockResolvedValue([
        { id: 'int-1' },
      ]);
      mockPrisma.painel_interactions.count.mockResolvedValue(1);

      const result = await service.getInteractionsReport('company-1', {
        page: 1,
        limit: 10,
      });

      expect(result.items).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
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
