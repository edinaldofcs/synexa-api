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
      painel_clients: {
        findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      tool_calls: {
        create: jest.fn().mockResolvedValue({ id: 'tc-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    service = new RagSearchService(
      prisma as unknown as PrismaService,
      {
        resolveApiKey: jest
          .fn()
          .mockImplementation(async (_client, provider) =>
            provider === 'openai' ? 'test-placeholder' : '',
          ),
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
      `rag:emb:company-1:client-1:${createHash('sha256').update('query teste').digest('hex')}`,
    );
    expect(mockedEmbeddingsCreate).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      '[0.1,0.2,0.3]',
      'client-1',
      ['kb-1'],
      5,
      'company-1',
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
      `rag:emb:company-1:client-1:${createHash('sha256').update('query nova').digest('hex')}`,
    );
    expect(redisSet).toHaveBeenCalledWith(
      `rag:emb:company-1:client-1:${createHash('sha256').update('query nova').digest('hex')}`,
      expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        embedding: '[0.1,0.2]',
      }),
      300,
    );
  });

  it('rejects another company client before provider resolution and SQL', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue(null);
    await expect(
      service.searchRag(
        baseAgentConfig,
        'query',
        'foreign-client',
        5,
        'run',
        'conv',
        'msg',
        'company-1',
      ),
    ).rejects.toThrow('Client not found');
    expect(mockedEmbeddingsCreate).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.tool_calls.create).not.toHaveBeenCalled();
  });

  it('scopes the vector query and textual fallback by company and parent relationships', async () => {
    mockedEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
    prisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (!sql.includes('ILIKE')) throw new Error('Vector unavailable');
      return [];
    });
    await service.searchRag(
      baseAgentConfig,
      'query',
      'client-1',
      5,
      'run',
      'conv',
      'msg',
      'company-1',
    );
    const queries = prisma.$queryRawUnsafe.mock.calls;
    expect(queries[0][0]).toContain('ke.company_id = $5::uuid');
    expect(queries[0][0]).toContain('kc.company_id = ke.company_id');
    expect(queries[0].slice(-1)[0]).toBe('company-1');
    const fallbackQuery = prisma.$queryRawUnsafe.mock.calls.find(
      ([sql]: [string]) => sql.includes('ILIKE'),
    );
    expect(fallbackQuery[0]).toContain('kc.company_id = $6::uuid');
    expect(fallbackQuery[0]).toContain('kd.company_id = kc.company_id');
    expect(fallbackQuery.slice(-1)[0]).toBe('company-1');
  });

  it('does not reuse embedding cache across companies or clients', async () => {
    mockedEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
    for (const [company, client] of [
      ['a', 'a1'],
      ['a', 'a2'],
      ['b', 'b1'],
    ]) {
      await service.searchRag(
        baseAgentConfig,
        'same query',
        client,
        5,
        'run',
        'conv',
        'msg',
        company,
      );
    }
    expect(new Set(redisGet.mock.calls.map(([key]) => key)).size).toBe(3);
  });
});
