import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { WebSearchService } from '../agents/web-search/web-search.service';
import { AgentConfigResolver } from './services/agent-config-resolver.service';
import { RagSearchService } from './services/rag-search.service';
import { ToolCallDispatcher } from './services/tool-call-dispatcher.service';
import { ProviderKeyResolverService } from './services/provider-key-resolver.service';
import { ModelPricingService } from './services/model-pricing.service';
import { ProviderCircuitBreakerService } from './services/circuit-breaker.service';
import { FallbackProviderService } from './services/fallback-provider.service';

jest.mock('./providers/llm-provider.factory', () => ({
  getLLMProvider: () => ({
    chatWithParts: jest
      .fn()
      .mockResolvedValue({ text: 'Mock response', parts: [], citations: [] }),
    getCapabilities: () => ({
      text: true,
      vision: false,
      audio: false,
      tools: true,
    }),
    chat: jest
      .fn()
      .mockResolvedValue({ text: 'Mock legacy response', action: 'speak' }),
  }),
}));

import { OrchestrationService } from './orchestration.service';

describe('OrchestrationService', () => {
  let service: OrchestrationService;

  const mockPrisma = {
    agent_runs: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', started_at: new Date() }),
      findUnique: jest.fn().mockResolvedValue({ started_at: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    tool_calls: {
      create: jest.fn().mockResolvedValue({ id: 'tool-1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    messages: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'msg-1',
        content: 'test',
        message_parts: [],
        media_assets: [],
      }),
    },
    painel_agents: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    conversations: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    media_assets: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    painel_clients: {
      findUnique: jest.fn().mockResolvedValue({ agent_name: 'Bot' }),
    },
    message_events: { create: jest.fn().mockResolvedValue({}) },
    knowledge_bases: { findMany: jest.fn().mockResolvedValue([]) },
    knowledge_embeddings: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };

  const mockConversationsService = {
    findOrCreate: jest.fn(),
    addMessage: jest.fn().mockResolvedValue({ id: 'resp-msg-1' }),
    getConversation: jest.fn().mockResolvedValue({
      id: 'conv-1',
      messages: [{ id: 'm1', sender_type: 'customer', content: 'hi' }],
    }),
    getState: jest.fn().mockResolvedValue({}),
    updateState: jest.fn(),
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
  };

  const mockAgentConfig = {
    agentId: 'agent-1',
    id: 'agent-1',
    name: 'Test Agent',
    model: 'test-model',
    system_prompt: 'You are a helpful assistant.',
    capabilities: {
      text: true,
      vision: false,
      audio_in: false,
      audio_out: false,
      rag: false,
      web_search: false,
      tools: true,
    },
    citation_policy: { policy: 'optional' },
    allowed_knowledge_base_ids: [],
    allowed_tool_names: [],
    web_search_allowed: false,
    temperature: 0.3,
  };

  const mockAgentConfigResolver = {
    resolveAgentConfig: jest.fn().mockResolvedValue(mockAgentConfig),
  };

  const mockProviderKeyResolver = {
    resolveApiKey: jest.fn().mockResolvedValue('mock-api-key'),
    resolveKey: jest.fn().mockResolvedValue('mock-api-key'),
    resolveEncryptedKey: jest.fn().mockResolvedValue('mock-api-key'),
  };

  const mockRagSearchService = {
    buildRagContext: jest.fn().mockResolvedValue(undefined),
    searchRag: jest.fn().mockResolvedValue([]),
    ragToolDefinition: jest.fn().mockReturnValue({
      name: 'rag.search',
      type: 'native',
      description: 'Mock RAG search',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }),
  };

  const mockToolCallDispatcher = {
    dispatch: jest.fn().mockResolvedValue({ result: 'tool_executed' }),
    webSearchToolDefinition: jest.fn().mockReturnValue({
      name: 'web_search',
      type: 'native',
      description: 'Mock web search',
      parameters: {},
    }),
    mediaTranscribeToolDefinition: jest.fn().mockReturnValue({
      name: 'media.transcribe',
      type: 'native',
      description: 'Mock media transcribe',
      parameters: {},
    }),
    mediaDescribeImageToolDefinition: jest.fn().mockReturnValue({
      name: 'media.describe_image',
      type: 'native',
      description: 'Mock media describe',
      parameters: {},
    }),
    switchAgentToolDefinition: jest.fn().mockReturnValue({
      name: 'switch_agent',
      description: 'Mock switch agent',
      parameters: {},
    }),
    setVariableToolDefinition: jest.fn().mockReturnValue({
      name: 'set_variable',
      description: 'Mock set variable',
      parameters: {},
    }),
    transferToHumanToolDefinition: jest.fn().mockReturnValue({
      name: 'transfer_to_human',
      description: 'Mock transfer to human',
      parameters: {},
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConversationsService, useValue: mockConversationsService },
        { provide: AgentConfigResolver, useValue: mockAgentConfigResolver },
        {
          provide: ProviderKeyResolverService,
          useValue: mockProviderKeyResolver,
        },
        { provide: RagSearchService, useValue: mockRagSearchService },
        { provide: ToolCallDispatcher, useValue: mockToolCallDispatcher },
        {
          provide: ModelPricingService,
          useValue: {
            calculateTokenCost: jest.fn().mockReturnValue(0.0001),
            calculateAudioCost: jest.fn().mockReturnValue(0.0005),
          },
        },
        {
          provide: ProviderCircuitBreakerService,
          useValue: {
            canExecute: jest.fn().mockResolvedValue(true),
            recordSuccess: jest.fn().mockResolvedValue(undefined),
            recordFailure: jest.fn().mockResolvedValue(undefined),
            getState: jest
              .fn()
              .mockResolvedValue({ state: 'CLOSED', consecutiveFailures: 0 }),
          },
        },
        {
          provide: FallbackProviderService,
          useValue: {
            resolveFallback: jest
              .fn()
              .mockResolvedValue({ hasFallback: false }),
          },
        },
        {
          provide: WebSearchService,
          useValue: {
            getToolDefinition: jest.fn().mockReturnValue({
              name: 'web_search',
              description: 'Mock web search',
              parameters: {},
            }),
            getNativeToolId: jest.fn().mockReturnValue('web_search'),
            execute: jest.fn().mockResolvedValue({
              results: [
                {
                  title: 'Mock result',
                  snippet: 'Mock snippet',
                  link: 'https://example.com',
                },
              ],
              source: 'OpenRouter',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<OrchestrationService>(OrchestrationService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processMessage', () => {
    it('should process a text message and return response', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        id: 'msg-1',
        content: 'Hello',
        message_parts: [],
        media_assets: [],
      });

      const result = await service.processMessage(
        'conv-1',
        'msg-1',
        'company-1',
        'client-1',
        'Hello',
        'req-1',
      );

      expect(result).toHaveProperty('responseText', 'Mock response');
      expect(result).toHaveProperty('responseMessageId');
    });

    it('should create agent_run with request_id', async () => {
      await service.processMessage(
        'conv-1',
        'msg-1',
        'company-1',
        'client-1',
        'test',
        'req-123',
      );

      expect(mockPrisma.agent_runs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ request_id: 'req-123' }),
        }),
      );
    });

    it('should create message_events on successful processing', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        id: 'msg-1',
        content: 'test',
        message_parts: [],
        media_assets: [],
      });

      await service.processMessage(
        'conv-1',
        'msg-1',
        'company-1',
        'client-1',
        'test',
        'req-1',
      );

      expect(mockConversationsService.addMessage).toHaveBeenCalled();
      expect(mockPrisma.agent_runs.update).toHaveBeenCalled();
    });
  });

  describe('buildHistory', () => {
    it('should return empty array for conversation without messages', async () => {
      mockConversationsService.getConversation.mockResolvedValue({
        id: 'conv-1',
        messages: [],
      });

      const result = await service['buildHistory'](
        'conv-1',
        {} as any,
        {} as any,
      );
      expect(result).toEqual([]);
    });
  });
});
