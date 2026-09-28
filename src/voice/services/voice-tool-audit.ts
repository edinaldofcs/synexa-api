import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { encrypt } from '../../common/utils/crypto.util';

const secretKey =
  /^(authorization|proxyauthorization|cookie|setcookie|password|passwd|senha|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|xapikey|xgoogapikey|subscriptionkey|ocpapimsubscriptionkey)$/i;
const sensitive = (key: string) => {
  const normalized = key.replace(/[^a-z0-9]/gi, '');
  return (
    secretKey.test(normalized) ||
    /(?:token|secret|password|apikey)$/i.test(normalized)
  );
};
const LIMIT = 1024 * 1024;

function collectSecrets(value: unknown, secrets: string[], depth = 0) {
  if (depth > 64) return;
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (sensitive(key) && typeof item === 'string')
      secrets.push(item, item.replace(/^(Bearer|Basic)\s+/i, ''));
    else if (item && typeof item === 'object')
      collectSecrets(item, secrets, depth + 1);
  }
}

/** Copies audit data: never mutates the request, response or model-visible result. */
export function redactAudit(
  value: unknown,
  secrets: string[] = [],
  depth = 0,
): any {
  if (depth > 64) return { omitted: true, reason: 'audit_depth_limit' };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((item) => redactAudit(item, secrets, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive(key) ? '[REDACTED]' : redactAudit(item, secrets, depth + 1),
      ]),
    );
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets.filter((item) => item.length >= 4))
    text = text.split(secret).join('[REDACTED]');
  return text
    .replace(
      /(["']?(?:access_token|refresh_token|api_key|password|senha|secret|token)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"<>]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:access_token|refresh_token|api_key|password|senha|secret|token)\s*[=:]\s*)[^\s&,;"<>]+/gi,
      '$1[REDACTED]',
    );
}

function bounded(value: unknown, secrets: string[]) {
  const clean = redactAudit(value, secrets);
  const size = Buffer.byteLength(JSON.stringify(clean) ?? 'null');
  return size > LIMIT
    ? { omitted: true, reason: 'audit_size_limit', size_bytes: size }
    : clean;
}

export interface HttpToolAudit {
  id: string;
  parent_id: string | null;
  api_id: string;
  tool_name: string;
  started_at: string;
  completed_at: string | null;
  request: { method: string; url: string; headers: unknown; body: unknown };
  response: { status: number; headers: unknown; body: unknown } | null;
  extracted_variables?: unknown;
  error: string | null;
}

export function startHttpAudit(input: {
  apiId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  parentId?: string;
}) {
  const secrets = Object.entries(input.headers)
    .filter(([key]) => sensitive(key))
    .flatMap(([, value]) => [
      String(value),
      String(value).replace(/^(Bearer|Basic)\s+/i, ''),
    ]);
  collectSecrets(input.body, secrets);
  const url = new URL(input.url);
  if (url.password) secrets.push(url.password);
  url.username = '';
  url.password = '';
  for (const [key, value] of url.searchParams)
    if (sensitive(key)) {
      secrets.push(value);
      url.searchParams.set(key, '[REDACTED]');
    }
  const entry: HttpToolAudit = {
    id: randomUUID(),
    parent_id: input.parentId || null,
    api_id: input.apiId,
    tool_name: input.name,
    started_at: new Date().toISOString(),
    completed_at: null,
    request: {
      method: input.method,
      url: redactAudit(url.toString(), secrets),
      headers: bounded(input.headers, secrets),
      body: bounded(input.body ?? null, secrets),
    },
    response: null,
    error: null,
  };
  return {
    entry,
    response(status: number, headers: Headers, body: unknown) {
      collectSecrets(Object.fromEntries(headers.entries()), secrets);
      collectSecrets(body, secrets);
      entry.response = {
        status,
        headers: bounded(Object.fromEntries(headers.entries()), secrets),
        body: bounded(body, secrets),
      };
      entry.completed_at = new Date().toISOString();
    },
    extracted(value: unknown) {
      entry.extracted_variables = bounded(value, secrets);
    },
    failed(error: unknown) {
      entry.error =
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'AbortError'
          ? 'timeout'
          : 'request_failed';
      entry.completed_at = new Date().toISOString();
    },
  };
}

export function sealToolAudit(
  turnId: string,
  agentId: string | undefined,
  exchanges: HttpToolAudit[] | undefined,
): string | undefined {
  if (!exchanges) return undefined;
  try {
    return encrypt(
      JSON.stringify({
        turn_id: turnId,
        agent_id: agentId ?? null,
        http_exchanges: exchanges,
      }),
      process.env.ENCRYPTION_KEY || '',
    );
  } catch {
    new Logger('VoiceToolAudit').error('Voice tool audit encryption failed');
    return undefined;
  }
}

/** The ID is captured before awaits, so parallel tools stay on their originating turn. */
export class VoiceAuditTurn {
  id = randomUUID();
  private readonly observed = new Set<string>();
  get count() {
    return this.observed.size;
  }
  private answered = false;
  user() {
    if (this.answered) this.id = randomUUID();
    this.answered = false;
    this.observed.add(this.id);
    return this.id;
  }
  assistant() {
    this.observed.add(this.id);
    this.answered = true;
    return this.id;
  }
  complete() {
    this.observed.add(this.id);
    this.answered = true;
  }
}
