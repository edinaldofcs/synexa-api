import { IntentionsService } from './intentions.service';

describe('IntentionsService', () => {
  const repository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
  };
  const service = new IntentionsService(
    repository as never,
    prisma as never,
  );

  const userId = 'user-1';
  const companyId = 'company-1';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.users.findUnique.mockResolvedValue({ company_id: companyId });
    prisma.painel_clients.findUnique.mockResolvedValue({ company_id: companyId });
  });

  it('delegates CRUD operations to the repository', async () => {
    repository.findOne.mockResolvedValue({
      id: 'intention-1',
      client_id: 'client-1',
    });
    repository.create.mockResolvedValue({ id: 'intention-1' });
    repository.findAllByClient.mockResolvedValue([]);
    repository.update.mockResolvedValue({
      id: 'intention-1',
      is_active: false,
    });
    repository.remove.mockResolvedValue({ success: true });

    await expect(
      service.create('client-1', { code: 'hello', description: 'Hello' }, userId),
    ).resolves.toEqual({ id: 'intention-1' });
    await service.findAllByClient('client-1', userId);
    await service.findOne('intention-1', userId);
    await service.update('intention-1', { is_active: false }, userId);
    await service.remove('intention-1', userId);

    expect(repository.create).toHaveBeenCalledWith('client-1', {
      code: 'hello',
      description: 'Hello',
    });
    expect(repository.findAllByClient).toHaveBeenCalledWith('client-1');
    expect(repository.findOne).toHaveBeenCalledWith('intention-1');
    expect(repository.update).toHaveBeenCalledWith('intention-1', {
      is_active: false,
    });
    expect(repository.remove).toHaveBeenCalledWith('intention-1');
  });
});
