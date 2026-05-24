import { Logger } from '@nestjs/common';

export interface LogContext {
  request_id?: string;
  conversation_id?: string;
  message_id?: string;
  inbound_event_id?: string;
  company_id?: string;
  client_id?: string;
  agent_run_id?: string;
  [key: string]: unknown;
}

export function structuredLog(
  logger: Logger,
  level: 'log' | 'warn' | 'error',
  message: string,
  context?: LogContext,
  error?: unknown,
) {
  const base = {
    timestamp: new Date().toISOString(),
    ...context,
  };

  const msg = `[${base.request_id || 'no-req'}] ${message}`;

  switch (level) {
    case 'error':
      logger.error({ ...base, error: error instanceof Error ? error.message : error }, msg);
      break;
    case 'warn':
      logger.warn(base, msg);
      break;
    default:
      logger.log(base, msg);
  }
}
