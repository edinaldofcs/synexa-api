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

function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  return path.split('.').reduce(
    (acc, key) =>
      acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
    obj as unknown,
  );
}

function evaluateSingle(
  condition: ActivationCondition,
  state: Record<string, unknown>,
): boolean {
  const actual = getNestedValue(state, condition.variable);

  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'equals':
      return actual === condition.value;
    case 'not_equals':
      return actual !== condition.value;
    case 'contains':
      return String(actual ?? '').includes(String(condition.value ?? ''));
    case 'starts_with':
      return String(actual ?? '').startsWith(String(condition.value ?? ''));
    case 'ends_with':
      return String(actual ?? '').endsWith(String(condition.value ?? ''));
    case 'gt':
      return Number(actual) > Number(condition.value);
    case 'lt':
      return Number(actual) < Number(condition.value);
    case 'gte':
      return Number(actual) >= Number(condition.value);
    case 'lte':
      return Number(actual) <= Number(condition.value);
    case 'in':
      return (
        Array.isArray(condition.value) && condition.value.includes(actual)
      );
    case 'not_in':
      return (
        Array.isArray(condition.value) && !condition.value.includes(actual)
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
