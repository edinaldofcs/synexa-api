import { NotFoundException } from '@nestjs/common';
import { SubagentsService } from './subagents.service';

describe('SubagentsService', () => {
  const mockPrisma = {
    painel_clients: { findUnique: jest.fn() },
    painel_subagents: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  let service: SubagentsService;
  const companyId = 'company-1';
  const clientId = 'client-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SubagentsService(mockPrisma as never);

    mockPrisma.painel_clients.findUnique.mockResolvedValue({
      id: clientId,
      company_id: companyId,
    });
  });

  describe('Tenant security', () => {
    it('rejeita busca de subagente pertencente a outra empresa', async () => {
      mockPrisma.painel_subagents.findUnique.mockResolvedValue({
        id: 'sub-2',
        painel_clients: { company_id: 'company-other' },
      });

      await expect(service.findOne('sub-2', companyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('CRUD operations', () => {
    it('cria subagente normalizando o nome para identificador seguro em snake_case', async () => {
      mockPrisma.painel_subagents.create.mockResolvedValue({
        id: 'sub-1',
        client_id: clientId,
        name: 'especialista_tecnico',
      });

      const result = await service.create(
        clientId,
        {
          name: 'Especialista Tecnico ',
          description: 'Suporte avançado',
          system_prompt: 'Você é um especialista técnico.',
          llm_provider: 'gemini',
          model: 'gemini-2.5-flash',
          allowed_tool_names: ['exec_query'],
        },
        companyId,
      );

      expect(result.id).toBe('sub-1');
      expect(mockPrisma.painel_subagents.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          client_id: clientId,
          name: 'especialista_tecnico',
          llm_provider: 'gemini',
          model: 'gemini-2.5-flash',
          allowed_tool_names: ['exec_query'],
        }),
      });
    });

    it('atualiza subagente com sucesso após validar acesso', async () => {
      mockPrisma.painel_subagents.findUnique.mockResolvedValue({
        id: 'sub-1',
        painel_clients: { company_id: companyId },
      });
      mockPrisma.painel_subagents.update.mockResolvedValue({
        id: 'sub-1',
        name: 'novo_nome',
      });

      const result = await service.update(
        'sub-1',
        { name: 'Novo Nome' },
        companyId,
      );

      expect(result.name).toBe('novo_nome');
      expect(mockPrisma.painel_subagents.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({ name: 'novo_nome' }),
        }),
      );
    });

    it('remove subagente existente após validar acesso', async () => {
      mockPrisma.painel_subagents.findUnique.mockResolvedValue({
        id: 'sub-1',
        painel_clients: { company_id: companyId },
      });
      mockPrisma.painel_subagents.delete.mockResolvedValue({ id: 'sub-1' });

      const result = await service.remove('sub-1', companyId);

      expect(result).toEqual({ id: 'sub-1' });
      expect(mockPrisma.painel_subagents.delete).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
    });
  });
});
