import { KnowledgeService } from './knowledge.service';
import { ConfigService } from '@nestjs/config';
import { tenantLocalStorage } from '../common/auth/tenant-context';

describe('KnowledgeService regressions', () => {
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: {
      findUnique: jest.fn().mockResolvedValue({ company_id: 'visited' }),
    },
    knowledge_bases: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const keys = { resolveApiKey: jest.fn() };
  let service: KnowledgeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new KnowledgeService(
      prisma as any,
      {} as any,
      new ConfigService({ ENVIRONMENT: 'production' }),
      {} as any,
      keys as any,
    );
  });
  it('routes OpenRouter credentials to OpenRouter with its model identifier', async () => {
    keys.resolveApiKey.mockImplementation(async (_id, provider) =>
      provider === 'openrouter' ? 'test-placeholder' : '',
    );
    const result = await (service as any).getOpenAIForClient('client');
    expect(result.client.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(result.model).toBe('openai/text-embedding-3-small');
  });
  it('batches inputs and restores provider response ordering', async () => {
    const create = jest.fn(async ({ input }) => ({
      data: input
        .map((text: string, index: number) => ({
          index,
          embedding: [Number(text)],
        }))
        .reverse(),
    }));
    jest.spyOn(service as any, 'getOpenAIForClient').mockResolvedValue({
      provider: 'openai',
      model: 'test',
      client: { embeddings: { create } },
    });
    const result = await (service as any).createEmbeddings(
      Array.from({ length: 65 }, (_, i) => String(i)),
      'client',
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.embeddings).toEqual(
      Array.from({ length: 65 }, (_, i) => [i]),
    );
  });
  it('lists knowledge using the impersonated company', async () => {
    await tenantLocalStorage.run(
      { userId: 'admin', companyId: 'visited', role: 'company_admin' },
      () => service.listBases('client', 'admin'),
    );
    expect(prisma.users.findUnique).not.toHaveBeenCalled();
    expect(prisma.knowledge_bases.findMany).toHaveBeenCalled();
  });
  it('does not replace old chunks when the embedding provider fails', async () => {
    const db = {
      knowledge_documents: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc',
          client_id: 'client',
          metadata: { raw_content: 'content' },
        }),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const subject = new KnowledgeService(
      db as any,
      {} as any,
      new ConfigService({ ENVIRONMENT: 'production' }),
      {} as any,
      keys as any,
    );
    jest
      .spyOn(subject as any, 'createEmbeddings')
      .mockRejectedValue(new Error('Provider unavailable'));
    await expect(subject.ingestDocument('doc')).rejects.toThrow(
      'Provider unavailable',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.knowledge_documents.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { status: 'failed', error_message: 'Provider unavailable' },
      }),
    );
  });
});
