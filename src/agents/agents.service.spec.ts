import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentsService } from './agents.service';

describe('AgentsService', () => {
  const mockRepository = {
    create: jest.fn(),
    findAllByClient: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const mockMetadata = { refresh: jest.fn() };
  const mockPrisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn() },
    painel_agents: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };

  let service: AgentsService;
  const userId = 'user-1';
  const companyId = 'company-1';
  const clientId = 'client-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentsService(
      mockRepository as never,
      mockMetadata as never,
      mockPrisma as never,
    );

    mockPrisma.users.findUnique.mockResolvedValue({ company_id: companyId });
    mockPrisma.painel_clients.findUnique.mockResolvedValue({
      id: clientId,
      company_id: companyId,
    });
  });

  describe('Tenant security', () => {
    it('rejeita criação quando usuário não tem empresa', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);

      await expect(
        service.create(clientId, { model: 'gpt-4o' }, userId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejeita criação para cliente de outra empresa', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'other-company',
      });

      await expect(
        service.create(clientId, { model: 'gpt-4o' }, userId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Agent creation & initial uniqueness', () => {
    it('cria agente e desmarca outros agentes como inicial quando is_initial é true', async () => {
      mockRepository.create.mockResolvedValue({
        id: 'agent-1',
        client_id: clientId,
        is_initial: true,
        transitions: { llm_provider: 'gemini' },
      });

      const agent = await service.create(
        clientId,
        { model: 'gemini-2.5-flash', is_initial: true, llm_provider: 'gemini' },
        userId,
      );

      expect(agent.id).toBe('agent-1');
      expect(agent.llm_provider).toBe('gemini');
      expect(mockPrisma.painel_agents.updateMany).toHaveBeenCalledWith({
        where: {
          client_id: clientId,
          is_initial: true,
          id: { not: 'agent-1' },
        },
        data: { is_initial: false },
      });
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });
  });

  describe('Mutations & Metadata Refresh', () => {
    it('atualiza agente e atualiza cache de metadados do cliente', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'agent-1',
        client_id: clientId,
      });
      mockRepository.update.mockResolvedValue({
        id: 'agent-1',
        client_id: clientId,
        execution_order: 2,
        transitions: {},
      });

      const updated = await service.update(
        'agent-1',
        { execution_order: 2 },
        userId,
      );

      expect(updated.id).toBe('agent-1');
      expect(mockRepository.update).toHaveBeenCalledWith('agent-1', {
        execution_order: 2,
        transitions: {},
      });
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });

    it('remove agente e atualiza cache de metadados', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'agent-1',
        client_id: clientId,
      });
      mockRepository.remove.mockResolvedValue({
        agent: { client_id: clientId },
        result: { success: true },
      });

      const result = await service.remove('agent-1', userId);

      expect(result).toEqual({ success: true });
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });
  });
});
