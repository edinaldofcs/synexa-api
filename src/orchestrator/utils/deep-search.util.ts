function deepSearch(obj: unknown, targetKey: string): unknown {
  if (obj == null) return null;
  const target = targetKey.toLowerCase().trim();

  if (typeof obj === 'object') {
    for (const key in obj as Record<string, unknown>) {
      if (key.toLowerCase().trim() === target) return (obj as Record<string, unknown>)[key];
    }
    for (const key in obj as Record<string, unknown>) {
      const result = deepSearch((obj as Record<string, unknown>)[key], targetKey);
      if (result !== null && result !== undefined) return result;
    }
  }
  return null;
}

function getByPath(obj: unknown, path: string): unknown {
  if (!path || obj == null) return null;

  let projection: string[] | null = null;
  const projMatch = path.match(/\{([^}]+)\}$/);
  let cleanPath = path;
  if (projMatch) {
    projection = projMatch[1].split(',').map(s => s.trim());
    cleanPath = path.substring(0, path.length - projMatch[0].length);
  }

  const steps: { key: string; index: string | null }[] = [];
  const regex = /([^.[\]]+)(?:\[([^\]]+)\])?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanPath)) !== null) {
    steps.push({ key: match[1].trim(), index: match[2] !== undefined ? match[2].trim() : null });
  }

  let current: unknown = obj;
  for (let i = 0; i < steps.length; i++) {
    if (current == null) return null;
    const { key, index } = steps[i];

    current = (current as Record<string, unknown>)[key];

    if (index !== null) {
      if (current == null) return null;

      if (index === '*') {
        if (Array.isArray(current)) {
          const remainingPath = steps.slice(i + 1).map(s =>
            s.key + (s.index !== null ? `[${s.index}]` : '')
          ).join('.');

          let items = current;
          if (remainingPath) {
            items = current.map(item => getByPath(item, remainingPath)).filter(v => v !== null && v !== undefined);
          }

          if (projection) {
            items = items.map(item => {
              if (typeof item !== 'object' || item === null) return item;
              const projObj: Record<string, unknown> = {};
              for (const f of projection!) projObj[f] = deepSearch(item, f);
              return projObj;
            });
          }
          return items;
        }
        return null;
      } else {
        const idx = parseInt(index);
        if (Array.isArray(current)) {
          current = isNaN(idx) ? current[current.length - 1] : current[idx];
        } else {
          return null;
        }
      }
    }
  }

  if (projection && current !== null && current !== undefined) {
    if (Array.isArray(current)) {
      return current.map(item => {
        if (typeof item !== 'object' || item === null) return item;
        const projObj: Record<string, unknown> = {};
        for (const f of projection!) projObj[f] = deepSearch(item, f);
        return projObj;
      });
    } else if (typeof current === 'object') {
      const projObj: Record<string, unknown> = {};
      for (const f of projection!) projObj[f] = deepSearch(current, f);
      return projObj;
    }
  }

  return current;
}

function evaluateComparisonRules(value: unknown, rules: any[]): unknown {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(rules) || rules.length === 0) return value;

  for (const rule of rules) {
    const { operator, compare_value, return_value } = rule;

    let valToCompare: string | number = value as number;
    let ruleVal: string | number = compare_value;

    const numVal = Number(value);
    const numRule = Number(compare_value);
    if (!isNaN(numVal) && !isNaN(numRule) && String(compare_value).trim() !== '') {
      valToCompare = numVal;
      ruleVal = numRule;
    } else {
      valToCompare = String(value).trim();
      ruleVal = String(compare_value).trim();
    }

    let isMatch = false;
    switch (operator) {
      case '==': isMatch = valToCompare == ruleVal; break;
      case '!=': isMatch = valToCompare != ruleVal; break;
      case '>=': isMatch = Number(valToCompare) >= Number(ruleVal); break;
      case '<=': isMatch = Number(valToCompare) <= Number(ruleVal); break;
      case '>': isMatch = Number(valToCompare) > Number(ruleVal); break;
      case '<': isMatch = Number(valToCompare) < Number(ruleVal); break;
      case 'includes': isMatch = String(valToCompare).includes(String(ruleVal)); break;
      default: isMatch = false;
    }

    if (isMatch) return return_value;
  }
  return value;
}

