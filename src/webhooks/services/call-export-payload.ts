import type { conversations, voice_session_telemetry } from '@prisma/client';
import { projectCollectedVariables } from '../../common/utils/session-variables.util';
import {
  buildCallTurns,
  type ExportMessage,
  type ExportTool,
} from './call-export-turns';

/** One contract for delivery and the read-only Flow preview. */
export function buildCallExportPayload(input: {
  payloadVersion?: 3;
  eventId: string;
  companyId: string;
  clientId: string;
  conversation: Pick<
    conversations,
    'id' | 'started_at' | 'current_agent_id' | 'metadata'
  >;
  endedAt: Date;
  recoveredCall?: boolean;
  telemetry?: Partial<voice_session_telemetry> | null;
  variables?: unknown;
  messages?: ExportMessage[];
  tools: ExportTool[];
}) {
  const { conversation, endedAt, telemetry } = input;
  const metadata = (conversation.metadata || {}) as Record<string, unknown>;
  return {
    schema_version: 3,
    event: 'call.completed',
    event_id: input.eventId,
    occurred_at: endedAt.toISOString(),
    company_id: input.companyId,
    client_id: input.clientId,
    call: {
      id: conversation.id,
      external_id: telemetry?.asterisk_unique_id || metadata.call_id || null,
      started_at: conversation.started_at,
      ended_at: endedAt,
      duration_seconds:
        telemetry?.duration_sec ??
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
        : telemetry?.hangup_cause || metadata.hangup_cause || 'completed',
      agent_id: conversation.current_agent_id || metadata.agent_id || null,
      caller_number: telemetry?.caller_number || metadata.caller || null,
      dialed_number: telemetry?.did_number || metadata.did || null,
      variables: projectCollectedVariables(input.variables),
      transcript_included: input.messages !== undefined,
      turns: buildCallTurns(input.messages, input.tools),
      usage: telemetry
        ? {
            total_tokens: telemetry.total_tokens,
            estimated_cost_usd: telemetry.cost_usd,
          }
        : null,
    },
  };
}
