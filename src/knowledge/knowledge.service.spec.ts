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

describe('KnowledgeService tenant relationships', () => {
  const base = { id: 'base', company_id: 'company', client_id: 'client' };
  const db = {
    painel_clients: {
      findUnique: jest.fn().mockResolvedValue({ company_id: 'company' }),
    },
    knowledge_bases: { findUnique: jest.fn().mockResolvedValue(base) },
    knowledge_documents: { create: jest.fn().mockResolvedValue({ id: 'doc' }) },
    media_assets: { findFirst: jest.fn() },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  const queue = { addKnowledgeJob: jest.fn() };
  const service = new KnowledgeService(
    db as any,
    queue as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const asTenant = (action: () => Promise<unknown>) =>
    tenantLocalStorage.run(
      { userId: 'user', companyId: 'company', role: 'company_admin' },
      action,
    );

  beforeEach(() => jest.clearAllMocks());

  it('rejects a foreign media reference before persistence or enqueue', async () => {
    db.media_assets.findFirst.mockResolvedValue(null);
    await expect(
      asTenant(() =>
        service.createDocument(
          'base',
          { title: 'Doc', content: 'text', media_asset_id: 'foreign' },
          'user',
        ),
      ),
    ).rejects.toThrow('Media asset not found');
    expect(db.knowledge_documents.create).not.toHaveBeenCalled();
    expect(queue.addKnowledgeJob).not.toHaveBeenCalled();
    expect(db.media_assets.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', company_id: 'company', client_id: 'client' },
      select: { id: true },
    });
  });

  it('accepts media belonging to the same company and client', async () => {
    db.media_assets.findFirst.mockResolvedValue({ id: 'own-media' });
    await asTenant(() =>
      service.createDocument(
        'base',
        { title: 'Doc', content: 'text', media_asset_id: 'own-media' },
        'user',
      ),
    );
    expect(db.knowledge_documents.create).toHaveBeenCalled();
    expect(queue.addKnowledgeJob).toHaveBeenCalledWith({ document_id: 'doc' });
  });

  it('binds the authorized company to vector SQL and checks parent ownership', async () => {
    jest.spyOn(service as any, 'createEmbedding').mockResolvedValue([0.1]);
    await asTenant(() =>
      service.search('base', { query: 'text', limit: 5 }, 'user'),
    );
    const [sql, , baseId, clientId, , companyId] =
      db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('ke.company_id = $5::uuid');
    expect(sql).toContain('kd.company_id = kc.company_id');
    expect([baseId, clientId, companyId]).toEqual([
      'base',
      'client',
      'company',
    ]);
  });
});
