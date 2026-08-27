import { Test, TestingModule } from '@nestjs/testing';
import { BillingService } from './billing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';

describe('BillingService', () => {
  let service: BillingService;

  const mockPrismaService = {
    agent_runs: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: '1',
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
          cost: 0.001,
          status: 'success',
          started_at: new Date(),
          trace: {},
        },
        {
          id: '2',
          provider: 'gemini-live',
          model: 'gemini-3.1-flash-live-preview',
          input_tokens: 2000,
          output_tokens: 1000,
          total_tokens: 3000,
          cost: 0.06,
          status: 'success',
          started_at: new Date(),
          trace: { duration_seconds: 120 },
        },
      ]),
    },
  };

  const mockPricingService = {
    getMarkupPercent: jest.fn().mockReturnValue(25),
    getExchangeRate: jest.fn().mockReturnValue(5.8),
    calculateBillable: jest.fn().mockImplementation((rawCost: number) => ({
      rawCostUsd: rawCost,
      billableCostUsd: rawCost * 1.25,
      billableCostBrl: rawCost * 1.25 * 5.8,
      markupPercent: 25,
      exchangeRate: 5.8,
    })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ModelPricingService, useValue: mockPricingService },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
  });

  it('should summarize monthly usage correctly with tokens and voice minutes', async () => {
    const summary = await service.getUsageSummary(
      '00000000-0000-0000-0000-000000000001',
    );

    expect(summary.companyId).toBe('00000000-0000-0000-0000-000000000001');
    expect(summary.totals.totalInteractions).toBe(2);
    expect(summary.totals.textInteractions).toBe(1);
    expect(summary.totals.voiceInteractions).toBe(1);
    expect(summary.totals.totalTokens).toBe(4500);
    expect(summary.totals.voiceDurationMinutes).toBe(2); // 120s = 2 min
    expect(summary.totals.rawCostUsd).toBe(0.061);
    expect(summary.totals.billableCostUsd).toBeCloseTo(0.061 * 1.25, 4);
    expect(summary.byModel).toHaveLength(2);
  });

  it('should aggregate daily usage data series', async () => {
    const daily = await service.getDailyUsage(
      '00000000-0000-0000-0000-000000000001',
      30,
    );

    expect(daily.length).toBeGreaterThan(0);
    expect(daily[0].runs).toBe(2);
    expect(daily[0].tokens).toBe(4500);
  });
});
