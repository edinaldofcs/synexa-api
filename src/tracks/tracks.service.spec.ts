import { TracksService } from './tracks.service';

describe('TracksService', () => {
  const repository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const prisma = {
    painel_clients: { findUnique: jest.fn() },
    painel_agents: { findFirst: jest.fn() },
  };
  const service = new TracksService(repository as never, prisma as never);

  const companyId = 'company-1';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.painel_clients.findUnique.mockResolvedValue({
      company_id: companyId,
    });
  });

  it('delegates CRUD operations to the repository', async () => {
    repository.findOne.mockResolvedValue({
      id: 'track-1',
      client_id: 'client-1',
    });
    repository.create.mockResolvedValue({ id: 'track-1' });
    repository.findAllByClient.mockResolvedValue([]);
    repository.update.mockResolvedValue({
      id: 'track-1',
      is_active: false,
    });
    repository.remove.mockResolvedValue({ success: true });

    await expect(
      service.create(
        'client-1',
        { code: 'hello', label: 'Olá', description: 'Hello' },
        companyId,
      ),
    ).resolves.toEqual({ id: 'track-1' });
    await service.findAllByClient('client-1', companyId);
    await service.findOne('track-1', companyId);
    await service.update('track-1', { is_active: false }, companyId);
    await service.remove('track-1', companyId);

    expect(repository.create).toHaveBeenCalledWith('client-1', {
      code: 'hello',
      label: 'Olá',
      description: 'Hello',
    });
    expect(repository.findAllByClient).toHaveBeenCalledWith('client-1');
    expect(repository.findOne).toHaveBeenCalledWith('track-1');
    expect(repository.update).toHaveBeenCalledWith('track-1', {
      is_active: false,
    });
    expect(repository.remove).toHaveBeenCalledWith('track-1');
  });

  it('rejects access when client belongs to another company', async () => {
    prisma.painel_clients.findUnique.mockResolvedValue({
      company_id: 'other-company',
    });

    await expect(
      service.findAllByClient('client-1', companyId),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects linking a track to an agent outside its client on create and update', async () => {
    prisma.painel_agents.findFirst.mockResolvedValue(null);
    repository.findOne.mockResolvedValue({
      id: 'track-1',
      client_id: 'client-1',
    });
    await expect(
      service.create('client-1', { agent_id: 'foreign-agent' }, companyId),
    ).rejects.toThrow('Agente não encontrado');
    await expect(
      service.update('track-1', { agent_id: 'foreign-agent' }, companyId),
    ).rejects.toThrow('Agente não encontrado');
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(prisma.painel_agents.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-agent',
        client_id: 'client-1',
        painel_clients: { company_id: companyId },
      },
      select: { id: true },
    });
  });

  it('allows an agent of the same client and allows clearing the link', async () => {
    prisma.painel_agents.findFirst.mockResolvedValue({ id: 'own-agent' });
    repository.findOne.mockResolvedValue({
      id: 'track-1',
      client_id: 'client-1',
    });
    await service.update('track-1', { agent_id: 'own-agent' }, companyId);
    await service.update('track-1', { agent_id: null }, companyId);
    expect(repository.update).toHaveBeenLastCalledWith('track-1', {
      agent_id: null,
    });
    expect(prisma.painel_agents.findFirst).toHaveBeenCalledTimes(1);
  });
});
