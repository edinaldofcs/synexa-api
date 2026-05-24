import { AgentsService } from './agents.service';

describe('AgentsService', () => {
  const repository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const metadata = { refresh: jest.fn() };
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
  };
  const service = new AgentsService(
    repository as never,
    metadata as never,
    prisma as never,
  );

  const userId = 'user-1';
  const companyId = 'company-1';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.users.findUnique.mockResolvedValue({ company_id: companyId });
    prisma.painel_clients.findUnique.mockResolvedValue({ company_id: companyId });
  });

  it('refreshes client metadata after create/update/remove', async () => {
    repository.create.mockResolvedValue({
      id: 'agent-1',
      client_id: 'client-1',
    });
    repository.findOne.mockResolvedValue({ id: 'agent-1', client_id: 'client-1' });
    repository.update.mockResolvedValue({
      id: 'agent-1',
      client_id: 'client-1',
    });
    repository.remove.mockResolvedValue({
      agent: { client_id: 'client-1' },
      result: { success: true },
    });

    await service.create('client-1', { model: 'gpt-4o' }, userId);
    await service.update('agent-1', { execution_order: 2 }, userId);
    await service.remove('agent-1', userId);

    expect(metadata.refresh).toHaveBeenCalledTimes(3);
    expect(metadata.refresh).toHaveBeenCalledWith('client-1');
  });
});
