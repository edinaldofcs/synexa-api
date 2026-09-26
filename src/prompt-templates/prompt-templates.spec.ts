import { PromptTemplatesService } from './prompt-templates.module';
describe('tenant prompt templates', () => {
  const prisma = {
    painel_clients: { findFirst: jest.fn() },
    prompt_templates: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const service = new PromptTemplatesService(prisma as any);
  beforeEach(() => jest.resetAllMocks());
  it('requires authentication even for global templates', async () => {
    await expect(service.list('')).rejects.toThrow();
    expect(prisma.prompt_templates.findMany).not.toHaveBeenCalled();
  });
  it('scopes global lists and deletions to the authenticated company', async () => {
    await service.list('company-a');
    expect(prisma.prompt_templates.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { company_id: 'company-a', scope: 'global' },
      }),
    );
    await service.remove('company-b', 'same-id');
    expect(prisma.prompt_templates.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 'company-b', scope: 'global', id: 'same-id' },
    });
  });
  it('rejects foreign clients before persistence', async () => {
    prisma.painel_clients.findFirst.mockResolvedValue(null);
    await expect(
      service.save('company-a', {
        id: 'id',
        clientId: 'foreign',
        title: 'T',
        category: 'custom',
        content: 'secret',
      }),
    ).rejects.toThrow();
    expect(prisma.prompt_templates.upsert).not.toHaveBeenCalled();
  });
  it('rejects import if the session switched companies after confirmation', async () => {
    await expect(
      service.save('company-b', {
        id: 'id',
        expectedCompanyId: 'company-a',
        title: 'T',
        category: 'custom',
        content: 'secret',
      }),
    ).rejects.toThrow();
    expect(prisma.prompt_templates.upsert).not.toHaveBeenCalled();
  });
  it('uses a company and scope compound key for idempotent import', async () => {
    await service.save('company-a', {
      id: 'legacy-id',
      title: 'T',
      category: 'custom',
      content: 'secret',
    });
    expect(prisma.prompt_templates.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          company_id_scope_id: {
            company_id: 'company-a',
            scope: 'global',
            id: 'legacy-id',
          },
        },
      }),
    );
  });
});
