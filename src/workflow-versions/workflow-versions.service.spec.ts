import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { WorkflowVersionsService } from './workflow-versions.service';

describe('WorkflowVersionsService', () => {
  const mockPrisma = {
    users: { findUnique: jest.fn() },
    painel_clients: { findUnique: jest.fn(), update: jest.fn() },
    painel_agents: { findMany: jest.fn() },
    painel_subagents: { findMany: jest.fn() },
    painel_apis: { findMany: jest.fn() },
    painel_intentions: { findMany: jest.fn() },
    workflow_versions: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const metadata = { refresh: jest.fn() };
  let service: WorkflowVersionsService;

  const companyId = 'company-1';
  const clientId = 'client-1';
  const userId = 'user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WorkflowVersionsService(mockPrisma as never, metadata as never);

    mockPrisma.users.findUnique.mockResolvedValue({ company_id: companyId });
    mockPrisma.painel_clients.findUnique.mockResolvedValue({
      id: clientId,
      company_id: companyId,
      metadata: {},
    });
    mockPrisma.painel_agents.findMany.mockResolvedValue([]);
    mockPrisma.painel_subagents.findMany.mockResolvedValue([]);
    mockPrisma.painel_apis.findMany.mockResolvedValue([]);
    mockPrisma.painel_intentions.findMany.mockResolvedValue([]);
  });

  describe('Tenant isolation & validation', () => {
    it('rejeita usuário sem empresa vinculada', async () => {
      mockPrisma.users.findUnique.mockResolvedValue(null);

      await expect(service.list(clientId, userId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejeita cliente pertencente a outra empresa', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        company_id: 'company-other',
      });

      await expect(service.list(clientId, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('não retorna versão pertencente a outro cliente', async () => {
      mockPrisma.workflow_versions.findUnique.mockResolvedValue({
        id: 'ver-2',
        client_id: 'client-other',
      });

      await expect(
        service.getById(clientId, 'ver-2', userId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Listing & Retrieval', () => {
    it('lista versões ordenadas por versão decrescente', async () => {
      mockPrisma.workflow_versions.findMany.mockResolvedValue([
        { id: 'v2', version: 2 },
        { id: 'v1', version: 1 },
      ]);

      const result = await service.list(clientId, userId);

      expect(result).toHaveLength(2);
      expect(mockPrisma.workflow_versions.findMany).toHaveBeenCalledWith({
        where: { client_id: clientId },
        orderBy: { version: 'desc' },
        take: 20,
      });
    });

    it('retorna rascunho ativo quando existente', async () => {
      mockPrisma.workflow_versions.findFirst.mockResolvedValue({
        id: 'draft-1',
        status: 'draft',
      });

      const draft = await service.getDraft(clientId, userId);

      expect(draft?.id).toBe('draft-1');
      expect(mockPrisma.workflow_versions.findFirst).toHaveBeenCalledWith({
        where: { client_id: clientId, status: 'draft' },
      });
    });

    it('retorna versão publicada atual', async () => {
      mockPrisma.workflow_versions.findFirst.mockResolvedValue({
        id: 'pub-1',
        status: 'published',
      });

      const pub = await service.getPublished(clientId, userId);

      expect(pub?.id).toBe('pub-1');
      expect(mockPrisma.workflow_versions.findFirst).toHaveBeenCalledWith({
        where: { client_id: clientId, status: 'published' },
        orderBy: { published_at: 'desc' },
      });
    });
  });

  describe('Snapshots & Diffing', () => {
    it('monta o snapshot completo das 4 entidades do cliente', async () => {
      mockPrisma.painel_agents.findMany.mockResolvedValue([
        { id: 'ag-1', model: 'gpt-4o', service_step: 'reception', execution_order: 1 },
      ]);
      mockPrisma.painel_subagents.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'analista', description: 'desc', system_prompt: 'prompt' },
      ]);
      mockPrisma.painel_apis.findMany.mockResolvedValue([
        { id: 'api-1', name: 'consulta', method: 'GET', url: 'https://api.com' },
      ]);
      mockPrisma.painel_intentions.findMany.mockResolvedValue([
        { id: 'int-1', code: 'saudacao', description: 'Oi' },
      ]);

      const snapshot = await service.buildCurrentSnapshot(clientId);

      expect(snapshot.agents).toHaveLength(1);
      expect(snapshot.agents[0].model).toBe('gpt-4o');
      expect(snapshot.subagents).toHaveLength(1);
      expect(snapshot.subagents[0].name).toBe('analista');
      expect(snapshot.apis).toHaveLength(1);
      expect(snapshot.intentions).toHaveLength(1);
    });

    it('calcula diff entre duas versões identificando adições e modificações', async () => {
      mockPrisma.workflow_versions.findUnique
        .mockResolvedValueOnce({
          id: 'v1',
          client_id: clientId,
          snapshot: {
            agents: [{ id: 'ag-1', model: 'gpt-4o-mini', service_step: 'reception', execution_order: 1 }],
            subagents: [],
            apis: [],
            intentions: [],
          },
        })
        .mockResolvedValueOnce({
          id: 'v2',
          client_id: clientId,
          snapshot: {
            agents: [{ id: 'ag-1', model: 'gpt-4o', service_step: 'reception', execution_order: 1 }],
            subagents: [{ id: 'sub-1', name: 'suporte', system_prompt: 'Prompt' }],
            apis: [],
            intentions: [],
          },
        });

      const diff = await service.diff(clientId, 'v1', 'v2', userId);

      expect(diff.hasChanges).toBe(true);
      expect(diff.agents.modified).toHaveLength(1);
      expect(diff.subagents.added).toHaveLength(1);
    });
  });

  describe('Version deletion rules', () => {
    it('impede a exclusão da única versão publicada em produção', async () => {
      mockPrisma.workflow_versions.findUnique.mockResolvedValue({
        id: 'pub-only',
        client_id: clientId,
        status: 'published',
      });
      mockPrisma.workflow_versions.count.mockResolvedValue(1);

      await expect(service.delete(clientId, 'pub-only', userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('permite a exclusão de rascunhos e versões arquivadas', async () => {
      mockPrisma.workflow_versions.findUnique.mockResolvedValue({
        id: 'draft-del',
        client_id: clientId,
        status: 'draft',
      });
      mockPrisma.workflow_versions.delete.mockResolvedValue({ id: 'draft-del' });

      const res = await service.delete(clientId, 'draft-del', userId);

      expect(res.id).toBe('draft-del');
      expect(mockPrisma.workflow_versions.delete).toHaveBeenCalledWith({
        where: { id: 'draft-del' },
      });
    });
  });

  describe('Save Current Editing', () => {
    it('salva alterações na versão de edição ativa do metadata', async () => {
      mockPrisma.painel_clients.findUnique.mockResolvedValue({
        id: clientId,
        company_id: companyId,
        metadata: { active_editing_version_id: 'v-edit-1' },
      });
      mockPrisma.workflow_versions.update.mockResolvedValue({
        id: 'v-edit-1',
        version: 3,
      });

      const result = await service.saveCurrentEditing(clientId, userId);

      expect(result.message).toContain('v3');
      expect(mockPrisma.workflow_versions.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'v-edit-1' },
        }),
      );
    });
  });
});
