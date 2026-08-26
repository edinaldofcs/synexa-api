import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import type {
  WorkflowSnapshot,
  WorkflowDiffResult,
  DiffItem,
} from './types/workflow-version.types';
import {
  PublishVersionDto,
  RollbackVersionDto,
  CreateSnapshotDto,
  UpdateVersionDto,
} from './dto/workflow-version.dto';

const MAX_VERSIONS_PER_CLIENT = 20;

@Injectable()
export class WorkflowVersionsService {
  private readonly logger = new Logger(WorkflowVersionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metadataService: ClientMetadataService,
  ) {}

  private async getUserCompanyId(userId: string): Promise<string> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) {
      throw new ForbiddenException('Usuário sem empresa vinculada');
    }
    return user.company_id;
  }

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException('Cliente não encontrado');
    }
  }

  async list(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    return this.prisma.workflow_versions.findMany({
      where: { client_id: clientId },
      orderBy: { version: 'desc' },
      take: MAX_VERSIONS_PER_CLIENT,
    });
  }

  async getDraft(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    return this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId, status: 'draft' },
    });
  }

  async getPublished(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    return this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId, status: 'published' },
      orderBy: { published_at: 'desc' },
    });
  }

  async getById(clientId: string, versionId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const version = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!version || version.client_id !== clientId) {
      throw new NotFoundException('Versão de workflow não encontrada');
    }

    return version;
  }

  async delete(clientId: string, versionId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const version = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!version || version.client_id !== clientId) {
      throw new NotFoundException('Versão de workflow não encontrada');
    }

    if (version.status === 'published') {
      const publishedCount = await this.prisma.workflow_versions.count({
        where: { client_id: clientId, status: 'published' },
      });
      if (publishedCount <= 1) {
        throw new BadRequestException(
          'Não é possível excluir a única versão ativa em produção. Publique ou restaure outra versão antes de excluir esta.',
        );
      }
    }

    return this.prisma.workflow_versions.delete({
      where: { id: versionId },
    });
  }

  async update(
    clientId: string,
    versionId: string,
    dto: UpdateVersionDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const version = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!version || version.client_id !== clientId) {
      throw new NotFoundException('Versão de workflow não encontrada');
    }

    let nextSnapshot = version.snapshot;
    if (dto.captureCurrentState) {
      nextSnapshot = (await this.buildCurrentSnapshot(clientId)) as any;
    } else if (dto.snapshot) {
      nextSnapshot = dto.snapshot;
    }

    const updated = await this.prisma.workflow_versions.update({
      where: { id: versionId },
      data: {
        description:
          dto.description !== undefined ? dto.description : version.description,
        base_version:
          dto.baseVersion !== undefined
            ? dto.baseVersion
            : (version as any).base_version,
        snapshot: nextSnapshot as any,
      },
    });

    // Gravar no metadata do cliente como a versão em edição ativa
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
    });
    const currentMeta = (client?.metadata as any) || {};
    await this.prisma.painel_clients.update({
      where: { id: clientId },
      data: {
        metadata: {
          ...currentMeta,
          active_editing_version_id: updated.id,
          active_editing_version_number: updated.version,
        },
      },
    });

    // Se a versão atualizada for a que está ativa em produção e o snapshot mudou, sincroniza as tabelas e cache
    if (
      version.status === 'published' &&
      (dto.captureCurrentState || dto.snapshot)
    ) {
      await this.applySnapshotInTransaction(
        clientId,
        nextSnapshot as any,
        this.prisma,
      );
      void this.metadataService.refresh(clientId);
    }

    return updated;
  }

  async activate(clientId: string, versionId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const targetVersion = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!targetVersion || targetVersion.client_id !== clientId) {
      throw new NotFoundException('Versão a ser ativada não encontrada');
    }

    const snapshot = targetVersion.snapshot as unknown as WorkflowSnapshot;

    return this.prisma.$transaction(async (tx) => {
      // 1. Arquivar qualquer versão publicada anterior
      await tx.workflow_versions.updateMany({
        where: {
          client_id: clientId,
          status: 'published',
        },
        data: {
          status: 'archived',
        },
      });

      // 2. Marcar a versão alvo como publicada diretamente (sem criar nova versão)
      const activated = await tx.workflow_versions.update({
        where: { id: targetVersion.id },
        data: {
          status: 'published',
          published_at: new Date(),
          published_by: userId,
        },
      });

      // 3. Gravar no metadata do cliente que a versão ativa em edição é esta ativada
      const client = await tx.painel_clients.findUnique({
        where: { id: clientId },
      });
      const currentMeta = (client?.metadata as any) || {};
      await tx.painel_clients.update({
        where: { id: clientId },
        data: {
          metadata: {
            ...currentMeta,
            active_editing_version_id: activated.id,
            active_editing_version_number: activated.version,
          },
        },
      });

      // 4. Aplicar o snapshot nas tabelas reais
      await this.applySnapshotInTransaction(clientId, snapshot, tx);

      // 5. Atualizar cache
      void this.metadataService.refresh(clientId);

      return activated;
    });
  }

  async checkout(clientId: string, versionId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const targetVersion = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!targetVersion || targetVersion.client_id !== clientId) {
      throw new NotFoundException(
        'Versão não encontrada para carregar no painel',
      );
    }

    const snapshot = targetVersion.snapshot as unknown as WorkflowSnapshot;

    return this.prisma.$transaction(async (tx) => {
      // 1. Aplicar o snapshot da versão nas tabelas de trabalho reais
      await this.applySnapshotInTransaction(clientId, snapshot, tx);

      // 2. Gravar no metadata do cliente qual versão está sendo ativamente editada
      const client = await tx.painel_clients.findUnique({
        where: { id: clientId },
      });
      const currentMeta = (client?.metadata as any) || {};
      await tx.painel_clients.update({
        where: { id: clientId },
        data: {
          metadata: {
            ...currentMeta,
            active_editing_version_id: targetVersion.id,
            active_editing_version_number: targetVersion.version,
          },
        },
      });

      // 3. Atualizar cache
      void this.metadataService.refresh(clientId);

      return {
        message: `Versão v${targetVersion.version} carregada no painel de edição!`,
        version: targetVersion,
      };
    });
  }

  async getEditingVersion(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const meta = (client?.metadata as any) || {};
    if (meta.active_editing_version_id) {
      const ver = await this.prisma.workflow_versions.findUnique({
        where: { id: meta.active_editing_version_id },
      });
      if (ver) return ver;
    }

    // Se não tiver setado explicitamente, retorna a versão publicada ou primeira encontrada
    return this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId, status: 'published' },
    });
  }

  async saveCurrentEditing(clientId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const meta = (client?.metadata as any) || {};
    let targetVersionId = meta.active_editing_version_id;

    if (!targetVersionId) {
      const published = await this.prisma.workflow_versions.findFirst({
        where: { client_id: clientId, status: 'published' },
      });
      targetVersionId = published?.id;
    }

    if (!targetVersionId) {
      throw new NotFoundException(
        'Nenhuma versão ativa identificada para salvar.',
      );
    }

    const currentSnapshot = await this.buildCurrentSnapshot(clientId);

    const updated = await this.prisma.workflow_versions.update({
      where: { id: targetVersionId },
      data: {
        snapshot: currentSnapshot as any,
      },
    });

    return {
      message: `Alterações salvas com sucesso na versão v${updated.version}!`,
      version: updated,
    };
  }

  async buildCurrentSnapshot(clientId: string): Promise<WorkflowSnapshot> {
    const [agents, subagents, apis, intentions] = await Promise.all([
      this.prisma.painel_agents.findMany({
        where: { client_id: clientId },
        orderBy: { execution_order: 'asc' },
      }),
      this.prisma.painel_subagents.findMany({
        where: { client_id: clientId },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.painel_apis.findMany({
        where: { client_id: clientId },
        orderBy: { execution_order: 'asc' },
      }),
      this.prisma.painel_intentions.findMany({
        where: { client_id: clientId },
      }),
    ]);

    return {
      agents: agents.map((a) => ({
        id: a.id,
        model: a.model,
        service_step: a.service_step,
        execution_order: a.execution_order,
        system_prompt: a.system_prompt,
        version: a.version,
        is_active: a.is_active,
        is_initial: a.is_initial,
        activation_conditions: a.activation_conditions,
        activation_mode: a.activation_mode,
        transitions: a.transitions,
        allowed_tool_names: a.allowed_tool_names,
      })),
      subagents: subagents.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        system_prompt: s.system_prompt,
        llm_provider: s.llm_provider,
        model: s.model,
        allowed_tool_names: s.allowed_tool_names,
        allowed_knowledge_base_ids: s.allowed_knowledge_base_ids,
        temperature: s.temperature,
        is_active: s.is_active,
      })),
      apis: apis.map((api) => ({
        id: api.id,
        agent_id: api.agent_id,
        name: api.name,
        description: api.description,
        method: api.method,
        url: api.url,
        headers: api.headers,
        body: api.body,
        parameters: api.parameters,
        extract_data: api.extract_data,
        visible_to_agent: api.visible_to_agent,
        active: api.active,
        next_tool: api.next_tool,
        execution_order: api.execution_order,
      })),
      intentions: intentions.map((i) => ({
        id: i.id,
        code: i.code,
        description: i.description,
        is_active: i.is_active,
      })),
    };
  }

  async createDraftSnapshot(
    clientId: string,
    dto: CreateSnapshotDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const snapshot = await this.buildCurrentSnapshot(clientId);

    const existingDraft = await this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId, status: 'draft' },
    });

    if (existingDraft) {
      return this.prisma.workflow_versions.update({
        where: { id: existingDraft.id },
        data: {
          snapshot: snapshot as any,
          description: dto?.description || existingDraft.description,
          base_version:
            dto?.baseVersion !== undefined
              ? dto.baseVersion
              : (existingDraft as any).base_version,
          created_at: new Date(),
          created_by: userId,
        },
      });
    }

    const highestVersion = await this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const nextVersion = (highestVersion?.version || 0) + 1;

    return this.prisma.workflow_versions.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        version: nextVersion,
        status: 'draft',
        snapshot: snapshot as any,
        description: dto?.description || `Draft v${nextVersion}`,
        base_version: dto?.baseVersion ?? null,
        created_by: userId,
      },
    });
  }

  async publish(
    clientId: string,
    versionId: string,
    dto: PublishVersionDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    if (!dto?.description?.trim()) {
      throw new BadRequestException(
        'A nota de versão é obrigatória para publicação.',
      );
    }

    let targetVersion = await this.prisma.workflow_versions.findUnique({
      where: { id: versionId },
    });

    if (!targetVersion || targetVersion.client_id !== clientId) {
      // If versionId === 'draft', find the draft
      if (versionId === 'draft') {
        targetVersion = await this.prisma.workflow_versions.findFirst({
          where: { client_id: clientId, status: 'draft' },
        });
      }
      if (!targetVersion) {
        throw new NotFoundException('Versão a ser publicada não encontrada');
      }
    }

    const snapshot = targetVersion.snapshot as unknown as WorkflowSnapshot;

    return this.prisma.$transaction(async (tx) => {
      // 1. Arquivar a versão publicada atual se existir
      await tx.workflow_versions.updateMany({
        where: {
          client_id: clientId,
          status: 'published',
        },
        data: {
          status: 'archived',
        },
      });

      // 2. Marcar a versão alvo como publicada
      const publishedVersion = await tx.workflow_versions.update({
        where: { id: targetVersion.id },
        data: {
          status: 'published',
          published_at: new Date(),
          published_by: userId,
          description: dto.description.trim(),
        },
      });

      // 3. Aplicar o snapshot nas tabelas reais do banco
      await this.applySnapshotInTransaction(clientId, snapshot, tx);

      // 4. Limpar histórico antigo mantendo no máximo 20 versões
      await this.enforceVersionLimitInTransaction(clientId, tx);

      // 5. Atualizar metadata cache
      void this.metadataService.refresh(clientId);

      return publishedVersion;
    });
  }

  async rollback(
    clientId: string,
    targetVersionId: string,
    dto: RollbackVersionDto,
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const targetVersion = await this.prisma.workflow_versions.findUnique({
      where: { id: targetVersionId },
    });

    if (!targetVersion || targetVersion.client_id !== clientId) {
      throw new NotFoundException('Versão alvo para rollback não encontrada');
    }

    const snapshot = targetVersion.snapshot as unknown as WorkflowSnapshot;

    const highestVersion = await this.prisma.workflow_versions.findFirst({
      where: { client_id: clientId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const nextVersion = (highestVersion?.version || 0) + 1;
    const rollbackDescription = dto?.description?.trim()
      ? `Rollback para v${targetVersion.version}: ${dto.description.trim()}`
      : `Rollback para a versão v${targetVersion.version}`;

    return this.prisma.$transaction(async (tx) => {
      // 1. Arquivar publicada anterior
      await tx.workflow_versions.updateMany({
        where: {
          client_id: clientId,
          status: 'published',
        },
        data: {
          status: 'archived',
        },
      });

      // 2. Criar nova versão publicada com o snapshot restaurado
      const newPublished = await tx.workflow_versions.create({
        data: {
          company_id: companyId,
          client_id: clientId,
          version: nextVersion,
          status: 'published',
          snapshot: snapshot as any,
          description: rollbackDescription,
          published_at: new Date(),
          published_by: userId,
          created_by: userId,
        },
      });

      // 3. Aplicar o snapshot nas tabelas reais
      await this.applySnapshotInTransaction(clientId, snapshot, tx);

      // 4. Limpeza para respeitar limite de 20
      await this.enforceVersionLimitInTransaction(clientId, tx);

      void this.metadataService.refresh(clientId);

      return newPublished;
    });
  }

  private async applySnapshotInTransaction(
    clientId: string,
    snapshot: WorkflowSnapshot,
    tx: any,
  ) {
    // 1. Limpar registros atuais vinculados ao cliente
    await tx.painel_apis.deleteMany({ where: { client_id: clientId } });
    await tx.painel_agents.deleteMany({ where: { client_id: clientId } });
    await tx.painel_subagents.deleteMany({ where: { client_id: clientId } });
    await tx.painel_intentions.deleteMany({ where: { client_id: clientId } });

    // 2. Recriar agentes
    if (snapshot.agents && snapshot.agents.length > 0) {
      await tx.painel_agents.createMany({
        data: snapshot.agents.map((a) => ({
          id: a.id,
          client_id: clientId,
          model: a.model,
          service_step: a.service_step,
          execution_order: a.execution_order,
          system_prompt: a.system_prompt,
          version: a.version || 1,
          is_active: a.is_active ?? true,
          is_initial: a.is_initial ?? false,
          activation_conditions: a.activation_conditions ?? null,
          activation_mode: a.activation_mode ?? 'on_next_message',
          transitions: a.transitions ?? null,
          allowed_tool_names: a.allowed_tool_names ?? null,
        })),
      });
    }

    // 3. Recriar subagentes
    if (snapshot.subagents && snapshot.subagents.length > 0) {
      await tx.painel_subagents.createMany({
        data: snapshot.subagents.map((s) => ({
          id: s.id,
          client_id: clientId,
          name: s.name,
          description: s.description,
          system_prompt: s.system_prompt,
          llm_provider: s.llm_provider || 'gemini',
          model: s.model,
          allowed_tool_names: s.allowed_tool_names || [],
          allowed_knowledge_base_ids: s.allowed_knowledge_base_ids || [],
          temperature: s.temperature ?? 0.7,
          is_active: s.is_active ?? true,
        })),
      });
    }

    // 4. Recriar APIs
    if (snapshot.apis && snapshot.apis.length > 0) {
      await tx.painel_apis.createMany({
        data: snapshot.apis.map((api) => ({
          id: api.id,
          client_id: clientId,
          agent_id: api.agent_id || null,
          name: api.name,
          description: api.description,
          method: api.method || 'GET',
          url: api.url || '',
          headers: api.headers ?? null,
          body: api.body ?? null,
          parameters: api.parameters ?? null,
          extract_data: api.extract_data ?? null,
          visible_to_agent: api.visible_to_agent ?? true,
          active: api.active ?? true,
          next_tool: api.next_tool || null,
          execution_order: api.execution_order || null,
        })),
      });
    }

    // 5. Recriar Intenções
    if (snapshot.intentions && snapshot.intentions.length > 0) {
      await tx.painel_intentions.createMany({
        data: snapshot.intentions.map((i) => ({
          id: i.id,
          client_id: clientId,
          code: i.code,
          description: i.description,
          is_active: i.is_active ?? true,
        })),
      });
    }
  }

  private async enforceVersionLimitInTransaction(clientId: string, tx: any) {
    const allVersions = await tx.workflow_versions.findMany({
      where: { client_id: clientId },
      orderBy: { created_at: 'desc' },
      select: { id: true, status: true },
    });

    if (allVersions.length > MAX_VERSIONS_PER_CLIENT) {
      const toDelete = allVersions
        .slice(MAX_VERSIONS_PER_CLIENT)
        .filter((v: any) => v.status === 'archived')
        .map((v: any) => v.id);

      if (toDelete.length > 0) {
        await tx.workflow_versions.deleteMany({
          where: { id: { in: toDelete } },
        });
      }
    }
  }

  async diff(
    clientId: string,
    v1Id: string,
    v2Id: string,
    userId: string,
  ): Promise<WorkflowDiffResult> {
    const companyId = await this.getUserCompanyId(userId);
    await this.validateClientAccess(clientId, companyId);

    const [snap1, snap2] = await Promise.all([
      this.resolveSnapshot(clientId, v1Id),
      this.resolveSnapshot(clientId, v2Id),
    ]);

    return this.calculateDiff(snap1, snap2);
  }

  private async resolveSnapshot(
    clientId: string,
    identifier: string,
  ): Promise<WorkflowSnapshot> {
    if (identifier === 'current') {
      return this.buildCurrentSnapshot(clientId);
    }
    if (identifier === 'draft') {
      const draft = await this.prisma.workflow_versions.findFirst({
        where: { client_id: clientId, status: 'draft' },
      });
      return draft
        ? (draft.snapshot as unknown as WorkflowSnapshot)
        : this.buildCurrentSnapshot(clientId);
    }
    if (identifier === 'published') {
      const pub = await this.prisma.workflow_versions.findFirst({
        where: { client_id: clientId, status: 'published' },
      });
      return pub
        ? (pub.snapshot as unknown as WorkflowSnapshot)
        : { agents: [], subagents: [], apis: [], intentions: [] };
    }

    const ver = await this.prisma.workflow_versions.findUnique({
      where: { id: identifier },
    });
    if (!ver || ver.client_id !== clientId) {
      throw new NotFoundException(`Versão ${identifier} não encontrada`);
    }
    return ver.snapshot as unknown as WorkflowSnapshot;
  }

  private calculateDiff(
    oldSnap: WorkflowSnapshot,
    newSnap: WorkflowSnapshot,
  ): WorkflowDiffResult {
    const result: WorkflowDiffResult = {
      hasChanges: false,
      agents: { added: [], removed: [], modified: [] },
      subagents: { added: [], removed: [], modified: [] },
      apis: { added: [], removed: [], modified: [] },
      intentions: { added: [], removed: [], modified: [] },
    };

    // 1. Diff Agentes
    const oldAgentsMap = new Map((oldSnap.agents || []).map((a) => [a.id, a]));
    const newAgentsMap = new Map((newSnap.agents || []).map((a) => [a.id, a]));

    for (const [id, newAgent] of newAgentsMap) {
      if (!oldAgentsMap.has(id)) {
        result.agents.added.push(newAgent);
        result.hasChanges = true;
      } else {
        const oldAgent = oldAgentsMap.get(id)!;
        const changes = this.compareObjects(oldAgent, newAgent, [
          'service_step',
          'model',
          'system_prompt',
          'execution_order',
          'is_active',
          'is_initial',
          'activation_conditions',
          'transitions',
          'allowed_tool_names',
        ]);
        if (Object.keys(changes).length > 0) {
          result.agents.modified.push({ item: newAgent, changes });
          result.hasChanges = true;
        }
      }
    }

    for (const [id, oldAgent] of oldAgentsMap) {
      if (!newAgentsMap.has(id)) {
        result.agents.removed.push(oldAgent);
        result.hasChanges = true;
      }
    }

    // 2. Diff Subagentes
    const oldSubMap = new Map((oldSnap.subagents || []).map((s) => [s.id, s]));
    const newSubMap = new Map((newSnap.subagents || []).map((s) => [s.id, s]));

    for (const [id, newSub] of newSubMap) {
      if (!oldSubMap.has(id)) {
        result.subagents.added.push(newSub);
        result.hasChanges = true;
      } else {
        const oldSub = oldSubMap.get(id)!;
        const changes = this.compareObjects(oldSub, newSub, [
          'name',
          'description',
          'system_prompt',
          'llm_provider',
          'model',
          'temperature',
          'is_active',
          'allowed_tool_names',
          'allowed_knowledge_base_ids',
        ]);
        if (Object.keys(changes).length > 0) {
          result.subagents.modified.push({ item: newSub, changes });
          result.hasChanges = true;
        }
      }
    }

    for (const [id, oldSub] of oldSubMap) {
      if (!newSubMap.has(id)) {
        result.subagents.removed.push(oldSub);
        result.hasChanges = true;
      }
    }

    // 3. Diff APIs
    const oldApisMap = new Map((oldSnap.apis || []).map((a) => [a.id, a]));
    const newApisMap = new Map((newSnap.apis || []).map((a) => [a.id, a]));

    for (const [id, newApi] of newApisMap) {
      if (!oldApisMap.has(id)) {
        result.apis.added.push(newApi);
        result.hasChanges = true;
      } else {
        const oldApi = oldApisMap.get(id)!;
        const changes = this.compareObjects(oldApi, newApi, [
          'name',
          'description',
          'method',
          'url',
          'headers',
          'body',
          'parameters',
          'extract_data',
          'visible_to_agent',
          'active',
        ]);
        if (Object.keys(changes).length > 0) {
          result.apis.modified.push({ item: newApi, changes });
          result.hasChanges = true;
        }
      }
    }

    for (const [id, oldApi] of oldApisMap) {
      if (!newApisMap.has(id)) {
        result.apis.removed.push(oldApi);
        result.hasChanges = true;
      }
    }

    return result;
  }

  private compareObjects(
    obj1: any,
    obj2: any,
    keys: string[],
  ): Record<string, { from: any; to: any }> {
    const changes: Record<string, { from: any; to: any }> = {};
    for (const k of keys) {
      const val1 = JSON.stringify(obj1[k] ?? null);
      const val2 = JSON.stringify(obj2[k] ?? null);
      if (val1 !== val2) {
        changes[k] = { from: obj1[k], to: obj2[k] };
      }
    }
    return changes;
  }
}
