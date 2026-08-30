import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';

describe('BillingService', () => {
  let service: BillingService;

  const mockPrismaService = {
    $queryRaw: jest.fn(),
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
    mockPrismaService.$queryRaw.mockReset();
  });

  it('should summarize monthly usage correctly with tokens and voice minutes', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([
      {
        provider_key: 'groq',
        model_key: 'llama-3.3-70b-versatile',
        total_runs: 1,
        voice_runs: 0,
        voice_seconds: 0,
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cost_usd: 0.001,
      },
      {
        provider_key: 'gemini-live',
        model_key: 'gemini-3.1-flash-live-preview',
        total_runs: 1,
        voice_runs: 1,
        voice_seconds: 120,
        input_tokens: 2000,
        output_tokens: 1000,
        total_tokens: 3000,
        cost_usd: 0.06,
      },
    ]);

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

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain('billing_usage_by_model');
    expect(query.sql).not.toContain('00000000-0000-0000-0000-000000000001');
    expect(query.values).toContain('00000000-0000-0000-0000-000000000001');
  });

  it('should aggregate daily usage data series', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([
      {
        date: '2026-08-30',
        runs: 2,
        tokens: 4500,
        voice_seconds: 120,
        cost_usd: 0.061,
      },
    ]);

    const daily = await service.getDailyUsage(
      '00000000-0000-0000-0000-000000000001',
      30,
    );

    expect(daily.length).toBeGreaterThan(0);
    expect(daily[0].runs).toBe(2);
    expect(daily[0].tokens).toBe(4500);
    expect(daily[0].voiceSeconds).toBe(120);

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain('billing_usage_by_day');
    expect(query.values).toContain('00000000-0000-0000-0000-000000000001');
  });
});
