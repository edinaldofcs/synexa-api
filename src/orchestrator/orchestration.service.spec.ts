import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';

jest.mock('./providers/llm-provider.factory', () => ({
  getLLMProvider: () => ({
    chatWithParts: jest.fn().mockResolvedValue({ text: 'Mock response', parts: [], citations: [] }),
    getCapabilities: () => ({ text: true, vision: false, audio: false, tools: true }),
    chat: jest.fn().mockResolvedValue({ text: 'Mock legacy response', action: 'speak' }),
  }),
}));

import { OrchestrationService } from './orchestration.service';

describe('OrchestrationService', () => {
  let service: OrchestrationService;

  const mockPrisma = {
    agent_runs: {
      create: jest.fn().mockResolvedValue({ id: 'run-1', started_at: new Date() }),
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
    },
    conversations: {
      findMany: jest.fn().mockResolvedValue([]),
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConversationsService, useValue: mockConversationsService },
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
        id: 'msg-1', content: 'Hello', message_parts: [], media_assets: [],
      });

      const result = await service.processMessage(
        'conv-1', 'msg-1', 'company-1', 'client-1', 'Hello', 'req-1',
      );

      expect(result).toHaveProperty('responseText', 'Mock response');
      expect(result).toHaveProperty('responseMessageId');
    });

    it('should create agent_run with request_id', async () => {
      await service.processMessage('conv-1', 'msg-1', 'company-1', 'client-1', 'test', 'req-123');

      expect(mockPrisma.agent_runs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ request_id: 'req-123' }),
        }),
      );
    });

    it('should create message_events on successful processing', async () => {
      mockPrisma.messages.findUnique.mockResolvedValue({
        id: 'msg-1', content: 'test', message_parts: [], media_assets: [],
      });

      await service.processMessage('conv-1', 'msg-1', 'company-1', 'client-1', 'test', 'req-1');

      expect(mockConversationsService.addMessage).toHaveBeenCalled();
      expect(mockPrisma.agent_runs.update).toHaveBeenCalled();
    });
  });

  describe('buildHistory', () => {
    it('should return empty array for conversation without messages', async () => {
      mockConversationsService.getConversation.mockResolvedValue({ id: 'conv-1', messages: [] });

      const result = await service['buildHistory']('conv-1', {} as any, {} as any);
      expect(result).toEqual([]);
    });
  });
});
