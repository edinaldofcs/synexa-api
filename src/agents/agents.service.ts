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
import {
  PreviewPromptDto,
  SimulateSequenceDto,
} from './dto/agent-simulation.dto';
import { AgentsRepository } from './repositories/agents.repository';
import { buildAgentPromptFromBlocks } from './utils/agent-prompt-builder.util';
import { evaluateConditionsWithDetails } from '../orchestrator/utils/condition-evaluator.util';

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

  async previewPrompt(
    clientId: string,
    dto: PreviewPromptDto,
    companyId: string,
  ) {
    await this.validateClientAccess(clientId, companyId);
    const state = dto.state || {};

    let agentRecord: any = dto.agent_data;
    if (!agentRecord && dto.agent_id) {
      agentRecord = await this.agentsRepository.findOne(dto.agent_id);
    }

    if (!agentRecord) {
      throw new NotFoundException('Agente não informado para preview');
    }

    const resolvedPrompt = buildAgentPromptFromBlocks(agentRecord, state);
    const charCount = resolvedPrompt.length;
    const tokenEstimate = Math.ceil(charCount / 4);

    return {
      resolved_prompt: resolvedPrompt,
      char_count: charCount,
      token_estimate: tokenEstimate,
    };
  }

  async simulateSequence(
    clientId: string,
    dto: SimulateSequenceDto,
    companyId: string,
  ) {
    await this.validateClientAccess(clientId, companyId);
    const state = dto.state || {};

    const agents = await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      orderBy: { execution_order: 'asc' },
    });

    const evaluations: Array<{
      agent_id: string;
      service_step: string;
      execution_order: number | null;
      matched: boolean;
      logic: string;
      details: any[];
      resolved_prompt: string;
    }> = [];

    let activeAgentId: string | null = null;

    for (const agent of agents) {
      const conditions = agent.activation_conditions as any;
      const hasConditions =
        conditions?.conditions && conditions.conditions.length > 0;

      let matched = false;
      let details: any[] = [];
      const logic = conditions?.logic || 'AND';

      if (hasConditions) {
        const evalRes = evaluateConditionsWithDetails(conditions, state);
        matched = evalRes.matched;
        details = evalRes.details;
        if (matched && !activeAgentId) {
          activeAgentId = agent.id;
        }
      }

      const resolvedPrompt = buildAgentPromptFromBlocks(agent as any, state);

      evaluations.push({
        agent_id: agent.id,
        service_step: agent.service_step || '',
        execution_order: agent.execution_order ?? 0,
        matched,
        logic,
        details,
        resolved_prompt: resolvedPrompt,
      });
    }

    if (!activeAgentId && agents.length > 0) {
      const initial = agents.find((a) => a.is_initial) || agents[0];
      activeAgentId = initial.id;
      const foundEval = evaluations.find((e) => e.agent_id === initial.id);
      if (foundEval && (!foundEval.details || foundEval.details.length === 0)) {
        foundEval.matched = true;
      }
    }

    return {
      active_agent_id: activeAgentId,
      evaluations,
    };
  }
}
