import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MediaService } from '../media/media.service';
import { CrmDataTransformerService } from '../common/services/crm-data-transformer.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApiToolExecutorService } from './services/api-tool-executor.service';
import { LlmToolLoopService } from './services/llm-tool-loop.service';
import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { ModelPricingService } from './services/model-pricing.service';
import type { TestChatDto } from './dto/test-chat.dto';

import { TestChatService } from './test-chat.service';

const CONTEXT_KEY = 'test_chat_context_variables';
const PAINEL_MESSAGES_LIMIT = 50;
const CONVERSATION_LOCK_KEY = 'lock:test-chat:conv-1';

const baseConversation = {
  id: 'conv-1',
  company_id: 'company-1',
  client_id: 'client-1',
  end_user_id: 'end-user-1',
  origin_channel: 'webchat_test',
  status: 'active',
  metadata: { [CONTEXT_KEY]: { pedido: '123' } },
  end_users: { id: 'end-user-1', name: 'Cliente Teste', metadata: {} },
};

const buildDto = (): TestChatDto => ({
  message: 'Ola, tudo bem?',
  clientId: 'client-1',
  externalUserId: 'ext-user-1',
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  apiKey: 'sk-live-key-123',
});

describe('TestChatService', () => {
  let service: TestChatService;

  const mockPrisma = {
    painel_clients: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'client-1',
        company_id: 'company-1',
        agent_name: 'Bot Teste',
        metadata: {},
      }),
    },
    painel_agents: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'agent-1',
          service_step: 'Agente 1',
          is_initial: true,
          activation_conditions: null,
          activation_mode: 'on_next_message',
          interaction_mode: 'text',
        },
      ]),
    },
    channel_identities: {
      findFirst: jest.fn().mockResolvedValue({ end_user_id: 'end-user-1' }),
      create: jest.fn().mockResolvedValue({}),
    },
    end_users: {
      create: jest.fn().mockResolvedValue({ id: 'end-user-1' }),
    },
    conversations: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      findUnique: jest.fn().mockResolvedValue(baseConversation),
      create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    messages: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: data.sender_type === 'customer' ? 'msg-inbound-1' : 'msg-out-1',
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    message_parts: {
      create: jest.fn().mockResolvedValue({}),
    },
    agent_runs: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', started_at: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation_state: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ conversation_id: 'conv-1', state: {} }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    painel_interactions: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };

  const mockRedis = {
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const mockConversationsService = {
    getState: jest.fn().mockResolvedValue({}),
    updateState: jest.fn().mockResolvedValue(undefined),
  };

  const mockProviderKeyResolver = {
    resolveApiKey: jest.fn().mockResolvedValue('sk-registered-key'),
  };

  const mockApiToolExecutor = {
    buildAgentConfigFromRecord: jest.fn().mockReturnValue({}),
    loadAgentTools: jest.fn().mockResolvedValue({
      apiTools: [],
      availableTools: [],
      allClientApiNames: [],
    }),
    mergeToolResults: jest.fn((vars: Record<string, unknown>) => ({ ...vars })),
  };

  const mockLlmToolLoop = {
    run: jest.fn().mockResolvedValue({
      text: 'Resposta da IA',
      toolCalls: [],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
    listModels: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConversationsService, useValue: mockConversationsService },
        { provide: MediaService, useValue: { storeInlineAsset: jest.fn() } },
        {
          provide: ProviderKeyResolverService,
          useValue: mockProviderKeyResolver,
        },
        {
          provide: ModelPricingService,
          useValue: { calculateTokenCost: jest.fn().mockReturnValue(0.0001) },
        },
        {
          provide: CrmDataTransformerService,
          useValue: { transform: jest.fn().mockReturnValue({ cliente: 'x' }) },
        },
        {
          provide: AnalyticsService,
          useValue: {
            evaluateAndRecord: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ApiToolExecutorService, useValue: mockApiToolExecutor },
        { provide: LlmToolLoopService, useValue: mockLlmToolLoop },
      ],
    }).compile();

    service = module.get<TestChatService>(TestChatService);
    jest.clearAllMocks();
    // Defaults re-aplicados (clearAllMocks preserva implementações, mas os
    // testes abaixo sobrescrevem estes retornos).
    mockPrisma.painel_interactions.findUnique.mockResolvedValue(null);
    mockPrisma.conversations.findUnique.mockResolvedValue(baseConversation);
    mockRedis.acquireLock.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('P31 - dedup de leituras por turno', () => {
    it('deve ler painel_clients, conversations e conversation_state 1x por turno (sem conversationsService.getState)', async () => {
      const result = await service.send(buildDto());

      expect(result.text).toBe('Resposta da IA');
      expect(result.debug?.conversationId).toBe('conv-1');
      expect(result.debug?.memory).toEqual({ source: 'none', messagesUsed: 0 });

      // Dedup: 1 leitura de cada por turno
      expect(mockPrisma.painel_clients.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.conversations.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.conversation_state.findUnique).toHaveBeenCalledTimes(1);
      // O estado do turno vem do cache em memória, não de nova leitura
      expect(mockConversationsService.getState).not.toHaveBeenCalled();
      // state persistido sem re-leitura (apenas upsert, merge do turno)
      expect(mockPrisma.conversation_state.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.conversation_state.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversation_id: 'conv-1' },
          update: expect.objectContaining({
            state: expect.objectContaining({ current_agent_id: 'agent-1' }),
          }),
        }),
      );
    });

    it('deve reutilizar a conversa lida no inicio do turno ao gravar crm_record, preservando o contexto persistido', async () => {
      await service.send(buildDto());

      const updateCalls = mockPrisma.conversations.update.mock.calls;
      const crmUpdate = updateCalls[updateCalls.length - 1][0];
      expect(crmUpdate.where).toEqual({ id: 'conv-1' });
      expect(crmUpdate.data.metadata[CONTEXT_KEY]).toMatchObject({
        pedido: '123',
      });
      expect(crmUpdate.data.metadata.crm_record).toEqual({ cliente: 'x' });
    });
  });

  describe('F2.5/P31 - teto de 50 mensagens no syncPainelInteraction', () => {
    it('deve persistir apenas as ultimas 50 mensagens quando a interacao ja existe', async () => {
      const existingMessages = Array.from({ length: 60 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `mensagem ${i}`,
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      mockPrisma.painel_interactions.findUnique.mockResolvedValue({
        session_id: 'conv-1',
        messages: existingMessages,
        total_tokens: 100,
        prompt_tokens: 60,
        completion_tokens: 40,
      });

      await service.send(buildDto());

      expect(mockPrisma.painel_interactions.upsert).toHaveBeenCalledTimes(1);
      const upsertCall = mockPrisma.painel_interactions.upsert.mock.calls[0][0];
      const persisted = upsertCall.update.messages;

      expect(persisted).toHaveLength(PAINEL_MESSAGES_LIMIT);
      // 60 antigas + 2 novas = 62 -> as 12 mais antigas sao descartadas
      expect(persisted[0].id).toBe('m12');
      // as novas mensagens do turno permanecem no fim do array
      expect(persisted[persisted.length - 1].role).toBe('assistant');
      expect(persisted[persisted.length - 1].content).toBe('Resposta da IA');
      // tokens continuam acumulando apesar do teto de mensagens
      expect(upsertCall.update.total_tokens).toBe(115);
    });

    it('nao deve reescrever a interacao quando nenhuma mensagem nova existe', async () => {
      const existingMessages = [
        { id: 'm1', role: 'user', content: 'oi', timestamp: 't1' },
        {
          id: 'm2',
          role: 'assistant',
          content: 'ola',
          tool_calls: [],
          timestamp: 't2',
        },
      ];
      mockPrisma.painel_interactions.findUnique.mockResolvedValue({
        session_id: 'conv-1',
        messages: existingMessages,
        total_tokens: 10,
      });

      await (service as any).syncPainelInteraction({
        companyId: 'company-1',
        clientId: 'client-1',
        sessionId: 'conv-1',
        channel: 'webchat_test',
      });

      expect(mockPrisma.painel_interactions.upsert).not.toHaveBeenCalled();
    });
  });

  describe('lock de conversa', () => {
    it('deve lancar ConflictException apos 2 tentativas rapidas (300ms) sem esperar 1,5s', async () => {
      jest.useFakeTimers();
      try {
        // Lock de identidade concede; lock da conversa nunca concede
        mockRedis.acquireLock.mockImplementation(async (key: string) =>
          key.includes('test-chat-identity'),
        );

        const startedAt = Date.now();
        const pending = service.send(buildDto());
        const assertion = expect(pending).rejects.toBeInstanceOf(
          ConflictException,
        );
        await jest.advanceTimersByTimeAsync(600);
        await assertion;

        const conversationLockCalls = mockRedis.acquireLock.mock.calls.filter(
          ([key]) => key === CONVERSATION_LOCK_KEY,
        );
        // 1 tentativa inicial + 2 retries de 300ms
        expect(conversationLockCalls).toHaveLength(3);
        expect(Date.now() - startedAt).toBeLessThan(1500);
      } finally {
        jest.useRealTimers();
      }
    });

    it('deve lancar ConflictException com a mensagem de contrato atual', async () => {
      jest.useFakeTimers();
      try {
        mockRedis.acquireLock.mockImplementation(async (key: string) =>
          key.includes('test-chat-identity'),
        );

        const pending = service.send(buildDto());
        const assertion = expect(pending).rejects.toThrow(
          'Conversa em processamento. Tente novamente em instantes.',
        );
        await jest.advanceTimersByTimeAsync(600);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
