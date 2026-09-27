import {
  redactAudit,
  type HttpToolAudit,
} from '../../voice/services/voice-tool-audit';

export interface ExportMessage {
  id?: string;
  sender_type: string;
  content: string | null;
  created_at?: Date | string | null;
  metadata?: unknown;
}
export interface ExportTool {
  id?: string;
  tool_name: string;
  arguments?: unknown;
  result?: unknown;
  status: string;
  created_at?: Date | string | null;
  completed_at?: Date | string | null;
  audit?: {
    turn_id: string;
    agent_id: string | null;
    http_exchanges: HttpToolAudit[];
  } | null;
}

/** Explicit IDs only: timestamps cannot reliably correlate concurrent tool calls. */
export function buildCallTurns(
  messages: ExportMessage[] | undefined,
  tools: ExportTool[],
) {
  const turns = new Map<
    string,
    {
      id: string;
      correlation: 'recorded' | 'unavailable';
      started_at: Date | string | null;
      messages: {
        id: string | null;
        agent_id: string | null;
        role: string;
        text: string | null;
        timestamp: Date | string | null;
      }[];
      tools: Record<string, unknown>[];
    }
  >();
  const get = (
    id: string,
    recorded: boolean,
    timestamp?: Date | string | null,
  ) => {
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        id,
        correlation: recorded ? 'recorded' : 'unavailable',
        started_at: timestamp ?? null,
        messages: [],
        tools: [],
      };
      turns.set(id, turn);
    } else if (
      timestamp &&
      (!turn.started_at ||
        new Date(timestamp).getTime() < new Date(turn.started_at).getTime())
    )
      turn.started_at = timestamp;
    return turn;
  };
  for (const [index, message] of (messages || []).entries()) {
    const turnId = (message.metadata as { turn_id?: string } | null)?.turn_id;
    get(
      turnId || `unlinked-message-${message.id || index}`,
      !!turnId,
      message.created_at,
    ).messages.push({
      id: message.id || null,
      agent_id:
        (message.metadata as { agent_id?: string } | null)?.agent_id || null,
      role: message.sender_type,
      text: message.content,
      timestamp: message.created_at ?? null,
    });
  }
  for (const [index, tool] of tools.entries()) {
    const audit = tool.audit;
    get(
      audit?.turn_id || `unlinked-tool-${tool.id || index}`,
      !!audit?.turn_id,
      tool.created_at,
    ).tools.push({
      id: tool.id || null,
      agent_id: audit?.agent_id || null,
      tool_name: tool.tool_name,
      arguments: redactAudit(tool.arguments ?? null),
      model_result: redactAudit(tool.result ?? null),
      status: tool.status,
      started_at: tool.created_at ?? null,
      completed_at: tool.completed_at ?? null,
      audit_available: !!audit,
      http_exchanges: audit?.http_exchanges || [],
    });
  }
  return [...turns.values()].sort(
    (a, b) =>
      (a.started_at ? new Date(a.started_at).getTime() : 0) -
      (b.started_at ? new Date(b.started_at).getTime() : 0),
  );
}
