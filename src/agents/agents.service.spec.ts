import { NotFoundException } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';

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
    painel_clients: { findUnique: jest.fn() },
    painel_agents: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };

  let service: AgentsService;
  const companyId = 'company-1';
  const clientId = 'client-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentsService(
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
    it('não revela o prompt de um agente de outro cliente', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'foreign-agent',
        client_id: 'other-client',
        system_prompt: 'private',
      });
      await expect(
        service.previewPrompt(
          clientId,
          { agent_id: 'foreign-agent' },
          companyId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('permite a prévia de um agente do cliente autorizado', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'own-agent',
        client_id: clientId,
        system_prompt: 'Own prompt',
      });
      await expect(
        service.previewPrompt(clientId, { agent_id: 'own-agent' }, companyId),
      ).resolves.toEqual(
        expect.objectContaining({ resolved_prompt: expect.any(String) }),
      );
    });

    it('não consulta ferramentas de outro cliente usando um agente próprio', async () => {
      const executor = {
        loadAgentTools: jest.fn(),
        buildAgentConfigFromRecord: jest.fn(),
      };
      const agents = {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'agent', client_id: clientId }),
      };
      const controller = new AgentsController(agents as any, executor as any);
      await expect(
        controller.listAgentTools('other-client', 'agent', {
          company_id: companyId,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(executor.loadAgentTools).not.toHaveBeenCalled();
    });

    it('rejeita criação para cliente de outra empresa', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'other-company',
      });

      await expect(
        service.create(clientId, { model: 'gpt-4o' }, companyId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Agent creation & initial uniqueness', () => {
    it('carrega o catálogo de ferramentas do cliente do agente autorizado', async () => {
      const agent = {
        id: 'agent',
        client_id: clientId,
        allowed_tool_names: [],
        transitions: {},
      };
      const executor = {
        loadAgentTools: jest
          .fn()
          .mockResolvedValue({ apiTools: [], availableTools: [] }),
        buildAgentConfigFromRecord: jest.fn().mockReturnValue({}),
      };
      const controller = new AgentsController(
        { findOne: jest.fn().mockResolvedValue(agent) } as any,
        executor as any,
      );
      await expect(
        controller.listAgentTools(clientId, agent.id, {
          company_id: companyId,
        }),
      ).resolves.toEqual({
        agent_id: agent.id,
        tools: [],
        available_tool_names: [],
      });
      expect(executor.loadAgentTools).toHaveBeenCalledWith(
        expect.objectContaining({ clientId }),
      );
    });

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
        companyId,
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
        companyId,
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

      const result = await service.remove('agent-1', companyId);

      expect(result).toEqual({ success: true });
      expect(mockMetadata.refresh).toHaveBeenCalledWith(clientId);
    });
  });
});
