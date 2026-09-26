import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClientsService } from './clients.service';
import { encrypt } from '../common/utils/crypto.util';

describe('ClientsService', () => {
  const clientsRepository = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const duplication = { duplicate: jest.fn(), preview: jest.fn() };
  const metadata = { refresh: jest.fn() };
  const configService = {
    get: jest.fn().mockReturnValue('12345678901234567890123456789012'),
  };
  const credentialAuditService = {
    logAction: jest.fn().mockResolvedValue(undefined),
  };
  const telephonyResolver = {
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    painel_clients: { findUnique: jest.fn(), findMany: jest.fn() },
    telephony_endpoints: {
      upsert: jest.fn().mockResolvedValue({ id: 'ep-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ id: 'ep-1' }),
    },
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
    duplication as never,
    metadata as never,
    prisma as never,
    configService as never,
    credentialAuditService as never,
    telephonyResolver as never,
  );

  const userId = 'user-1';
  const companyId = 'company-1';

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.painel_clients.findUnique.mockResolvedValue({
      company_id: companyId,
    });
  });

  it('creates a client using the company from the user', async () => {
    clientsRepository.create.mockResolvedValue({ id: 'client-1' });

    await expect(
      service.create(
        { user_id: 'user-1', company_name: 'ACME' } as any,
        'company-1',
      ),
    ).resolves.toEqual({
      id: 'client-1',
      sip_extension: null,
      test_sip_extension: null,
      telephony_provider: 'audiosocket',
      audio_format: 'g711_ulaw',
    });

    expect(clientsRepository.create).toHaveBeenCalledWith({
      company_id: 'company-1',
      company_name: 'ACME',
      metadata: {},
    });
    expect(metadata.refresh).toHaveBeenCalledWith('client-1');
  });

  it('creates a client with sip_extension and provisions telephony_endpoints', async () => {
    clientsRepository.create.mockResolvedValue({
      id: 'client-2',
      company_name: 'ACME 2',
      agent_name: 'Ana',
    });

    await expect(
      service.create(
        {
          user_id: 'user-1',
          company_name: 'ACME 2',
          agent_name: 'Ana',
          sip_extension: '2000',
          telephony_provider: 'audiosocket',
        } as any,
        'company-1',
      ),
    ).resolves.toEqual({
      id: 'client-2',
      company_name: 'ACME 2',
      agent_name: 'Ana',
      sip_extension: '2000',
      test_sip_extension: null,
      telephony_provider: 'audiosocket',
      audio_format: 'g711_ulaw',
    });

    expect(prisma.telephony_endpoints.upsert).toHaveBeenCalledWith({
      where: {
        did_number_provider: {
          did_number: '2000',
          provider: 'audiosocket',
        },
      },
      create: {
        company_id: 'company-1',
        client_id: 'client-2',
        provider: 'audiosocket',
        did_number: '2000',
        label: 'Ramal 2000 - ACME 2',
        audio_format: 'g711_ulaw',
        enabled: true,
      },
      update: {
        company_id: 'company-1',
        client_id: 'client-2',
        label: 'Ramal 2000 - ACME 2',
        enabled: true,
        audio_format: 'g711_ulaw',
        updated_at: expect.any(Date),
      },
    });
    expect(telephonyResolver.invalidate).toHaveBeenCalledWith('2000');
  });

  it('rejects client creation when user has no company', async () => {
    await expect(
      service.create({ user_id: 'missing' } as any, null as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects creation when sip_extension DID belongs to another company (409)', async () => {
    clientsRepository.create.mockResolvedValue({
      id: 'client-3',
      company_name: 'ACME 3',
    });
    prisma.$queryRaw.mockResolvedValue([{ company_id: 'other-company' }]);

    await expect(
      service.create(
        {
          user_id: 'user-1',
          company_name: 'ACME 3',
          sip_extension: '2000',
          telephony_provider: 'audiosocket',
        } as any,
        companyId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.telephony_endpoints.upsert).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      expect.anything() as unknown as Prisma.Sql,
    );
  });

  it('allows DID reuse by the owning company', async () => {
    clientsRepository.create.mockResolvedValue({
      id: 'client-4',
      company_name: 'ACME 4',
    });
    prisma.$queryRaw.mockResolvedValue([{ company_id: companyId }]);

    await service.create(
      {
        user_id: 'user-1',
        sip_extension: '3000',
      } as any,
      companyId,
    );

    expect(prisma.telephony_endpoints.upsert).toHaveBeenCalled();
  });

  it('rejects update when target DID belongs to another company', async () => {
    clientsRepository.update.mockResolvedValue({ id: 'client-1' });
    clientsRepository.findOne.mockResolvedValue({
      id: 'client-1',
      company_id: companyId,
    });
    prisma.telephony_endpoints.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ company_id: 'other-company' }]);

    await expect(
      service.update(
        'client-1',
        { sip_extension: '3000', telephony_provider: 'audiosocket' } as any,
        companyId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.telephony_endpoints.upsert).not.toHaveBeenCalled();
  });

  it('delegates duplication to the transactional flow copier', async () => {
    const actor = { id: userId, company_id: companyId, role: 'company_admin' };
    const dto = { company_name: 'Copy' };
    duplication.duplicate.mockResolvedValue({ id: 'new' });
    await expect(service.duplicate('source', dto, actor)).resolves.toEqual({
      id: 'new',
    });
    expect(duplication.duplicate).toHaveBeenCalledWith('source', dto, actor);
  });

  it('propagates duplication failures without falling back to a partial copy', async () => {
    duplication.duplicate.mockRejectedValue(new ConflictException());
    await expect(
      service.duplicate('source', {}, { id: userId, company_id: companyId }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(clientsRepository.create).not.toHaveBeenCalled();
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

    const result = await service.getLlmConfig('client-1', companyId, userId);

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
      companyId,
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

  describe('remove', () => {
    it('permite a platform_admin deletar cliente mesmo de outra empresa e invalida ramal', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'client-global-1' }]);
      prisma.telephony_endpoints.findMany.mockResolvedValueOnce([
        { did_number: '1001' },
      ]);
      clientsRepository.remove.mockResolvedValueOnce({ success: true });

      const result = await service.remove(
        'client-global-1',
        'outra-company',
        'platform_admin',
      );

      expect(result).toEqual({ success: true });
      expect(telephonyResolver.invalidate).toHaveBeenCalledWith('1001');
      expect(clientsRepository.remove).toHaveBeenCalledWith('client-global-1');
    });

    it('permite usuário da própria empresa deletar cliente', async () => {
      prisma.painel_clients.findUnique.mockResolvedValueOnce({
        company_id: companyId,
      });
      prisma.telephony_endpoints.findMany.mockResolvedValueOnce([]);
      clientsRepository.remove.mockResolvedValueOnce({ success: true });

      const result = await service.remove(
        'client-1',
        companyId,
        'company_admin',
      );

      expect(result).toEqual({ success: true });
      expect(clientsRepository.remove).toHaveBeenCalledWith('client-1');
    });

    it('impede deleção se cliente pertencer a outra empresa', async () => {
      prisma.painel_clients.findUnique.mockResolvedValueOnce({
        company_id: 'empresa-estranha',
      });

      await expect(
        service.remove('client-1', companyId, 'company_admin'),
      ).rejects.toThrow();
      expect(clientsRepository.remove).not.toHaveBeenCalled();
    });
  });

  describe('findAllGlobal', () => {
    it('não muta company_name e expõe company_label separado (regressão do sufixo duplicado)', async () => {
      prisma.painel_clients.findMany.mockResolvedValueOnce([
        {
          id: 'client-1',
          company_name: 'Cliente Teste',
          agent_name: 'Maria',
          metadata: {},
          companies: { id: 'company-1', name: 'Synexa Admin' },
          telephony_endpoints: [],
        },
      ]);

      const result = await service.findAllGlobal();

      // company_name deve vir EXATAMENTE como está no banco: o sufixo
      // " (Empresa)" era absorvido pelo formData do painel e persistido
      // a cada save, crescendo "(Synexa Admin) (Synexa Admin)..."
      expect(result[0].company_name).toBe('Cliente Teste');
      expect(result[0].company_label).toBe('Synexa Admin');
      expect(String(result[0].company_name)).not.toContain('(Synexa Admin)');
    });
  });
});
