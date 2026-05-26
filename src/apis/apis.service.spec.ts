import { ApisService } from './apis.service';

describe('ApisService', () => {
  const repository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    findAgentClientId: jest.fn(),
  };
  const metadata = { refresh: jest.fn() };
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
  };
  const service = new ApisService(
    repository as never,
    metadata as never,
    prisma as never,
  );

  const userId = 'user-1';
  const companyId = 'company-1';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.users.findUnique.mockResolvedValue({ company_id: companyId });
    prisma.painel_clients.findUnique.mockResolvedValue({
      company_id: companyId,
    });
  });

  it('refreshes owning client metadata after api mutations', async () => {
    repository.create.mockResolvedValue({ id: 'api-1', client_id: 'client-1' });
    repository.findOne.mockResolvedValue({
      id: 'api-1',
      client_id: 'client-1',
    });
    repository.update.mockResolvedValue({ id: 'api-1', client_id: 'client-1' });
    repository.remove.mockResolvedValue({
      api: { client_id: 'client-1' },
      result: { success: true },
    });

    await service.create(
      'client-1',
      {
        name: 'tool',
        method: 'GET',
        url: 'https://example.com',
      },
      userId,
    );
    await service.update('api-1', { name: 'tool-2' }, userId);
    await service.remove('api-1', userId);

    expect(metadata.refresh).toHaveBeenCalledTimes(3);
    expect(metadata.refresh).toHaveBeenCalledWith('client-1');
  });
});
