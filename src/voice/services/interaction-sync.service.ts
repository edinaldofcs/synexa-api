import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { extractFunnelFromState } from '../../common/utils/funnel-mapping.util';

export interface SyncSessionInteractionParams {
  sessionId: string;
  companyId: string;
  clientId: string;
  agentId?: string | null;
  agentName?: string | null;
  channel: string;
  direction?: 'inbound' | 'outbound';
  state?: Record<string, unknown>;
  durationSeconds?: number;
  billableSeconds?: number;
  bargeInCount?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  llmModel?: string;
  llmProvider?: string;
  hangupCause?: string;
  startedAt?: Date;
  endedAt?: Date;
  status?: string;
  messages?: any[];
}

/**
 * Persiste/atualiza o registro de interação da sessão de voz em
 * `painel_interactions` (histórico de duração, tokens, custo e funil de
 * cobrança). Único ponto de escrita do canal de voz nesse conjunto.
 */
@Injectable()
export class InteractionSyncService {
  private readonly logger = new Logger(InteractionSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async syncSessionInteraction(params: SyncSessionInteractionParams) {
    try {
      const now = new Date();
      const startedAt = params.startedAt || now;
      const endedAt = params.endedAt || now;
      const funnel = extractFunnelFromState(params.state, endedAt);

      return await this.prisma.painel_interactions.upsert({
        where: { session_id: params.sessionId },
        create: {
          company_id: params.companyId,
          client_id: params.clientId,
          agent_id: params.agentId || null,
          agent_name: params.agentName || null,
          session_id: params.sessionId,
          channel: params.channel,
          direction: params.direction || 'inbound',
          interaction_mode: params.channel.startsWith('voice')
            ? 'voice'
            : 'both',
          client_identifier: funnel.client_identifier,
          client_name: funnel.client_name,
          has_human_answer: true,
          human_answered_at: startedAt,
          is_right_party: funnel.is_right_party,
          right_party_at: funnel.right_party_at,
          is_debt_presented: funnel.is_debt_presented,
          debt_presented_at: funnel.debt_presented_at,
          debt_amount:
            funnel.debt_amount !== null ? (funnel.debt_amount as any) : null,
          is_agreement_reached: funnel.is_agreement_reached,
          agreement_at: funnel.agreement_at,
          agreement_id: funnel.agreement_id,
          agreement_amount:
            funnel.agreement_amount !== null
              ? (funnel.agreement_amount as any)
              : null,
          is_promise_to_pay: funnel.is_promise_to_pay,
          promise_to_pay_at: funnel.promise_to_pay_at,
          promise_due_date: funnel.promise_due_date,
          promise_amount:
            funnel.promise_amount !== null
              ? (funnel.promise_amount as any)
              : null,
          disposition: funnel.disposition,
          duration_seconds: params.durationSeconds || 0,
          billable_seconds:
            params.billableSeconds || params.durationSeconds || 0,
          barge_in_count: params.bargeInCount || 0,
          total_tokens: params.totalTokens || 0,
          prompt_tokens: params.promptTokens || 0,
          completion_tokens: params.completionTokens || 0,
          estimated_cost_usd:
            params.estimatedCostUsd !== undefined
              ? (params.estimatedCostUsd as any)
              : null,
          llm_provider: params.llmProvider || null,
          llm_model: params.llmModel || null,
          hangup_cause: params.hangupCause || null,
          context_variables: (params.state || {}) as any,
          messages: (params.messages || []) as any,
          started_at: startedAt,
          ended_at: endedAt,
          status: params.status || 'completed',
        },
        update: {
          agent_id: params.agentId || undefined,
          agent_name: params.agentName || undefined,
          client_identifier: funnel.client_identifier || undefined,
          client_name: funnel.client_name || undefined,
          has_human_answer: true,
          is_right_party: funnel.is_right_party,
          right_party_at: funnel.right_party_at || undefined,
          is_debt_presented: funnel.is_debt_presented,
          debt_presented_at: funnel.debt_presented_at || undefined,
          debt_amount:
            funnel.debt_amount !== null
              ? (funnel.debt_amount as any)
              : undefined,
          is_agreement_reached: funnel.is_agreement_reached,
          agreement_at: funnel.agreement_at || undefined,
          agreement_id: funnel.agreement_id || undefined,
          agreement_amount:
            funnel.agreement_amount !== null
              ? (funnel.agreement_amount as any)
              : undefined,
          is_promise_to_pay: funnel.is_promise_to_pay,
          promise_to_pay_at: funnel.promise_to_pay_at || undefined,
          promise_due_date: funnel.promise_due_date || undefined,
          promise_amount:
            funnel.promise_amount !== null
              ? (funnel.promise_amount as any)
              : undefined,
          disposition: funnel.disposition,
          duration_seconds:
            params.durationSeconds !== undefined
              ? params.durationSeconds
              : undefined,
          billable_seconds:
            params.billableSeconds !== undefined
              ? params.billableSeconds
              : undefined,
          barge_in_count:
            params.bargeInCount !== undefined ? params.bargeInCount : undefined,
          total_tokens:
            params.totalTokens !== undefined ? params.totalTokens : undefined,
          prompt_tokens:
            params.promptTokens !== undefined ? params.promptTokens : undefined,
          completion_tokens:
            params.completionTokens !== undefined
              ? params.completionTokens
              : undefined,
          estimated_cost_usd:
            params.estimatedCostUsd !== undefined
              ? (params.estimatedCostUsd as any)
              : undefined,
          llm_provider: params.llmProvider || undefined,
          llm_model: params.llmModel || undefined,
          hangup_cause: params.hangupCause || undefined,
          context_variables: (params.state || {}) as any,
          ended_at: endedAt,
          status: params.status || 'completed',
        },
      });
    } catch (err: any) {
      this.logger.error(
        `Erro ao sincronizar interação de sessão (${params.sessionId}): ${err.message}`,
      );
      return null;
    }
  }
}
