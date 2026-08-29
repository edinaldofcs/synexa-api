/**
 * Encadeamento condicional de APIs.
 *
 * A configuração vive dentro de `extract_data` na chave especial `_chaining`
 * (irmã de `_fallback_message`), então não exige coluna nova nem migration:
 *
 * {
 *   "tipo": { "path": "data.tipo" },
 *   "_chaining": {
 *     "rules": [
 *       { "field": "tipo", "operator": "==", "compare_value": "alto risco", "next_api_id": "<uuid-a>" },
 *       { "field": "tipo", "operator": "==", "compare_value": "baixo risco", "next_api_id": "<uuid-b>" }
 *     ],
 *     "default_next_api_id": "<uuid-c ou null>"
 *   }
 * }
 *
 * Ordem de resolução:
 * 1. Primeira regra cuja condição casa com os dados extraídos;
 * 2. `default_next_api_id`, se configurado;
 * 3. Fallback legado (`next_api_id`/`next_tool`) — encadeamento direto atual.
 */

export interface ApiChainingRule {
  field: string;
  operator: string;
  compare_value?: unknown;
  next_api_id?: string | null;
}

export interface ApiChainingConfig {
  rules?: ApiChainingRule[];
  default_next_api_id?: string | null;
}

const CHAINING_KEY = '_chaining';

const FIELDLESS_OPERATORS = new Set([
  'is_empty_array',
  'is_not_empty_array',
  'is_empty',
  'is_not_empty',
]);

export function getNestedChainingValue(
  data: Record<string, unknown>,
  path: string,
): unknown {
  if (!path) return undefined;
  const value = path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      data,
    );
  if (value !== undefined) return value;
  return (data as Record<string, unknown>)[path];
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (
    Array.isArray(actual) &&
    (expected === '[]' || expected === '' || expected === null)
  ) {
    return actual.length === 0;
  }
  if (actual === null || actual === undefined || expected === null) {
    return actual === expected;
  }

  const numActual = Number(actual);
  const numExpected = Number(expected);
  const bothNumeric =
    !isNaN(numActual) &&
    !isNaN(numExpected) &&
    String(expected).trim() !== '' &&
    actual !== '';

  if (bothNumeric) return numActual === numExpected;
  return String(actual).trim() === String(expected).trim();
}

function toNumber(value: unknown): number {
  return Number(value);
}

export function evaluateChainingCondition(
  value: unknown,
  operator: string,
  compareValue: unknown,
): boolean {
  switch (operator) {
    case 'is_empty_array':
      return Array.isArray(value) && value.length === 0;
    case 'is_not_empty_array':
      return Array.isArray(value) && value.length > 0;
    case 'is_empty':
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value as object).length === 0)
      );
    case 'is_not_empty':
      return (
        value !== null &&
        value !== undefined &&
        value !== '' &&
        (!Array.isArray(value) || value.length > 0)
      );
    case '==':
      return looseEquals(value, compareValue);
    case '!=':
      return !looseEquals(value, compareValue);
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (value === null || value === undefined || value === '') return false;
      const numValue = toNumber(value);
      const numCompare = toNumber(compareValue);
      if (isNaN(numValue) || isNaN(numCompare)) return false;
      if (operator === '>') return numValue > numCompare;
      if (operator === '>=') return numValue >= numCompare;
      if (operator === '<') return numValue < numCompare;
      return numValue <= numCompare;
    }
    case 'includes':
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.includes(compareValue as never);
      return String(value)
        .toLowerCase()
        .includes(String(compareValue ?? '').toLowerCase());
    default:
      return false;
  }
}

export function extractChainingConfig(
  extractData: unknown,
): ApiChainingConfig | null {
  if (
    !extractData ||
    typeof extractData !== 'object' ||
    Array.isArray(extractData)
  ) {
    return null;
  }
  const raw = (extractData as Record<string, unknown>)[CHAINING_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const config = raw as Record<string, unknown>;
  const rules = Array.isArray(config.rules)
    ? (config.rules as ApiChainingRule[]).filter(
        (rule) =>
          rule &&
          typeof rule === 'object' &&
          typeof rule.next_api_id === 'string' &&
          rule.next_api_id.trim() !== '' &&
          (FIELDLESS_OPERATORS.has(rule.operator) ||
            (typeof rule.field === 'string' && rule.field.trim() !== '')),
      )
    : [];

  const defaultNext =
    typeof config.default_next_api_id === 'string' &&
    config.default_next_api_id.trim() !== ''
      ? config.default_next_api_id.trim()
      : null;

  if (!rules.length && !defaultNext) return null;
  return { rules, default_next_api_id: defaultNext };
}

/**
 * Resolve o ID da próxima API a partir das regras condicionais.
 * Sem configuração ou sem correspondência, cai no fallback legado
 * (encadeamento direto `next_api_id`/`next_tool`).
 */
export function resolveChainedApiId(
  extractData: unknown,
  data: unknown,
  legacyNextApiId?: string | null,
): string | null {
  const config = extractChainingConfig(extractData);
  if (!config) return legacyNextApiId ?? null;

  const context =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};

  for (const rule of config.rules || []) {
    const value = getNestedChainingValue(context, rule.field);
    if (evaluateChainingCondition(value, rule.operator, rule.compare_value)) {
      return (rule.next_api_id as string).trim();
    }
  }

  return config.default_next_api_id ?? legacyNextApiId ?? null;
}