function resolveConfig(raw: unknown, config: unknown): unknown {
  if (typeof config === 'string') {
    if (config.includes('.') || config.includes('[')) return getByPath(raw, config);
    return deepSearch(raw, config);
  }

  if (Array.isArray(config)) {
    for (const field of config) {
      const value = resolveConfig(raw, field);
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  if (typeof config === 'object' && config !== null) {
    const cfg = config as Record<string, unknown>;

    if (cfg.path) {
      let value = getByPath(raw, cfg.path as string);
      if (cfg.rules) value = evaluateComparisonRules(value, cfg.rules as any[]);
      return value;
    }

    if (cfg.mode === 'first') {
      let collection: unknown[] = [];
      if (typeof cfg.source === 'string') collection = extractCollection(raw, cfg.source);
      if (Array.isArray(cfg.source)) {
        for (const src of cfg.source) collection.push(...extractCollection(raw, src));
      }
      const firstItem = collection[0];
      if (!firstItem) return null;
      return cfg.field ? deepSearch(firstItem, cfg.field as string) : firstItem;
    }

    if (cfg.mode === 'all') {
      let collection: unknown[] = [];
      if (typeof cfg.source === 'string') collection = extractCollection(raw, cfg.source);
      if (Array.isArray(cfg.source)) {
        for (const src of cfg.source) collection.push(...extractCollection(raw, src));
      }
      if (cfg.fields) collection = collection.map(item => projectFields(item, cfg.fields));
      if (cfg.index !== undefined) return collection[cfg.index as number] ?? null;
      if (Array.isArray(cfg.pick)) return (cfg.pick as number[]).map(i => collection[i]).filter(v => v !== undefined);
      return collection;
    }

    if (cfg.mode === 'all_flat') {
      let values: unknown[] = [];
      if (typeof cfg.source === 'string') values = deepSearchAll(raw, cfg.source);
      if (Array.isArray(cfg.source)) {
        for (const src of cfg.source) values.push(...deepSearchAll(raw, src));
      }
      values = values.filter(v => v !== null && v !== undefined && v !== '');
      if (cfg.index !== undefined) return values[cfg.index as number] ?? null;
      if (Array.isArray(cfg.pick)) return (cfg.pick as number[]).map(i => values[i]).filter(v => v !== undefined);
      return uniqueArray(values);
    }

    let sourceValue: unknown = null;
    if (typeof cfg.source === 'string') sourceValue = deepSearch(raw, cfg.source);
    if (Array.isArray(cfg.source)) {
      for (const field of cfg.source) {
        const value = deepSearch(raw, field);
        if (value !== null && value !== undefined && value !== '') { sourceValue = value; break; }
      }
    }
    return cfg.rules ? applyRules(sourceValue, cfg.rules as any[]) : sourceValue;
  }
  return null;
}

function extractCollection(raw: unknown, source: unknown): unknown[] {
  const found = deepSearch(raw, source as string);
  if (Array.isArray(found)) return found;
  if (typeof found === 'object' && found !== null) return [found];
  return [];
}

function uniqueArray(arr: unknown[]): unknown[] {
  return [...new Set(arr.map(v => JSON.stringify(v)))].map(v => JSON.parse(v));
}

function applyRules(value: unknown, rules: any[]): unknown {
  if (value === null || value === undefined) return null;
  for (const rule of rules) {
    if (rule.lte !== undefined && (value as number) <= rule.lte) return rule.value;
    if (rule.lt !== undefined && (value as number) < rule.lt) return rule.value;
    if (rule.gte !== undefined && (value as number) >= rule.gte) return rule.value;
    if (rule.gt !== undefined && (value as number) > rule.gt) return rule.value;
    if (rule.eq !== undefined && value === rule.eq) return rule.value;
    if (rule.neq !== undefined && value !== rule.neq) return rule.value;
    if (rule.includes && typeof value === 'string' && (value as string).includes(rule.includes)) return rule.value;
    if (rule.regex && typeof value === 'string') {
      try { if (new RegExp(rule.regex).test(value as string)) return rule.value; } catch { /* ignore */ }
    }
  }
  return value;
}

function projectFields(item: unknown, fields: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const result: Record<string, unknown> = {};

  if (Array.isArray(fields)) {
    for (const field of fields) result[field] = deepSearch(item, field);
    return result;
  }

  if (typeof fields === 'object') {
    for (const [newKey, originalKey] of Object.entries(fields as Record<string, string>)) {
      result[newKey] = deepSearch(item, originalKey);
    }
    return result;
  }
  return item;
}

function deepSearchAll(obj: unknown, targetKey: string, results: unknown[] = []): unknown[] {
  if (obj == null) return results;
  const target = targetKey.toLowerCase().trim();

  if (typeof obj === 'object') {
    for (const key in obj as Record<string, unknown>) {
      if (key.toLowerCase().trim() === target) results.push((obj as Record<string, unknown>)[key]);
      deepSearchAll((obj as Record<string, unknown>)[key], targetKey, results);
    }
  }
  return results;
}

function flattenObject(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj == null) return result;

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key in obj as Record<string, unknown>) {
      const val = (obj as Record<string, unknown>)[key];
      const cleanKey = key.trim();
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        Object.assign(result, flattenObject(val));
        result[cleanKey] = val;
      } else {
        result[cleanKey] = val;
      }
    }
  }
  return result;
}

export function extractDataFromResponse(rawData: unknown, extractMap?: Record<string, unknown>): Record<string, unknown> {
  const flatData = flattenObject(rawData);

  if (extractMap && Object.keys(extractMap).length > 0) {
    const output: Record<string, unknown> = {};
    for (const [key, config] of Object.entries(extractMap)) {
      if (key === 'validate_field') continue;
      output[key] = resolveConfig(rawData, config);
    }
    return { ...flatData, ...output };
  }

  return flatData;
}
