import { Test, TestingModule } from '@nestjs/testing';
import { VoiceTelemetryService } from './voice-telemetry.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';
import { InteractionsService } from '../../interactions/interactions.service';
import { VoiceClientSession } from '../sessions/voice-client-session';

describe('VoiceTelemetryService', () => {
  let service: VoiceTelemetryService;
  let prismaMock: any;
  let pricingMock: any;
  let interactionsMock: any;

  beforeEach(async () => {
    prismaMock = {
      conversations: { update: jest.fn().mockResolvedValue({}) },
      agent_runs: { create: jest.fn().mockResolvedValue({}) },
      voice_session_telemetry: { create: jest.fn().mockResolvedValue({}) },
      messages: { create: jest.fn().mockResolvedValue({ id: 'msg-1' }), update: jest.fn().mockResolvedValue({}) },
      conversation_state: { upsert: jest.fn().mockResolvedValue({}) },
    };

    pricingMock = {
      calculateVoiceLiveCost: jest.fn().mockReturnValue(0.015),
      calculateHybridVoiceCost: jest.fn().mockReturnValue(0.020),
    };

    interactionsMock = {
      syncSessionInteraction: jest.fn().mockResolvedValue({ id: 'interaction-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceTelemetryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ModelPricingService, useValue: pricingMock },
        { provide: InteractionsService, useValue: interactionsMock },
      ],
    }).compile();

    service = module.get<VoiceTelemetryService>(VoiceTelemetryService);
  });

  it('deve sincronizar painel_interactions ao persistir a telemetria da sessão', async () => {
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

    expect(interactionsMock.syncSessionInteraction).toHaveBeenCalledTimes(1);
    expect(interactionsMock.syncSessionInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conv-abc',
        companyId: 'comp-123',
        clientId: 'client-456',
        agentId: 'agent-789',
        agentName: 'Assistente Principal',
        channel: 'voice_webrtc',
        state: session.state,
        bargeInCount: 2,
        totalTokens: 150,
      }),
    );
  });

  it('não deve persistir telemetria duas vezes na mesma sessão', async () => {
    const wsMock: any = {};
    const session = new VoiceClientSession(wsMock);
    session.companyId = 'comp-123';
    session.clientId = 'client-456';
    session.conversationId = 'conv-abc';

    await service.persistSessionTelemetry(session);
    await service.persistSessionTelemetry(session);

    expect(interactionsMock.syncSessionInteraction).toHaveBeenCalledTimes(1);
  });
});
