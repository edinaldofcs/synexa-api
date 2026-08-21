import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { encrypt } from '../common/utils/crypto.util';

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
  const configService = {
    get: jest.fn().mockReturnValue('12345678901234567890123456789012'),
  };
  const credentialAuditService = {
    logAction: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
    provider_credentials: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'cred-1' }),
      update: jest.fn().mockResolvedValue({ id: 'cred-1' }),
    },
    painel_subagents: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'sub-new' }),
    },
  };
  const service = new ClientsService(
    clientsRepository as never,
    agentsRepository as never,
    intentionsRepository as never,
    apisRepository as never,
    metadata as never,
    prisma as never,
    configService as never,
    credentialAuditService as never,
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

  it('duplicates agents, intentions, apis, subagents and remaps next_api_id', async () => {
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

    prisma.painel_subagents.findMany.mockResolvedValue([
      {
        id: 'sub-1',
        client_id: 'client-old',
        name: 'Especialista',
        system_prompt: 'Prompt',
      },
    ]);

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
    expect(prisma.painel_subagents.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        client_id: 'client-new',
        name: 'Especialista',
        system_prompt: 'Prompt',
      }),
    });
    expect(metadata.refresh).toHaveBeenCalledWith('client-new');
  });

  it('fails duplicate when source client cannot be copied', async () => {
    clientsRepository.findOne.mockResolvedValue({
      id: 'client-old',
      company_id: companyId,
    });
    clientsRepository.duplicate.mockResolvedValue(null);

    await expect(
      service.duplicate('client-old', userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('retorna configuração de LLM mascarada e grava auditoria de visualização', async () => {
    const rawKey = 'gsk_1234567890abcdef';
    const encKey = `enc:${encrypt(rawKey, '12345678901234567890123456789012')}`;

    prisma.provider_credentials.findMany.mockResolvedValue([
      {
        provider: 'groq',
        api_key_enc: encKey,
        enabled_models: ['llama-3.3-70b-versatile'],
        health_status: 'healthy',
        last_tested_at: new Date('2026-08-16T12:00:00Z'),
        last_used_at: new Date('2026-08-16T12:30:00Z'),
      },
    ]);
    clientsRepository.findOne.mockResolvedValue({
      id: 'client-1',
      metadata: {},
    });

    const result = await service.getLlmConfig('client-1', userId);

    expect(result.providers.groq).toBeDefined();
    expect(result.providers.groq.hasStoredKey).toBe(true);
    expect(result.providers.groq.apiKey).toBe('gsk_...cdef');
    expect(credentialAuditService.logAction).toHaveBeenCalledWith({
      companyId,
      clientId: 'client-1',
      userId,
      provider: 'all',
      action: 'viewed',
    });
  });

  it('salva nova chave em provider_credentials e registra auditoria created', async () => {
    clientsRepository.findOne.mockResolvedValue({
      id: 'client-1',
      metadata: {},
    });
    prisma.provider_credentials.findFirst.mockResolvedValue(null);

    await service.saveLlmConfig(
      'client-1',
      {
        providers: {
          gemini: {
            apiKey: 'AIzaSySampleKey12345',
            enabledModels: ['gemini-2.5-flash'],
          },
        },
      } as any,
      userId,
    );

    expect(prisma.provider_credentials.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          client_id_provider_label: {
            client_id: 'client-1',
            provider: 'gemini',
            label: 'default',
          },
        },
      }),
    );
    expect(credentialAuditService.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        action: 'created',
      }),
    );
  });
});
