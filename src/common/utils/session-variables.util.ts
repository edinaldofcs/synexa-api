import { BadRequestException } from '@nestjs/common';

const unsafeParts = new Set(['__proto__', 'prototype', 'constructor']);
const internalKeys = new Set([
  'current_agent_id',
  'pending_agent_id',
  'available_apis',
  'switch_reason',
  'inbound_variable_mapping',
  'activation_rules',
  'variable_schema',
  'llm_providers',
  'llm_providers_updated_at',
  'metadata',
  'sessionId',
  'company_id',
  'client_id',
  'nome_agente',
  'nome_empresa',
  'agent_name',
  'company_name',
  'empresa',
  'canal',
  'channel',
  'origin_channel',
]);

export function variableKey(value: string): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^(?:\{\{|\[\[)(.*)(?:\}\}|\]\])$/, '$1')
    .trim();
}

export function isSafePath(path: string): boolean {
  return !!path && !path.split(/[.[\]]/).some((part) => unsafeParts.has(part));
}

export function isBusinessVariable(key: string): boolean {
  return isSafePath(key) && !key.startsWith('_') && !internalKeys.has(key);
}

export function assertBusinessVariable(key: string): void {
  if (!isBusinessVariable(key)) {
    throw new BadRequestException({
      code: 'INVALID_VARIABLE',
      message:
        'Escolha um nome de variável válido, diferente das variáveis do sistema.',
    });
  }
}

/** Exact own-property lookup; external objects cannot traverse prototypes. */
export function readVariable(value: unknown, rawPath: string): unknown {
  const path = variableKey(rawPath);
  if (!isSafePath(path) || !value || typeof value !== 'object')
    return undefined;
  if (Object.prototype.hasOwnProperty.call(value, path))
    return (value as Record<string, unknown>)[path];
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current &&
        typeof current === 'object' &&
        Object.prototype.hasOwnProperty.call(current, key)
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

export function businessVariables(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => isBusinessVariable(key) && item !== undefined,
    ),
  );
}

/** Persist only explicitly configured fields, using the resolved outgoing payload. */
export function savedRequestVariables(
  definitions: unknown,
  payload: unknown,
): Record<string, unknown> {
  const saved: Record<string, unknown> = {};
  if (
    !definitions ||
    typeof definitions !== 'object' ||
    Array.isArray(definitions)
  )
    return saved;
  for (const [key, definition] of Object.entries(definitions)) {
    if (!definition || typeof definition !== 'object') continue;
    const config = definition as Record<string, unknown>;
    if (
      config.save_to_session !== true &&
      config.save_to_session !== 'true' &&
      config.save_to_context !== true &&
      config.save_to_state !== true
    )
      continue;
    const destination = variableKey(
      typeof config.session_variable === 'string' &&
        config.session_variable.trim()
        ? config.session_variable
        : key,
    );
    assertBusinessVariable(destination);
    const value = readVariable(payload, key);
    if (value !== undefined) saved[destination] = value;
  }
  return saved;
}

export function clientIdentity(
  client: { agent_name?: unknown; company_name?: unknown } | null | undefined,
) {
  const agent =
    typeof client?.agent_name === 'string' ? client.agent_name.trim() : '';
  const company =
    typeof client?.company_name === 'string' ? client.company_name.trim() : '';
  if (!agent || !company)
    throw new BadRequestException({
      code: 'CLIENT_IDENTITY_REQUIRED',
      message:
        'Preencha o nome da empresa e o nome do agente IA antes de iniciar o atendimento.',
    });
  return { nome_agente: agent, nome_empresa: company };
}

/** Exact extraction path, including explicit array projection via [*]. */
export function readExtractionPath(value: unknown, path: string): unknown {
  if (!isSafePath(path)) return undefined;
  const marker = path.indexOf('[*]');
  if (marker < 0) return readVariable(value, path);
  const items = readVariable(value, path.slice(0, marker));
  if (!Array.isArray(items)) return undefined;
  const rest = path.slice(marker + 3).replace(/^\./, '');
  return rest
    ? items
        .map((item) => readExtractionPath(item, rest))
        .filter((item) => item !== undefined)
    : items;
}

/** Public projection: execution context and credentials never leave as collected data. */
export function projectCollectedVariables(
  value: unknown,
): Record<string, unknown> {
  const credential =
    /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|senha|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|xapikey|xgoogapikey|subscriptionkey|ocpapimsubscriptionkey)$/i;
  const clean = (item: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    if (Array.isArray(item))
      return item.map((entry) => clean(entry, depth + 1));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([key]) =>
              isSafePath(key) &&
              !credential.test(key.replace(/[^a-z0-9]/gi, '')),
          )
          .map(([key, entry]) => [key, clean(entry, depth + 1)]),
      );
    return item;
  };
  return clean(businessVariables(value), 0) as Record<string, unknown>;
}
