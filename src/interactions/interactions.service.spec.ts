import { Test, TestingModule } from '@nestjs/testing';
import { InteractionsService } from './interactions.service';
import { PrismaService } from '../common/prisma/prisma.service';

describe('InteractionsService', () => {
  let service: InteractionsService;
  let prisma: PrismaService;

  const mockPrisma = {
    $queryRaw: jest.fn(),
    painel_interactions: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InteractionsService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<InteractionsService>(InteractionsService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a new interaction session if it does not exist', async () => {
    mockPrisma.painel_interactions.findUnique.mockResolvedValue(null);
    mockPrisma.painel_interactions.create.mockResolvedValue({
      id: 'uuid-1',
      session_id: 'session-123',
      company_id: 'comp-1',
      client_id: 'client-1',
      status: 'ongoing',
    });

    const result = await service.findOrCreateSession({
      company_id: 'comp-1',
      client_id: 'client-1',
      session_id: 'session-123',
      channel: 'webchat',
    });

    expect(result).toBeDefined();
    expect(result.session_id).toBe('session-123');
    expect(mockPrisma.painel_interactions.create).toHaveBeenCalled();
  });

  it('should append a message atomically (raw SQL append, sem read-modify-write)', async () => {
    mockPrisma.painel_interactions.findUnique.mockResolvedValue({
      id: 'uuid-1',
      session_id: 'session-123',
    });
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'uuid-1',
        session_id: 'session-123',
        has_human_answer: true,
        messages: [{ role: 'user', content: 'Olá' }],
      },
    ]);

    const result = await service.appendMessage('session-123', {
      role: 'user',
      content: 'Olá',
    });

    expect(result).toBeDefined();
    expect(result.session_id).toBe('session-123');
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = mockPrisma.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('COALESCE(messages');
    expect(sql.sql).toContain("|| ?::jsonb");
    expect(sql.sql).toContain('RETURNING *');
    // valor da mensagem vai parametrizado (sem interpolação de string)
    expect(sql.values.some((v: any) => String(v).includes('Olá'))).toBe(true);
  });

  it('returns null when session does not exist', async () => {
    mockPrisma.painel_interactions.findUnique.mockResolvedValue(null);

    const result = await service.appendMessage('missing', {
      role: 'user',
      content: 'Olá',
    });

    expect(result).toBeNull();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should record barge-in atomically (increment no banco)', async () => {
    mockPrisma.painel_interactions.findUnique.mockResolvedValue({
      id: 'uuid-1',
      session_id: 'session-123',
    });
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'uuid-1',
        session_id: 'session-123',
        barge_in_count: 2,
        avg_barge_in_latency_ms: 150,
      },
    ]);

    const result = await service.recordBargeIn('session-123', 100);

    expect(result).toBeDefined();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = mockPrisma.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('COALESCE(barge_in_count, 0) + 1');
    expect(sql.sql).toContain('RETURNING *');
  });

  it('should calculate funnel metrics correctly', async () => {
    mockPrisma.painel_interactions.count
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(80) // humanAnswers
      .mockResolvedValueOnce(40) // rightParties
      .mockResolvedValueOnce(30) // debtsPresented
      .mockResolvedValueOnce(10) // agreementsReached
      .mockResolvedValueOnce(5); // promisesToPay

    mockPrisma.painel_interactions.aggregate.mockResolvedValue({
      _sum: {
        barge_in_count: 15,
        duration_seconds: 12000,
        total_tokens: 50000,
      },
      _avg: { avg_barge_in_latency_ms: 140, avg_first_byte_latency_ms: 350 },
    });

    const metrics = await service.getFunnelMetrics('client-1');

    expect(metrics.total_interactions).toBe(100);
    expect(metrics.human_answers).toBe(80);
    expect(metrics.right_parties).toBe(40);
    expect(metrics.cpca_count).toBe(30);
    expect(metrics.rates.cpc_rate_pct).toBe(50); // 40 / 80 * 100
    expect(metrics.rates.rpc_rate_pct).toBe(50);
    expect(metrics.rates.cpca_rate_pct).toBe(75); // 30 / 40 * 100 (Apresentação da Dívida)
    expect(metrics.rates.pitch_rate_pct).toBe(75);
    expect(metrics.rates.agreement_conversion_pct).toBe(25); // 10 / 40 * 100
    expect(metrics.voice_telemetry.total_barge_in_count).toBe(15);
  });
});
