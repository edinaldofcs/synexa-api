import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientsService } from './clients.service';

describe('ClientsService', () => {
  const clientsRepository = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    duplicate: jest.fn(),
  };
  const agentsRepository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
  };
  const intentionsRepository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
  };
  const apisRepository = {
    create: jest.fn(),
    update: jest.fn(),
    findAllByClient: jest.fn(),
  };
  const metadata = { refresh: jest.fn() };
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
  };
  const service = new ClientsService(
    clientsRepository as never,
    agentsRepository as never,
    intentionsRepository as never,
    apisRepository as never,
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

  it('creates a client using the company from the user', async () => {
    prisma.users.findUnique.mockResolvedValue({ company_id: 'company-1' });
    clientsRepository.create.mockResolvedValue({ id: 'client-1' });

    await expect(
      service.create({ user_id: 'user-1', company_name: 'ACME' }),
    ).resolves.toEqual({ id: 'client-1' });

    expect(clientsRepository.create).toHaveBeenCalledWith({
      company_id: 'company-1',
      company_name: 'ACME',
    });
    expect(metadata.refresh).toHaveBeenCalledWith('client-1');
  });

  it('rejects client creation when user has no company', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    await expect(service.create({ user_id: 'missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('duplicates agents, intentions, apis and remaps next_api_id', async () => {
    clientsRepository.findOne.mockResolvedValue({
      id: 'client-old',
      company_id: companyId,
      company_name: 'ACME',
      agent_name: 'Bot',
    });
    clientsRepository.duplicate.mockResolvedValue({ id: 'client-new' });
    agentsRepository.findAllByClient.mockResolvedValue([
      { id: 'agent-old', client_id: 'client-old', model: 'gpt-4o' },
    ]);
    agentsRepository.create.mockResolvedValue({ id: 'agent-new' });
    intentionsRepository.findAllByClient.mockResolvedValue([
      { id: 'intention-old', client_id: 'client-old', code: 'hello' },
    ]);
    apisRepository.findAllByClient.mockResolvedValue([
      {
        id: 'api-old',
        agent_id: 'agent-old',
        name: 'first',
        next_api_id: 'api-next',
      },
      {
        id: 'api-next',
        agent_id: 'agent-old',
        name: 'next',
        next_api_id: null,
      },
    ]);
    apisRepository.create
      .mockResolvedValueOnce({ id: 'api-new' })
      .mockResolvedValueOnce({ id: 'api-next-new' });

    await expect(service.duplicate('client-old', userId)).resolves.toEqual({
      id: 'client-new',
    });

    expect(agentsRepository.create).toHaveBeenCalledWith('client-new', {
      model: 'gpt-4o',
    });
    expect(intentionsRepository.create).toHaveBeenCalledWith('client-new', {
      code: 'hello',
    });
    expect(apisRepository.update).toHaveBeenCalledWith('api-new', {
      next_api_id: 'api-next-new',
    });
    expect(metadata.refresh).toHaveBeenCalledWith('client-new');
  });

  it('fails duplicate when source client cannot be copied', async () => {
    clientsRepository.findOne.mockResolvedValue({ id: 'client-old', company_id: companyId });
    clientsRepository.duplicate.mockResolvedValue(null);

    await expect(service.duplicate('client-old', userId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
