export interface ConditionRule {
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
  value?: unknown;
}

export interface ConditionGroup {
  logic: 'AND' | 'OR';
  rules: ConditionRule[];
}

export interface TextPromptBlock {
  id?: string;
  type: 'text';
  content: string;
}

export interface ElseIfBranch {
  id?: string;
  condition: ConditionGroup;
  then_blocks: PromptContentBlock[];
}

export interface ConditionalPromptBlock {
  id?: string;
  type: 'conditional';
  condition: ConditionGroup;
  then_blocks: PromptContentBlock[];
  elseif_branches?: ElseIfBranch[];
  else_blocks?: PromptContentBlock[];
}

export type PromptContentBlock = TextPromptBlock | ConditionalPromptBlock;

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
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
  if (!state || typeof state !== 'object' || !variable) return undefined;
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
  if (normalized === 'true' || normalized === '1' || normalized === 'sim') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'nao' || normalized === 'não') return false;
  return undefined;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  const actualBoolean = parseBoolean(actual);
  const expectedBoolean = parseBoolean(expected);
  if (actualBoolean !== undefined && expectedBoolean !== undefined) {
    return actualBoolean === expectedBoolean;
  }

  if (
    actual !== null &&
    actual !== undefined &&
    expected !== null &&
    expected !== undefined &&
    (typeof actual === 'number' || typeof expected === 'number' || (!isNaN(Number(actual)) && !isNaN(Number(expected)) && String(actual).trim() !== '' && String(expected).trim() !== ''))
  ) {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
      return actualNumber === expectedNumber;
    }
  }

  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.trim().localeCompare(expected.trim(), undefined, { sensitivity: 'accent' }) === 0;
  }

  if (actual !== undefined && actual !== null && expected !== undefined && expected !== null) {
    return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
  }

  return actual === expected;
}

