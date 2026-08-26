export interface ActivationCondition {
  variable: string;
  operator:
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'starts_with'
    | 'ends_with'
    | 'gt'
    | 'lt'
    | 'gte'
    | 'lte'
    | 'exists'
    | 'not_exists'
    | 'in'
    | 'not_in'
    | 'regex';
  value: unknown;
}

export interface ActivationConditionGroup {
  logic: 'AND' | 'OR';
  conditions: ActivationCondition[];
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce(
      (acc, key) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj as unknown,
    );
}

const MESSAGE_ALIASES = new Set([
  'mensagem_usuario',
  'mensagem',
  'texto',
  'text',
  'message',
  'user_message',
  'last_message',
  'user_transcript',
]);

function resolveValue(state: Record<string, unknown>, variable: string): unknown {
  const direct = getNestedValue(state, variable);
  if (direct !== undefined || !MESSAGE_ALIASES.has(variable)) return direct;

  for (const alias of MESSAGE_ALIASES) {
    const value = getNestedValue(state, alias);
    if (value !== undefined && value !== null) return value;
  }

  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  const actualBoolean = parseBoolean(actual);
  const expectedBoolean = parseBoolean(expected);
  if (actualBoolean !== undefined && expectedBoolean !== undefined) {
    return actualBoolean === expectedBoolean;
  }

  if (typeof actual === 'number' || typeof expected === 'number') {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
      return actualNumber === expectedNumber;
    }
  }

  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.localeCompare(expected, undefined, { sensitivity: 'accent' }) === 0;
  }

  return actual === expected;
}

function evaluateSingle(
  condition: ActivationCondition,
  state: Record<string, unknown>,
): boolean {
  const actual = resolveValue(state, condition.variable);

  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'equals':
      return valuesEqual(actual, condition.value);
    case 'not_equals':
      return !valuesEqual(actual, condition.value);
    case 'contains':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .includes(String(condition.value ?? '').toLocaleLowerCase());
    case 'starts_with':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .startsWith(String(condition.value ?? '').toLocaleLowerCase());
    case 'ends_with':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .endsWith(String(condition.value ?? '').toLocaleLowerCase());
    case 'gt': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(condition.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber > expectedNumber
        : false;
    }
    case 'lt': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(condition.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber < expectedNumber
        : false;
    }
    case 'gte': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(condition.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber >= expectedNumber
        : false;
    }
    case 'lte': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(condition.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber <= expectedNumber
        : false;
    }
    case 'in':
      return (
        Array.isArray(condition.value) &&
        condition.value.some((expected) => valuesEqual(actual, expected))
      );
    case 'not_in':
      return (
        Array.isArray(condition.value) &&
        !condition.value.some((expected) => valuesEqual(actual, expected))
      );
    case 'regex':
      if (actual === undefined || actual === null) return false;
      try {
        return new RegExp(String(condition.value)).test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function evaluateConditions(
  group: ActivationConditionGroup,
  state: Record<string, unknown>,
): boolean {
  if (!group?.conditions?.length) return false;

  const results = group.conditions.map((c) => evaluateSingle(c, state));

  return group.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

export interface ConditionEvaluationDetail {
  variable: string;
  operator: ActivationCondition['operator'];
  expected: unknown;
  actual: unknown;
  missing: boolean;
  passed: boolean;
}

export interface ConditionEvaluationResult {
  matched: boolean;
  logic: 'AND' | 'OR';
  details: ConditionEvaluationDetail[];
}

export function describeEvaluation(
  result: ConditionEvaluationResult,
): string {
  const parts = result.details.map((detail) => {
    const actualLabel = detail.missing
      ? 'ausente'
      : JSON.stringify(detail.actual) ?? String(detail.actual);
    return `${detail.variable} ${detail.operator} ${JSON.stringify(detail.expected)} → ${actualLabel} [${detail.passed ? 'ok' : 'falhou'}]`;
  });
  return `(lógica ${result.logic}) ${parts.join(' ; ')}`;
}

export function evaluateConditionsWithDetails(
  group: ActivationConditionGroup,
  state: Record<string, unknown>,
): ConditionEvaluationResult {
  const conditions = group?.conditions ?? [];
  if (!conditions.length) {
    return { matched: false, logic: group?.logic || 'AND', details: [] };
  }

  const details = conditions.map<ConditionEvaluationDetail>((c) => {
    const actual = resolveValue(state, c.variable);
    return {
      variable: c.variable,
      operator: c.operator,
      expected: c.value,
      actual,
      missing: actual === undefined || actual === null,
      passed: evaluateSingle(c, state),
    };
  });

  const matched =
    group.logic === 'OR'
      ? details.some((d) => d.passed)
      : details.every((d) => d.passed);

  return { matched, logic: group.logic || 'AND', details };
}
