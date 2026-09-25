import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';

describe('BillingService', () => {
  let service: BillingService;

  const mockPrismaService = {
    $queryRaw: jest.fn(),
  };

  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
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
        { provide: RedisService, useValue: mockRedisService },
        { provide: ModelPricingService, useValue: mockPricingService },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
    mockPrismaService.$queryRaw.mockReset();
    mockRedisService.get.mockReset();
    mockRedisService.set.mockReset();
    mockRedisService.get.mockResolvedValue(null);
    mockRedisService.set.mockResolvedValue(undefined);
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

  it('should include cartesia-cascade sessions in the voice filter', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([
      {
        provider_key: 'cartesia-cascade',
        model_key: 'gemini-2.5-flash-lite',
        total_runs: 1,
        voice_runs: 1,
        voice_seconds: 300,
        input_tokens: 500,
        output_tokens: 250,
        total_tokens: 750,
        cost_usd: 0.02,
      },
      {
        provider_key: 'groq',
        model_key: 'llama-3.3-70b-versatile',
        total_runs: 1,
        voice_runs: 0,
        voice_seconds: 0,
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cost_usd: 0.001,
      },
    ]);

    const summary = await service.getUsageSummary(
      '00000000-0000-0000-0000-000000000001',
    );

    expect(summary.totals.voiceInteractions).toBe(1);
    expect(summary.totals.voiceDurationMinutes).toBe(5); // 300s
    expect(summary.totals.textInteractions).toBe(1);

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain("trace ->> 'type' = 'voice_session'");
    expect(query.sql).toContain("provider = 'cartesia-cascade'");
    expect(query.sql).toContain("provider = 'gemini-live'");
  });

  it('should apply optional clientId and from/to filters to the summary', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([]);

    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-08-31T23:59:59.999Z';
    await service.getUsageSummary(
      '00000000-0000-0000-0000-000000000001',
      undefined,
      {
        clientId: '11111111-1111-1111-1111-111111111111',
        from,
        to,
      },
    );

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain('client_id');
    expect(query.values).toContain('11111111-1111-1111-1111-111111111111');
    const fromValue = query.values.find(
      (v) => v instanceof Date && v.toISOString() === from,
    );
    const toValue = query.values.find(
      (v) => v instanceof Date && v.toISOString() === to,
    );
    expect(fromValue).toBeDefined();
    expect(toValue).toBeDefined();
  });

  it('should reject invalid client_id in the summary', async () => {
    await expect(
      service.getUsageSummary(
        '00000000-0000-0000-0000-000000000001',
        undefined,
        {
          clientId: 'not-a-uuid',
        },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrismaService.$queryRaw).not.toHaveBeenCalled();
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

  it('should filter daily usage by client and custom window', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([]);

    await service.getDailyUsage('00000000-0000-0000-0000-000000000001', 30, {
      clientId: '11111111-1111-1111-1111-111111111111',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toContain('11111111-1111-1111-1111-111111111111');
    expect(query.sql).toContain('started_at >=');
    expect(query.sql).toContain('started_at <=');
  });

  it('should aggregate voice minutes from voice_session_telemetry by day, client and model', async () => {
    mockPrismaService.$queryRaw
      .mockResolvedValueOnce([
        {
          date: '2026-09-20',
          sessions: 2,
          duration_seconds: 300,
          forwarded_seconds: 240,
        },
        {
          date: '2026-09-21',
          sessions: 1,
          duration_seconds: 120,
          forwarded_seconds: 90,
        },
      ])
      .mockResolvedValueOnce([
        {
          client_id: '11111111-1111-1111-1111-111111111111',
          client_name: 'Cliente A',
          sessions: 3,
          duration_seconds: 420,
          forwarded_seconds: 330,
        },
      ])
      .mockResolvedValueOnce([
        {
          model: 'gemini-3.1-flash-live-preview',
          voice_name: 'Aura',
          sessions: 2,
          duration_seconds: 300,
          forwarded_seconds: 240,
        },
        {
          model: 'cartesia-sonic',
          voice_name: 'default',
          sessions: 1,
          duration_seconds: 120,
          forwarded_seconds: 90,
        },
      ]);

    const result = await service.getVoiceMinutes(
      '00000000-0000-0000-0000-000000000001',
      { from: '2026-09-01T00:00:00.000Z', to: '2026-09-21T23:59:59.999Z' },
    );

    expect(result.totals.sessions).toBe(3);
    expect(result.totals.durationSeconds).toBe(420);
    expect(result.totals.durationMinutes).toBe(7);
    expect(result.totals.forwardedSeconds).toBe(330);
    expect(result.byDay).toHaveLength(2);
    expect(result.byClient[0].clientName).toBe('Cliente A');
    expect(result.byModel).toHaveLength(2);
    expect(result.byModel[0].model).toBe('gemini-3.1-flash-live-preview');

    const markers = (mockPrismaService.$queryRaw.mock.calls as unknown[][]).map(
      (call) => (call[0] as Prisma.Sql).sql,
    );
    expect(markers[0]).toContain('billing_voice_minutes_by_day');
    expect(markers[1]).toContain('billing_voice_minutes_by_client');
    expect(markers[2]).toContain('billing_voice_minutes_by_model');
    markers.forEach((sql) => expect(sql).toContain('audio_gate_forwarded_sec'));
  });

  it('should use voice_session_telemetry only for voice minutes', async () => {
    mockPrismaService.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.getVoiceMinutes('00000000-0000-0000-0000-000000000001', {
      days: 30,
    });

    const queries = (mockPrismaService.$queryRaw.mock.calls as unknown[][]).map(
      (call) => (call[0] as Prisma.Sql).sql,
    );
    queries.forEach((sql) => expect(sql).toContain('voice_session_telemetry'));
    queries.forEach((sql) => expect(sql).not.toContain('agent_runs'));
  });

  it('should reject voice minutes windows longer than 366 days', async () => {
    await expect(
      service.getVoiceMinutes('00000000-0000-0000-0000-000000000001', {
        from: '2024-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrismaService.$queryRaw).not.toHaveBeenCalled();
  });

  it('should reject from without to in voice minutes', async () => {
    await expect(
      service.getVoiceMinutes('00000000-0000-0000-0000-000000000001', {
        from: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should split tokens usage by model and agent with grouping sets', async () => {
    mockPrismaService.$queryRaw.mockResolvedValueOnce([
      {
        model_grp: 0,
        agent_grp: 1,
        model_key: 'llama-3.3-70b-versatile',
        agent_key: 'all',
        runs: 8,
        input_tokens: 800,
        output_tokens: 400,
        total_tokens: 1200,
        cost_usd: 0.0036,
      },
      {
        model_grp: 0,
        agent_grp: 1,
        model_key: 'openai/gpt-4o-mini',
        agent_key: 'all',
        runs: 2,
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        cost_usd: 0.0004,
      },
      {
        model_grp: 1,
        agent_grp: 0,
        model_key: 'all',
        agent_key: 'agent-1',
        runs: 9,
        input_tokens: 900,
        output_tokens: 450,
        total_tokens: 1350,
        cost_usd: 0.0036,
      },
      {
        model_grp: 1,
        agent_grp: 0,
        model_key: 'all',
        agent_key: 'none',
        runs: 1,
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cost_usd: 0.0004,
      },
      {
        model_grp: 1,
        agent_grp: 1,
        model_key: 'all',
        agent_key: 'all',
        runs: 10,
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cost_usd: 0.004,
      },
    ]);

    const result = await service.getTokensUsage(
      '00000000-0000-0000-0000-000000000001',
      { clientId: '11111111-1111-1111-1111-111111111111' },
    );

    expect(result.totals.runs).toBe(10);
    expect(result.totals.totalTokens).toBe(1500);
    expect(result.totals.costUsd).toBeCloseTo(0.004, 6);
    expect(result.totals.billableUsd).toBeCloseTo(0.005, 6);
    expect(result.totals.billableBrl).toBeCloseTo(0.005 * 5.8, 4);
    expect(result.byModel).toHaveLength(2);
    expect(result.byModel[0].model).toBe('llama-3.3-70b-versatile');
    expect(result.byAgent).toHaveLength(2);
    expect(result.byAgent.map((a) => a.agentId)).toEqual(['agent-1', 'none']);

    const query = mockPrismaService.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain('billing_tokens_by_grouping_sets');
    expect(query.sql).toContain('GROUPING SETS');
    expect(query.values).toContain('11111111-1111-1111-1111-111111111111');
  });

  it('should cache responses in Redis with 45s TTL and reuse cached results', async () => {
    mockPrismaService.$queryRaw.mockResolvedValue([
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
    ]);

    const companyId = '00000000-0000-0000-0000-000000000001';

    // Primeira chamada: cache miss -> consulta DB -> grava cache com TTL 45
    const first = await service.getUsageSummary(companyId);
    expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockRedisService.set).toHaveBeenCalledWith(
      expect.stringContaining(`billing:${companyId}:summary:`),
      first,
      45,
    );

    // Segunda chamada: cache hit -> não consulta DB novamente
    mockRedisService.get.mockResolvedValueOnce({ cached: true });
    const second = await service.getUsageSummary(companyId);
    expect(second).toEqual({ cached: true });
    expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);

    // Parâmetros diferentes geram chaves distintas
    await service.getUsageSummary(companyId, undefined, {
      clientId: '11111111-1111-1111-1111-111111111111',
    });
    const cacheGets = mockRedisService.get.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(cacheGets).toHaveLength(3);
    // Chamadas 1 e 2 compartilham a mesma chave; a 3ª tem chave própria
    expect(new Set(cacheGets).size).toBe(2);
    expect(cacheGets[2]).not.toBe(cacheGets[0]);
    cacheGets.forEach((key) =>
      expect(key).toMatch(
        /^billing:00000000-0000-0000-0000-000000000001:(summary|tokens|daily|voice-minutes):/,
      ),
    );
  });

  it('should serve voice minutes from cache without hitting the database', async () => {
    const cached = {
      companyId: '00000000-0000-0000-0000-000000000001',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-21T00:00:00.000Z',
      totals: {
        sessions: 0,
        durationSeconds: 0,
        durationMinutes: 0,
        forwardedSeconds: 0,
        forwardedMinutes: 0,
      },
      byDay: [],
      byClient: [],
      byModel: [],
    };
    mockRedisService.get.mockResolvedValueOnce(cached);

    const result = await service.getVoiceMinutes(
      '00000000-0000-0000-0000-000000000001',
      { from: '2026-09-01T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' },
    );

    expect(result).toEqual(cached);
    expect(mockPrismaService.$queryRaw).not.toHaveBeenCalled();
  });

  it('should degrade gracefully when Redis fails', async () => {
    mockRedisService.get.mockRejectedValue(new Error('redis down'));
    mockRedisService.set.mockRejectedValue(new Error('redis down'));
    mockPrismaService.$queryRaw.mockResolvedValueOnce([]);

    const summary = await service.getUsageSummary(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(summary.totals.totalInteractions).toBe(0);
    expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