export function evaluateConditionRule(
  rule: ConditionRule,
  state: Record<string, unknown>,
): boolean {
  if (!rule || !rule.variable) return false;
  const actual = resolveValue(state, rule.variable);

  switch (rule.operator) {
    case 'exists':
      return actual !== undefined && actual !== null && String(actual).trim() !== '';
    case 'not_exists':
      return actual === undefined || actual === null || String(actual).trim() === '';
    case 'equals':
      return valuesEqual(actual, rule.value);
    case 'not_equals':
      return !valuesEqual(actual, rule.value);
    case 'contains':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .includes(String(rule.value ?? '').toLocaleLowerCase());
    case 'starts_with':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .startsWith(String(rule.value ?? '').toLocaleLowerCase());
    case 'ends_with':
      return String(actual ?? '')
        .toLocaleLowerCase()
        .endsWith(String(rule.value ?? '').toLocaleLowerCase());
    case 'gt': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(rule.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber > expectedNumber
        : false;
    }
    case 'lt': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(rule.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber < expectedNumber
        : false;
    }
    case 'gte': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(rule.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber >= expectedNumber
        : false;
    }
    case 'lte': {
      const actualNumber = Number(actual);
      const expectedNumber = Number(rule.value);
      return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)
        ? actualNumber <= expectedNumber
        : false;
    }
    case 'in': {
      if (Array.isArray(rule.value)) {
        return rule.value.some((expected) => valuesEqual(actual, expected));
      }
      if (typeof rule.value === 'string') {
        const items = rule.value.split(',').map((s) => s.trim());
        return items.some((expected) => valuesEqual(actual, expected));
      }
      return false;
    }
    case 'not_in': {
      if (Array.isArray(rule.value)) {
        return !rule.value.some((expected) => valuesEqual(actual, expected));
      }
      if (typeof rule.value === 'string') {
        const items = rule.value.split(',').map((s) => s.trim());
        return !items.some((expected) => valuesEqual(actual, expected));
      }
      return true;
    }
    case 'regex':
      if (actual === undefined || actual === null) return false;
      try {
        return new RegExp(String(rule.value), 'i').test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function evaluateConditionGroup(
  group: ConditionGroup,
  state: Record<string, unknown>,
): boolean {
  if (!group?.rules?.length) return false;
  const results = group.rules.map((r) => evaluateConditionRule(r, state));
  return group.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Parses a single rule string like:
 * "tipo_cliente == 'premium'"
 * "saldo > 0"
 * "telefone exists"
 */
export function parseConditionRuleString(raw: string): ConditionRule | null {
  const str = raw.trim();
  if (!str) return null;

  // Unary operators (exists / not_exists)
  const unaryMatch = str.match(/^([a-zA-Z0-9_.]+)\s+(exists|not_exists|existe|não existe|nao existe)$/i);
  if (unaryMatch) {
    const op = unaryMatch[2].toLowerCase().includes('not') || unaryMatch[2].toLowerCase().includes('não') || unaryMatch[2].toLowerCase().includes('nao')
      ? 'not_exists'
      : 'exists';
    return { variable: unaryMatch[1], operator: op };
  }

  // Binary operators
  const binaryMatch = str.match(
    /^([a-zA-Z0-9_.]+)\s*(==|!=|>=|<=|>|<|contains|starts_with|ends_with|not_in|in|regex|é igual a|é diferente de|é maior que|é menor que|contém)\s*(.*)$/i,
  );

  if (binaryMatch) {
    const variable = binaryMatch[1];
    let rawOp = binaryMatch[2].toLowerCase().trim();
    let rawVal = binaryMatch[3].trim();

    // Clean surrounding quotes from value
    if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      rawVal = rawVal.slice(1, -1);
    }

    let operator: ConditionRule['operator'] = 'equals';
    if (rawOp === '==' || rawOp === 'é igual a') operator = 'equals';
    else if (rawOp === '!=' || rawOp === 'é diferente de') operator = 'not_equals';
    else if (rawOp === '>' || rawOp === 'é maior que') operator = 'gt';
    else if (rawOp === '<' || rawOp === 'é menor que') operator = 'lt';
    else if (rawOp === '>=') operator = 'gte';
    else if (rawOp === '<=') operator = 'lte';
    else if (rawOp === 'contains' || rawOp === 'contém') operator = 'contains';
    else if (rawOp === 'starts_with') operator = 'starts_with';
    else if (rawOp === 'ends_with') operator = 'ends_with';
    else if (rawOp === 'in') operator = 'in';
    else if (rawOp === 'not_in') operator = 'not_in';
    else if (rawOp === 'regex') operator = 'regex';

    return { variable, operator, value: rawVal };
  }

  return null;
}

/**
 * Parses a condition expression like:
 * "tipo_cliente == 'premium' E saldo > 0"
 * "plano == 'pro' OU plano == 'enterprise'"
 */
export function parseConditionGroupString(expr: string): ConditionGroup {
  const trimmed = expr.trim();
  const isOr = /\s+(?:OU|OR|\|\|)\s+/i.test(trimmed);
  const splitter = isOr ? /\s+(?:OU|OR|\|\|)\s+/i : /\s+(?:E|AND|&&)\s+/i;
  const parts = trimmed.split(splitter);

  const rules: ConditionRule[] = [];
  for (const part of parts) {
    const rule = parseConditionRuleString(part);
    if (rule) rules.push(rule);
  }

  return {
    logic: isOr ? 'OR' : 'AND',
    rules: rules.length > 0 ? rules : [{ variable: trimmed, operator: 'exists' }],
  };
}

/**
 * Resolves conditional text syntax like:
 * [SE tipo == "vip"] ... [SENÃO SE tipo == "pro"] ... [SENÃO] ... [FIM SE]
 * or {{#if tipo == "vip"}} ... {{#elseif ...}} ... {{#else}} ... {{/if}}
 */
export function resolveConditionalString(
  text: string,
  state: Record<string, unknown> = {},
): string {
  if (!text) return '';

  let result = text;

  // 1. Process [SE ... ] ... [FIM SE] syntax
  const bracketRegex = /\[SE\s+([^\]]+)\]([\s\S]*?)\[FIM(?:\s+_?SE)?\]/gi;
  result = result.replace(bracketRegex, (_, condExpr: string, body: string) => {
    // Check for [SENÃO SE ...] and [SENÃO]
    const branches: Array<{ condition?: ConditionGroup; content: string }> = [];
    const elseParts = body.split(/\[SENÃO(?:\s+SE\s+([^\]]+))?\]/gi);

    // Initial IF branch
    branches.push({
      condition: parseConditionGroupString(condExpr),
      content: elseParts[0] || '',
    });

    for (let i = 1; i < elseParts.length; i += 2) {
      const branchCondExpr = elseParts[i];
      const branchContent = elseParts[i + 1] || '';
      branches.push({
        condition: branchCondExpr ? parseConditionGroupString(branchCondExpr) : undefined,
        content: branchContent,
      });
    }

    for (const branch of branches) {
      if (!branch.condition || evaluateConditionGroup(branch.condition, state)) {
        return resolveConditionalString(branch.content, state).trim();
      }
    }

    return '';
  });

  // 2. Process {{#if ...}} ... {{/if}} syntax
  const hbsRegex = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/gi;
  result = result.replace(hbsRegex, (_, condExpr: string, body: string) => {
    const branches: Array<{ condition?: ConditionGroup; content: string }> = [];
    const elseParts = body.split(/\{\{#(?:else|elseif)\s*([^}]*)\}\}/gi);

    branches.push({
      condition: parseConditionGroupString(condExpr),
      content: elseParts[0] || '',
    });

    for (let i = 1; i < elseParts.length; i += 2) {
      const branchCondExpr = elseParts[i]?.trim();
      const branchContent = elseParts[i + 1] || '';
      branches.push({
        condition: branchCondExpr ? parseConditionGroupString(branchCondExpr) : undefined,
        content: branchContent,
      });
    }

    for (const branch of branches) {
      if (!branch.condition || evaluateConditionGroup(branch.condition, state)) {
        return resolveConditionalString(branch.content, state).trim();
      }
    }

    return '';
  });

  return result;
}

export function resolveConditionalBlocks(
  blocks: PromptContentBlock[] | string | null | undefined,
  state: Record<string, unknown> = {},
): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') {
    return resolveConditionalString(blocks, state);
  }
  if (!Array.isArray(blocks)) return '';

  const parts: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      const text = typeof block.content === 'string' ? block.content.trim() : '';
      if (text) {
        // Also resolve any inline conditional text syntax if present
        const resolvedText = resolveConditionalString(text, state).trim();
        if (resolvedText) parts.push(resolvedText);
      }
    } else if (block.type === 'conditional') {
      if (evaluateConditionGroup(block.condition, state)) {
        if (Array.isArray(block.then_blocks) && block.then_blocks.length > 0) {
          const resolved = resolveConditionalBlocks(block.then_blocks, state);
          if (resolved) parts.push(resolved);
        }
      } else {
        let matchedElseIf = false;
        if (Array.isArray(block.elseif_branches)) {
          for (const branch of block.elseif_branches) {
            if (evaluateConditionGroup(branch.condition, state)) {
              matchedElseIf = true;
              if (Array.isArray(branch.then_blocks) && branch.then_blocks.length > 0) {
                const resolved = resolveConditionalBlocks(branch.then_blocks, state);
                if (resolved) parts.push(resolved);
              }
              break;
            }
          }
        }

        if (!matchedElseIf && Array.isArray(block.else_blocks) && block.else_blocks.length > 0) {
          const resolved = resolveConditionalBlocks(block.else_blocks, state);
          if (resolved) parts.push(resolved);
        }
      }
    }
  }

  return parts.join('\n\n').trim();
}
