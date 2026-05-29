import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { llmConfig } from '../providers/llm-config';
import type { AgentCapabilities, AgentConfig } from '../types/capabilities.types';
import { DEFAULT_CAPABILITIES } from '../types/capabilities.types';
import { evaluateConditions } from '../utils/condition-evaluator.util';
import type { ActivationConditionGroup } from '../utils/condition-evaluator.util';

export interface SelectAgentResult {
  id: string;
  service_step: string | null;
  model: string | null;
  system_prompt: string | null;
  transitions: unknown;
  is_initial: boolean;
  activation_conditions: unknown;
  activation_mode: string | null;
  allowed_tool_names: unknown;
}

@Injectable()
export class AgentConfigResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolveAgentConfig(
    clientId: string,
    state: Record<string, unknown>,
  ): Promise<AgentConfig & { agentId: string }> {
    const agents = (await this.prisma.painel_agents.findMany({
      where: { client_id: clientId, is_active: true },
      select: {
        id: true,
        service_step: true,
        model: true,
        system_prompt: true,
        transitions: true,
        is_initial: true,
        activation_conditions: true,
        activation_mode: true,
        allowed_tool_names: true,
      },
      orderBy: { execution_order: 'asc' },
    })) as unknown as SelectAgentResult[];

    if (agents.length === 0) {
      return this.buildDefaultAgentConfig();
    }

    const currentAgentId = state.current_agent_id as string | undefined;

    if (!currentAgentId) {
      const initialAgent = agents.find((a) => a.is_initial) || agents[0];
      return this.agentRecordToConfig(initialAgent);
    }

    const pendingAgentId = state.pending_agent_id as string | undefined;
    if (pendingAgentId) {
      const targetAgent = agents.find((a) => a.id === pendingAgentId);
      if (targetAgent) {
        return this.agentRecordToConfig(targetAgent);
      }
    }

    for (const agent of agents) {
      if (agent.id === currentAgentId) continue;
      const conditions =
        agent.activation_conditions as unknown as ActivationConditionGroup | null;
      if (!conditions) continue;

      if (evaluateConditions(conditions, state)) {
        return this.agentRecordToConfig(agent);
      }
    }

    const currentAgent = agents.find((a) => a.id === currentAgentId);
    if (currentAgent) {
      return this.agentRecordToConfig(currentAgent);
    }

    return this.agentRecordToConfig(agents[0]);
  }

  private buildDefaultAgentConfig(): AgentConfig & { agentId: string } {
    return {
      agentId: 'default',
      id: 'default',
      name: 'default',
      model: llmConfig.models.gemini,
      system_prompt: 'You are a helpful assistant.',
      capabilities: { ...DEFAULT_CAPABILITIES },
      citation_policy: { policy: 'optional' },
      allowed_knowledge_base_ids: [],
      allowed_tool_names: [],
      web_search_allowed: false,
      temperature: 0.3,
    };
  }

  private agentRecordToConfig(
    painelAgent: SelectAgentResult,
  ): AgentConfig & { agentId: string } {
    const transitions =
      (painelAgent?.transitions as Record<string, unknown>) || {};
    const ws = (transitions.web_search as Record<string, unknown>) || {};

    return {
      agentId: painelAgent?.id || 'default',
      id: painelAgent?.id || 'default',
      name: painelAgent?.service_step || 'default',
      model: painelAgent?.model || llmConfig.models.gemini,
      system_prompt:
        painelAgent?.system_prompt || 'You are a helpful assistant.',
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...(transitions.capabilities as Partial<AgentCapabilities>),
      },
      citation_policy: { policy: 'optional' },
      allowed_knowledge_base_ids: Array.isArray(
        transitions.allowed_knowledge_base_ids,
      )
        ? (transitions.allowed_knowledge_base_ids as string[])
        : [],
      allowed_tool_names: Array.isArray(painelAgent?.allowed_tool_names)
        ? (painelAgent.allowed_tool_names as string[])
        : [],
      web_search_allowed: ws.enabled !== false,
      temperature: 0.3,
    };
  }
}
