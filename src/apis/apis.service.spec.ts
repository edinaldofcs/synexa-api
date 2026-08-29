import { NotFoundException } from '@nestjs/common';
import { ApisService } from './apis.service';

describe('ApisService', () => {
  const mockRepository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const mockMetadata = { refresh: jest.fn() };
  const mockPrisma = {
    painel_clients: { findUnique: jest.fn() },
  };

  let service: ApisService;
  const companyId = 'company-1';
  const clientId = 'client-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ApisService(
      mockRepository as never,
      mockMetadata as never,
      mockPrisma as never,
    );

    mockPrisma.painel_clients.findUnique.mockResolvedValue({
      id: clientId,
      company_id: companyId,
    });
  });

  describe('Tenant security', () => {
    it('rejeita findOne se a API pertencer a cliente de outra empresa', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'api-1',
        client_id: 'client-other',
      });
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-other',
      });

      await expect(service.findOne('api-1', companyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('CRUD operations & metadata refresh', () => {
    it('cria ferramenta e atualiza cache de metadados do cliente', async () => {
      mockRepository.create.mockResolvedValue({
        id: 'api-1',
        client_id: clientId,
        name: 'Buscar CEP',
      });

      const result = await service.create(
        clientId,
        {
          name: 'Buscar CEP',
          method: 'GET',
          url: 'https://viacep.com.br',
        } as any,
        companyId,
      );

      expect(result.id).toBe('api-1');
      expect(mockRepository.create).toHaveBeenCalledWith(
        clientId,
        expect.objectContaining({ name: 'Buscar CEP' }),
      );
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });

    it('atualiza ferramenta e atualiza cache de metadados', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'api-1',
        client_id: clientId,
      });
      mockRepository.update.mockResolvedValue({
        id: 'api-1',
        client_id: clientId,
        name: 'Buscar CEP v2',
      });

      const result = await service.update(
        'api-1',
        { name: 'Buscar CEP v2' } as any,
        companyId,
      );

      expect(result.name).toBe('Buscar CEP v2');
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });

    it('remove ferramenta e atualiza cache de metadados', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'api-1',
        client_id: clientId,
      });
      mockRepository.remove.mockResolvedValue({
        api: { client_id: clientId },
        result: { success: true },
      });

      const result = await service.remove('api-1', companyId);

      expect(result).toEqual({ success: true });
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });
  });
});
