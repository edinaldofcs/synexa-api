import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { WebSearchConfigDto } from './dto/web-search-config.dto';
import { AgentsRepository } from './repositories/agents.repository';
import { buildAgentPromptFromBlocks } from './utils/agent-prompt-builder.util';

@Injectable()
export class AgentsService {
  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly metadataService: ClientMetadataService,
    private readonly prisma: PrismaService,
  ) {}

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Client not found`);
    }
  }

  private async enforceInitialAgentUniqueness(agent: any) {
    if (!agent?.is_initial || !agent?.client_id) return;
    await this.prisma.painel_agents.updateMany({
      where: {
        client_id: agent.client_id,
        is_initial: true,
        id: { not: agent.id },
      },
      data: { is_initial: false },
    });
  }

  private splitLlmProvider(
    payload: Record<string, unknown>,
  ): [Record<string, unknown>, any] {
    const { llm_provider, capabilities, ...rest } = payload;
    const transitions = (rest.transitions as any) || {};
    if (llm_provider) transitions.llm_provider = llm_provider;
    if (capabilities) transitions.capabilities = capabilities;
    delete rest.transitions;
    return [rest, transitions];
  }

  private mergeLlmProvider(agent: any) {
    const transitions = agent.transitions || {};
    return { ...agent, llm_provider: transitions.llm_provider || '' };
  }

  async create(
    clientId: string,
    createAgentDto: CreateAgentDto | Record<string, unknown>,
    companyId: string,
  ) {
    await this.validateClientAccess(clientId, companyId);
    const [data, transitions] = this.splitLlmProvider(
      createAgentDto as Record<string, unknown>,
    );
    if (
      data.persona_blocks &&
      typeof data.persona_blocks === 'object' &&
      Object.keys(data.persona_blocks as object).length > 0
    ) {
      data.system_prompt = buildAgentPromptFromBlocks({
        persona_blocks: data.persona_blocks as any,
      });
    }
    const agent = await this.agentsRepository.create(clientId, {
      ...data,
      transitions,
    });
    await this.enforceInitialAgentUniqueness(agent);
    if (agent) void this.metadataService.refresh(agent.client_id);
    return this.mergeLlmProvider(agent);
  }

  async findAll(companyId: string) {
    return this.prisma.painel_agents.findMany({
      where: { painel_clients: { company_id: companyId } },
      include: { painel_clients: { select: { company_name: true } } },
      orderBy: { execution_order: 'asc' },
    });
  }

  async findAllByClient(clientId: string, companyId: string) {
    await this.validateClientAccess(clientId, companyId);
    const agents = await this.agentsRepository.findAllByClient(clientId);
    return agents.map((a) => this.mergeLlmProvider(a));
  }

  async findOne(id: string, companyId: string) {
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    return this.mergeLlmProvider(agent);
  }

  async update(
    id: string,
    updateAgentDto: UpdateAgentDto | Record<string, unknown>,
    companyId: string,
  ) {
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    const [data, transitions] = this.splitLlmProvider(
      updateAgentDto as Record<string, unknown>,
    );
    if (
      data.persona_blocks &&
      typeof data.persona_blocks === 'object' &&
      Object.keys(data.persona_blocks as object).length > 0
    ) {
      data.system_prompt = buildAgentPromptFromBlocks({
        persona_blocks: data.persona_blocks as any,
      });
    }
    const mergedTransitions = {
      ...((agent.transitions as any) || {}),
      ...transitions,
    };
    const updated = await this.agentsRepository.update(id, {
      ...data,
      transitions: mergedTransitions,
    });
    await this.enforceInitialAgentUniqueness(updated);
    if (updated) void this.metadataService.refresh(updated.client_id);
    return this.mergeLlmProvider(updated);
  }

  async remove(id: string, companyId: string) {
    const agent = await this.agentsRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }
    const { agent: removedAgent, result } =
      await this.agentsRepository.remove(id);
    if (removedAgent) void this.metadataService.refresh(removedAgent.client_id);
    return result;
  }

  async getWebSearchConfig(agentId: string, companyId: string) {
    const agent = await this.agentsRepository.findOne(agentId);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${agentId} not found`);
    }

    const transitions = (agent.transitions as Record<string, unknown>) || {};
    const webSearch = (transitions.web_search as Record<string, unknown>) || {};

    return {
      enabled: webSearch.enabled !== false,
    };
  }

  async updateWebSearchConfig(
    agentId: string,
    dto: WebSearchConfigDto,
    companyId: string,
  ) {
    const agent = await this.agentsRepository.findOne(agentId);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: agent.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Agent with ID ${agentId} not found`);
    }

    const transitions = (agent.transitions as Record<string, unknown>) || {};
    const updated = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
    };

    transitions.web_search = updated;

    await this.agentsRepository.update(agentId, {
      transitions: transitions as any,
    });

    void this.metadataService.refresh(agent.client_id);

    return {
      enabled: updated.enabled !== false,
    };
  }

  async getAllWebSearchConfigs(companyId: string) {
    const agents = await this.prisma.painel_agents.findMany({
      where: { painel_clients: { company_id: companyId } },
      select: {
        id: true,
        service_step: true,
        client_id: true,
        model: true,
        is_active: true,
        transitions: true,
      },
      orderBy: { execution_order: 'asc' },
    });

    return agents.map((agent) => {
      const transitions = (agent.transitions as Record<string, unknown>) || {};
      const webSearch =
        (transitions.web_search as Record<string, unknown>) || {};
      return {
        agent_id: agent.id,
        agent_name: agent.service_step,
        client_id: agent.client_id,
        model: agent.model,
        is_active: agent.is_active,
        web_search: {
          enabled: webSearch.enabled !== false,
        },
      };
    });
  }
}
