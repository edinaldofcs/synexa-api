import { Test, TestingModule } from '@nestjs/testing';
import { VoiceTelemetryService } from './voice-telemetry.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';
import { VoiceClientSession } from '../sessions/voice-client-session';

describe('VoiceTelemetryService', () => {
  let service: VoiceTelemetryService;
  let prismaMock: any;
  let pricingMock: any;

  beforeEach(async () => {
    prismaMock = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      conversations: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agent_runs: { create: jest.fn().mockResolvedValue({}) },
      voice_session_telemetry: { create: jest.fn().mockResolvedValue({}) },
      messages: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversation_state: { upsert: jest.fn().mockResolvedValue({}) },
    };

    pricingMock = {
      getExchangeRate: jest.fn().mockReturnValue(5.8),
      calculateVoiceLiveCost: jest.fn().mockReturnValue(0.015),
      calculateHybridVoiceCost: jest.fn().mockReturnValue(0.02),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceTelemetryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ModelPricingService, useValue: pricingMock },
      ],
    }).compile();

    service = module.get<VoiceTelemetryService>(VoiceTelemetryService);
  });

  it('persiste telemetria mesmo sem filtro de áudio e sem inferir dados de negócio', async () => {
    const wsMock: any = {};
    const session = new VoiceClientSession(wsMock);
    session.companyId = 'comp-123';
    session.clientId = 'client-456';
    session.agentId = 'agent-789';
    session.conversationId = 'conv-abc';
    session.startTime = Date.now() - 30000;
    session.inputTokens = 100;
    session.outputTokens = 50;
    session.totalTokens = 150;
    session.interruptedCount = 2;
    session.state = {
      cpf: '08334993942',
      nome_cliente: 'João da Silva',
      valor_original: 589.9,
      acordo_id: 'ACD-2026-083349',
      valor_total: 589.9,
      nome_agente: 'Assistente Principal',
    };

    await service.persistSessionTelemetry(session);

    expect(prismaMock.conversations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-abc' },
        data: expect.objectContaining({ status: 'closed' }),
      }),
    );

    expect(prismaMock.voice_session_telemetry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversation_id: 'conv-abc',
          total_tokens: 150,
          audio_gate_enabled: false,
        }),
      }),
    );
    expect(session.state).not.toHaveProperty('cpc');
  });

  it('não deve persistir telemetria duas vezes na mesma sessão', async () => {
    const wsMock: any = {};
    const session = new VoiceClientSession(wsMock);
    session.companyId = 'comp-123';
    session.clientId = 'client-456';
    session.conversationId = 'conv-abc';

    await service.persistSessionTelemetry(session);
    await service.persistSessionTelemetry(session);

    expect(prismaMock.voice_session_telemetry.create).toHaveBeenCalledTimes(1);
  });
});
