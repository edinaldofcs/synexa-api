import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TabulationService } from './tabulation.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('TabulationService', () => {
  let service: TabulationService;

  const mockPrisma = {
    conversations: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    painel_tracks: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    provider_credentials: {
      findFirst: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(null),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TabulationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<TabulationService>(TabulationService);
  });

  it('deve ser definido', () => {
    expect(service).toBeDefined();
  });

  it('deve tabular conversa pela primeira vez usando fallback heurístico quando sem LLM key', async () => {
    const conversationId = 'conv-123';
    const clientId = 'client-abc';

    mockPrisma.conversations.findUnique.mockResolvedValue({
      id: conversationId,
      client_id: clientId,
      status: 'closed',
      tabulated_at: null,
      tabulation_history: [],
      messages: [
        { sender_type: 'customer', content: 'Olá, preciso da segunda via da minha fatura' },
        { sender_type: 'ai', content: 'Claro, aqui está o código de barras' },
        { sender_type: 'customer', content: 'Muito obrigado, era isso que eu precisava' },
      ],
    });

    mockPrisma.painel_tracks.findMany.mockResolvedValue([
      {
        id: 'track-1',
        code: 'financeiro',
        label: 'Financeiro',
        category: 'Cobrança',
        description: 'Dúvidas sobre faturas, boletos e pagamentos',
        examples: ['quero segunda via', 'boleto'],
      },
      {
        id: 'track-2',
        code: 'suporte',
        label: 'Suporte Técnico',
        category: 'Técnico',
        description: 'Problemas de acesso e erros',
        examples: ['erro de login', 'não abre'],
      },
    ]);

    mockPrisma.conversations.update.mockResolvedValue({ id: conversationId });

    const res = await service.tabulateConversation(conversationId);

    expect(res.success).toBe(true);
    expect(res.track_id).toBe('track-1');
    expect(mockPrisma.conversations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId },
        data: expect.objectContaining({
          track_id: 'track-1',
          tabulated_by: 'ai',
          tabulation_history: [],
        }),
      }),
    );
  });

  it('deve preservar histórico anterior ao retabular conversa reaberta', async () => {
    const conversationId = 'conv-456';
    const clientId = 'client-abc';
    const previousDate = new Date('2026-09-01T10:00:00Z');

    mockPrisma.conversations.findUnique.mockResolvedValue({
      id: conversationId,
      client_id: clientId,
      status: 'closed',
      track_id: 'track-old',
      tabulated_at: previousDate,
      tabulated_by: 'ai',
      tabulation_notes: 'Tabulação antiga de suporte',
      tabulation_history: [],
      messages: [
        { sender_type: 'customer', content: 'Meu sistema deu erro no login' },
        { sender_type: 'ai', content: 'Senha resetada com sucesso' },
        // Nova interação mais recente:
        { sender_type: 'customer', content: 'Agora quero contratar o plano Pro' },
        { sender_type: 'ai', content: 'Excelente, segue a proposta comercial' },
      ],
    });

    mockPrisma.painel_tracks.findMany.mockResolvedValue([
      {
        id: 'track-vendas',
        code: 'vendas',
        label: 'Vendas',
        category: 'Comercial',
        description: 'Contratação e planos Pro',
        examples: ['plano pro', 'contratar'],
      },
      {
        id: 'track-suporte',
        code: 'suporte',
        label: 'Suporte Técnico',
        category: 'Técnico',
        description: 'Problemas técnicos',
        examples: ['erro no login'],
      },
    ]);

    mockPrisma.conversations.update.mockResolvedValue({ id: conversationId });

    const res = await service.tabulateConversation(conversationId);

    expect(res.success).toBe(true);
    expect(mockPrisma.conversations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId },
        data: expect.objectContaining({
          track_id: 'track-vendas',
          tabulated_by: 'ai',
          tabulation_history: [
            expect.objectContaining({
              track_id: 'track-old',
              tabulated_at: previousDate,
              tabulated_by: 'ai',
              notes: 'Tabulação antiga de suporte',
            }),
          ],
        }),
      }),
    );
  });

  it('deve permitir tabulação manual pelo operador humano arquivando histórico anterior', async () => {
    const conversationId = 'conv-789';
    const oldDate = new Date('2026-09-05T12:00:00Z');

    mockPrisma.conversations.findUnique.mockResolvedValue({
      id: conversationId,
      company_id: 'comp-1',
      track_id: 'track-old',
      tabulated_at: oldDate,
      tabulated_by: 'ai',
      tabulation_notes: 'Automático',
      tabulation_history: [],
    });

    mockPrisma.painel_tracks.findUnique.mockResolvedValue({
      id: 'track-manual',
      label: 'Cancelamento Retido',
    });

    mockPrisma.conversations.update.mockResolvedValue({ id: conversationId });

    await service.manualTabulate(
      conversationId,
      'track-manual',
      'Cliente desistiu de cancelar após desconto',
      'user-op-1',
      'comp-1',
    );

    expect(mockPrisma.conversations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId },
        data: expect.objectContaining({
          track_id: 'track-manual',
          tabulated_by: 'user-op-1',
          tabulation_notes: 'Cliente desistiu de cancelar após desconto',
          tabulation_history: [
            expect.objectContaining({
              track_id: 'track-old',
              tabulated_at: oldDate,
            }),
          ],
        }),
      }),
    );
  });
});
