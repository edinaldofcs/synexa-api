import { createHash } from 'crypto';
import { RagSearchService } from './rag-search.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { ProviderKeyResolverService } from './provider-key-resolver.service';

jest.mock('openai', () => {
  const embeddingsCreate = jest.fn();
  class OpenAI {
    embeddings = { create: embeddingsCreate };
    constructor(_config?: any) {}
  }
  return {
    __esModule: true,
    default: OpenAI,
    __embeddingsCreate: embeddingsCreate,
  };
});

import OpenAI from 'openai';

const mockedEmbeddingsCreate = new (OpenAI as any)().embeddings
  .create as jest.Mock;

const baseAgentConfig = {
  agentId: 'agent-1',
  id: 'agent-1',
  allowed_knowledge_base_ids: ['kb-1'],
  capabilities: { rag: true },
} as any;

describe('RagSearchService - cache de embedding', () => {
  let service: RagSearchService;
  let prisma: any;
  const redisGet = jest.fn().mockResolvedValue(null);
  const redisSet = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    redisGet.mockResolvedValue(null);

    prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      tool_calls: {
        create: jest.fn().mockResolvedValue({ id: 'tc-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    service = new RagSearchService(
      prisma as unknown as PrismaService,
      {
        resolveApiKey: jest.fn().mockResolvedValue('api-key'),
      } as unknown as ProviderKeyResolverService,
      { get: redisGet, set: redisSet } as unknown as RedisService,
    );
  });

  it('usa o embedding cacheado por hash da query e não chama o provedor', async () => {
    const cached = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      embedding: '[0.1,0.2,0.3]',
    };
    redisGet.mockResolvedValue(cached);

    const results = await service.searchRag(
      baseAgentConfig,
      'query teste',
      'client-1',
      5,
      'run-1',
      'conv-1',
      'msg-1',
      'company-1',
    );

    expect(redisGet).toHaveBeenCalledWith(
      `rag:emb:${createHash('sha256').update('query teste').digest('hex')}`,
    );
    expect(mockedEmbeddingsCreate).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      '[0.1,0.2,0.3]',
      'client-1',
      ['kb-1'],
      5,
    );
    expect(prisma.tool_calls.update).toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('grava o embedding no cache quando não há cache (TTL 300s)', async () => {
    mockedEmbeddingsCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
    });

    await service.searchRag(
      baseAgentConfig,
      'query nova',
      'client-1',
      5,
      'run-1',
      'conv-1',
      'msg-1',
      'company-1',
    );

    expect(redisGet).toHaveBeenCalledWith(
      `rag:emb:${createHash('sha256').update('query nova').digest('hex')}`,
    );
    expect(redisSet).toHaveBeenCalledWith(
      `rag:emb:${createHash('sha256').update('query nova').digest('hex')}`,
      expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        embedding: '[0.1,0.2]',
      }),
      300,
    );
  });
});
