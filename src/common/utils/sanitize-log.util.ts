const SENSITIVE_KEYS = new Set([
  'cpf',
  'documento',
  'cnpj',
  'phone',
  'phone_number',
  'telefone',
  'celular',
  'email',
  'password',
  'secret',
  'token',
  'api_key',
  'apiKey',
  'credit_card',
  'card_number',
  'cvv',
  'ssn',
  'nome',
  'name',
  'birth_date',
  'data_nascimento',
  'current_amount',
  'original_amount',
  'contract_number',
]);

const SENSITIVE_VALUE_PATTERNS = [
  /^\d{3}\.\d{3}\.\d{3}-\d{2}$/, // CPF
  /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, // CNPJ
  /^\+?\d{10,15}$/, // telefone
];

function isSensitiveValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value.trim()));
  }
  return false;
}

export function sanitize(obj: unknown, depth = 3): unknown {
  if (depth <= 0) return '[REDACTED]';

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth - 1));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        SENSITIVE_KEYS.has(lowerKey) ||
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('key')
      ) {
        result[key] = '[REDACTED]';
      } else if (isSensitiveValue(value)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitize(value, depth - 1);
      }
    }
    return result;
  }

  return obj;
}
