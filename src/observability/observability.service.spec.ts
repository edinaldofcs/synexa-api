import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ObservabilityService } from './observability.service';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  QUEUE_AGENT,
  QUEUE_DEAD_LETTER,
  QUEUE_DISPATCHER,
  QUEUE_INGESTION,
  QUEUE_KNOWLEDGE,
  QUEUE_MEDIA,
} from '../queue/queue.constants';

describe('ObservabilityService', () => {
  let service: ObservabilityService;

  const mockPrisma = {
    $queryRaw: jest.fn(),
  };

  const mockQueues = [
    { provide: getQueueToken(QUEUE_INGESTION), useValue: {} },
    { provide: getQueueToken(QUEUE_AGENT), useValue: {} },
    { provide: getQueueToken(QUEUE_DISPATCHER), useValue: {} },
    { provide: getQueueToken(QUEUE_MEDIA), useValue: {} },
    { provide: getQueueToken(QUEUE_KNOWLEDGE), useValue: {} },
    { provide: getQueueToken(QUEUE_DEAD_LETTER), useValue: {} },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObservabilityService,
        { provide: PrismaService, useValue: mockPrisma },
        ...mockQueues,
      ],
    }).compile();

    service = module.get<ObservabilityService>(ObservabilityService);
    jest.clearAllMocks();
  });

  it('should compute latency metrics via SQL aggregation', async () => {
    mockPrisma.$queryRaw.mockImplementation((query: { sql?: string }) => {
      const sql: string = query?.sql ?? String(query);
      if (sql.includes('/* obs_latency_metrics */')) {
        return Promise.resolve([
          {
            total_runs: 10,
            failed_runs: 2,
            avg_latency_ms: 420.4,
            p95_latency_ms: 900.6,
          },
        ]);
      }
      if (sql.includes('/* obs_latency_by_model */')) {
        return Promise.resolve([
          { model: 'gemini-2.0-flash', runs: 7 },
          { model: 'unknown', runs: 3 },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await service.getLatencyMetrics(24, 'company-1');

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      period_hours: 24,
      total_runs: 10,
      avg_latency_ms: 420,
      p95_latency_ms: 901,
      error_rate_percent: 20,
      by_model: { 'gemini-2.0-flash': 7, unknown: 3 },
    });
  });

  it('should compute cost metrics via SQL aggregation', async () => {
    mockPrisma.$queryRaw.mockImplementation((query: { sql?: string }) => {
      const sql: string = query?.sql ?? String(query);
      if (sql.includes('/* obs_cost_by_provider */')) {
        return Promise.resolve([
          { provider: 'groq', runs: 3, total_cost: 0.25, total_tokens: 1200 },
          { provider: 'gemini', runs: 1, total_cost: 0.5, total_tokens: 100 },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await service.getCostMetrics(168);

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      period_hours: 168,
      total_runs: 4,
      total_cost: 0.75,
      total_tokens: 1300,
      by_provider: { groq: 3, gemini: 1 },
    });
  });
});
