import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class OrchestratorAgentService {
  private readonly logger = new Logger(OrchestratorAgentService.name);

  constructor(private readonly prisma: PrismaService) {}

  async selecionarAgente(
    sessionData: Record<string, unknown>,
    companyPhone: string,
  ): Promise<{
    etapa_atendimento: string;
    response_number: string;
    newStep?: string;
    needsSessionUpdate: boolean;
  }> {
    const currentStep = (sessionData as any).current_step as string | undefined;

    if (!currentStep) {
      const client = await this.prisma.painel_clients.findFirst({
        where: { phone_number: companyPhone },
        include: {
          painel_agents: {
            orderBy: [{ execution_order: 'asc' }, { service_step: 'asc' }],
            take: 1,
          },
        },
      });

      const firstAgent = client?.painel_agents?.[0];
      if (!firstAgent) {
        this.logger.warn({ companyPhone }, 'Nenhum agente configurado para este cliente');
        return { etapa_atendimento: '', response_number: companyPhone, needsSessionUpdate: false };
      }

      return {
        etapa_atendimento: firstAgent.service_step || '',
        response_number: companyPhone,
        newStep: firstAgent.service_step ?? undefined,
        needsSessionUpdate: true,
      };
    }

    const nextStep = await this.evaluateTransitions(currentStep, companyPhone, sessionData);
    if (nextStep && nextStep !== currentStep) {
      this.logger.log({ from: currentStep, to: nextStep }, 'Transição de agente');
      return {
        etapa_atendimento: nextStep,
        response_number: companyPhone,
        newStep: nextStep,
        needsSessionUpdate: true,
      };
    }

    return {
      etapa_atendimento: currentStep,
      response_number: companyPhone,
      needsSessionUpdate: false,
    };
  }

  private async evaluateTransitions(
    currentStep: string,
    companyPhone: string,
    sessionData: Record<string, unknown>,
  ): Promise<string | null> {
    const prefix = currentStep.substring(0, Math.min(6, currentStep.length));

    const currentAgent = await this.prisma.painel_agents.findFirst({
      where: {
        painel_clients: { phone_number: companyPhone },
        service_step: { contains: prefix, mode: 'insensitive' },
        is_active: true,
      },
    });

    if (!currentAgent || !currentAgent.transitions) return null;

    const transitions = currentAgent.transitions as any[];
    if (!Array.isArray(transitions) || transitions.length === 0) return null;

    const sorted = [...transitions].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const transition of sorted) {
      if (transition.target_step && this.evaluateCondition(transition.condition, sessionData)) {
        return transition.target_step;
      }
    }

    return null;
  }

  private evaluateCondition(condition: any, data: Record<string, unknown>): boolean {
    if (!condition) return true;

    if (condition.operator === 'and') {
      return condition.rules?.every((r: any) => this.evaluateCondition(r, data)) ?? true;
    }

    if (condition.operator === 'or') {
      return condition.rules?.some((r: any) => this.evaluateCondition(r, data)) ?? false;
    }

    if (condition.operator === 'not') {
      return !this.evaluateCondition(condition.condition, data);
    }

    const { field, operator, value } = condition;
    if (!field || !operator) return false;

    const fieldValue = this.getNestedValue(data, field);

    switch (operator) {
      case 'equals': return fieldValue === value;
      case 'not_equals': return fieldValue !== value;
      case 'exists': return fieldValue !== undefined && fieldValue !== null;
      case 'not_exists': return fieldValue === undefined || fieldValue === null;
      case 'contains': return String(fieldValue ?? '').includes(String(value ?? ''));
      case 'gt': return Number(fieldValue) > Number(value);
      case 'gte': return Number(fieldValue) >= Number(value);
      case 'lt': return Number(fieldValue) < Number(value);
      case 'lte': return Number(fieldValue) <= Number(value);
      default: return false;
    }
  }

  private getNestedValue(data: any, path: string): any {
    return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), data);
  }

  async getAgentConfig(response_number: string, _subtype_detail: string | undefined, etapa_atendimento: string) {
    if (!etapa_atendimento) return null;

    const prefix = etapa_atendimento.substring(0, Math.min(6, etapa_atendimento.length));

    const painelClient = await this.prisma.painel_clients.findFirst({
      where: { phone_number: response_number },
      include: {
        painel_agents: {
          where: { service_step: { contains: prefix, mode: 'insensitive' }, is_active: true },
        },
      },
    });

    if (painelClient && painelClient.painel_agents?.length) {
      const agent = painelClient.painel_agents[0];
      return this.buildAgentResult(painelClient, agent);
    }

    const fallback = await this.prisma.painel_clients.findFirst({
      where: { phone_number: response_number },
      include: {
        painel_agents: {
          where: { is_active: true },
        },
      },
    });

    if (fallback?.painel_agents?.length) {
      this.logger.warn({ service_step: fallback.painel_agents[0].service_step, etapa_atendimento }, 'Fallback: agente sem match exato');
      return this.buildAgentResult(fallback, fallback.painel_agents[0]);
    }

    const lastFallback = await this.prisma.painel_clients.findFirst({
      where: { phone_number: response_number },
      include: {
        painel_agents: true,
      },
    });

    if (lastFallback?.painel_agents?.length) {
      this.logger.warn({ service_step: lastFallback.painel_agents[0].service_step, is_active: lastFallback.painel_agents[0].is_active }, 'Fallback final ignorando is_active');
      return this.buildAgentResult(lastFallback, lastFallback.painel_agents[0]);
    }

    return null;
  }

  private buildAgentResult(client: any, agent: any) {
    return {
      ...client,
      system_prompt: agent.system_prompt || '',
      model: agent.model || '',
      client_id: client.id,
      agent_id: agent.id,
      persona_id: agent.id,
      agent_name: client.agent_name,
      company_name: client.company_name?.replace(/\s+/g, ''),
    };
  }

  buildAgentPrompt(agentConfig: any, sessionData: Record<string, unknown>): string {
    if (!agentConfig) return '';

    const now = new Date();
    let prompt = agentConfig.system_prompt || '';

    prompt = prompt.replaceAll('data_atual', now.toISOString().split('T')[0]);
    prompt = prompt.replace('dia_da_semana', now.toLocaleDateString('pt-BR', { weekday: 'long' }));

    const ofertas = sessionData.ofertas_disponiveis;
    if (typeof prompt === 'string' && ofertas) {
      prompt = prompt.replace('ofertas_disponiveis', JSON.stringify(ofertas, null, 2));
    }

    return prompt;
  }
}
