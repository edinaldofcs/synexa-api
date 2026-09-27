import { redactAudit } from '../../voice/services/voice-tool-audit';
import type { conversations, painel_interactions } from '@prisma/client';
import {
  buildCallTurns,
  type ExportMessage,
  type ExportTool,
} from './call-export-turns';

/** Shared by delivery and the read-only Flow preview. */
export function buildCallExportPayload(input: {
  eventId: string;
  companyId: string;
  clientId: string;
  conversation: Pick<
    conversations,
    'id' | 'started_at' | 'current_agent_id' | 'metadata'
  >;
  endedAt: Date;
  recoveredCall?: boolean;
  interaction?: Partial<painel_interactions> | null;
  variables?: unknown;
  messages?: ExportMessage[];
  tools: ExportTool[];
}) {
  const { conversation, endedAt, interaction } = input;
  const metadata = (conversation.metadata || {}) as Record<string, unknown>;
  return {
    schema_version: 1,
    event: 'call.completed',
    event_id: input.eventId,
    occurred_at: endedAt.toISOString(),
    company_id: input.companyId,
    client_id: input.clientId,
    call: {
      id: conversation.id,
      external_id: interaction?.call_id || metadata.call_id || null,
      started_at: conversation.started_at,
      ended_at: endedAt,
      duration_seconds:
        interaction?.duration_seconds ??
        Math.max(
          0,
          Math.round(
            (endedAt.getTime() -
              (conversation.started_at || endedAt).getTime()) /
              1000,
          ),
        ),
      end_reason: input.recoveredCall
        ? 'connection_lost'
        : interaction?.hangup_cause || metadata.hangup_cause || 'completed',
      agent_id:
        interaction?.agent_id ||
        metadata.agent_id ||
        conversation.current_agent_id ||
        null,
      caller_number: metadata.caller || null,
      dialed_number: metadata.did || interaction?.company_identifier || null,
      customer_identifier: interaction?.client_identifier || null,
      customer_name: interaction?.client_name || null,
      variables: input.variables || interaction?.context_variables || {},
      summary: interaction?.summary || null,
      transcript: input.messages?.map(
        ({ metadata: _metadata, ...message }) => message,
      ),
      transcript_included: input.messages !== undefined,
      tools: input.tools.map(({ audit: _audit, ...tool }) => redactAudit(tool)),
      turns: buildCallTurns(input.messages, input.tools),
      usage: interaction
        ? {
            total_tokens: interaction.total_tokens,
            estimated_cost_usd: interaction.estimated_cost_usd,
          }
        : null,
    },
  };
}
