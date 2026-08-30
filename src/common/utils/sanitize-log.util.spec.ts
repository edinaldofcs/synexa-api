import { sanitize } from './sanitize-log.util';

describe('sanitize-log.util', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitize', () => {
    it('should pass through primitive strings', () => {
      expect(sanitize('hello')).toBe('hello');
    });

    it('should pass through numbers', () => {
      expect(sanitize(42)).toBe(42);
    });

    it('should pass through booleans', () => {
      expect(sanitize(true)).toBe(true);
      expect(sanitize(false)).toBe(false);
    });

    it('should pass through null', () => {
      expect(sanitize(null)).toBeNull();
    });

    it('should pass through objects with non-sensitive keys', () => {
      const obj = { color: 'blue', size: 'large' };
      expect(sanitize(obj)).toEqual(obj);
    });

    it('should redact keys matching "password"', () => {
      const obj = { username: 'john', password: 'secret123' };
      expect(sanitize(obj)).toEqual({
        username: 'john',
        password: '[REDACTED]',
      });
    });

    it('should redact keys containing "secret" substring (case-insensitive)', () => {
      const obj = { api_secret: 'abc123', tag: 'test' };
      expect(sanitize(obj)).toEqual({
        api_secret: '[REDACTED]',
        tag: 'test',
      });
    });

    it('should redact keys containing "token" substring', () => {
      const obj = { access_token: 'xyz789', user: 'john' };
      expect(sanitize(obj)).toEqual({
        access_token: '[REDACTED]',
        user: 'john',
      });
    });

    it('should redact keys containing "key" substring (including in middle of word)', () => {
      const obj = { api_key: 'key-123', donkey: 'animal', settings: {} };
      expect(sanitize(obj)).toEqual({
        api_key: '[REDACTED]',
        donkey: '[REDACTED]',
        settings: {},
      });
    });

    it('should redact nested sensitive keys at depth 2', () => {
      const obj = {
        user: {
          city: 'NYC',
          password: 'nested-secret',
        },
      };
      expect(sanitize(obj)).toEqual({
        user: {
          city: 'NYC',
          password: '[REDACTED]',
        },
      });
    });

    it('should redact at depth 3 and return [REDACTED] at depth 4', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              level4: {
                password: 'too-deep',
              },
            },
          },
        },
      };
      const result = sanitize(obj) as Record<string, unknown>;
      const level1 = result.level1 as Record<string, unknown>;
      const level2 = level1.level2 as Record<string, unknown>;
      expect(level2.level3).toBe('[REDACTED]');
    });

    it('should sanitize each element in an array', () => {
      const arr = [
        { city: 'NYC', password: 'pass1' },
        { city: 'LA', password: 'pass2' },
      ];
      expect(sanitize(arr)).toEqual([
        { city: 'NYC', password: '[REDACTED]' },
        { city: 'LA', password: '[REDACTED]' },
      ]);
    });

    it('should redact CPF pattern values even if key is not sensitive', () => {
      const obj = { identifier: '123.456.789-09' };
      expect(sanitize(obj)).toEqual({ identifier: '[REDACTED]' });
    });

    it('should redact CNPJ pattern values', () => {
      const obj = { doc: '12.345.678/0001-90' };
      expect(sanitize(obj)).toEqual({ doc: '[REDACTED]' });
    });

    it('should redact phone pattern values', () => {
      const obj = { contact: '5511999999999' };
      expect(sanitize(obj)).toEqual({ contact: '[REDACTED]' });
    });

    it('should redact phone with + prefix', () => {
      const obj = { contact: '+5511999999999' };
      expect(sanitize(obj)).toEqual({ contact: '[REDACTED]' });
    });

    it('should redact email key from SENSITIVE_KEYS', () => {
      const obj = { email: 'user@example.com', other: 'data' };
      expect(sanitize(obj)).toEqual({
        email: '[REDACTED]',
        other: 'data',
      });
    });

    it('should redact name key from SENSITIVE_KEYS', () => {
      const obj = { name: 'John Doe', age: 30 };
      expect(sanitize(obj)).toEqual({
        name: '[REDACTED]',
        age: 30,
      });
    });

    it('should handle mixed objects with some sensitive and some non-sensitive keys', () => {
      const obj = {
        color: 'blue',
        email: 'john@example.com',
        age: 30,
        city: 'NYC',
      };
      expect(sanitize(obj)).toEqual({
        color: 'blue',
        email: '[REDACTED]',
        age: 30,
        city: 'NYC',
      });
    });

    it('should do case-insensitive key matching', () => {
      const obj = { Password: 'Secret', EMAIL: 'test@test.com' };
      expect(sanitize(obj)).toEqual({
        Password: '[REDACTED]',
        EMAIL: '[REDACTED]',
      });
    });

    it('should redact cpf key from SENSITIVE_KEYS', () => {
      const obj = { cpf: '111.222.333-44' };
      expect(sanitize(obj)).toEqual({ cpf: '[REDACTED]' });
    });

    it('should redact keys containing "secret" substring', () => {
      const obj = { clientSecret: 'shhh', normal: 'value' };
      expect(sanitize(obj)).toEqual({
        clientSecret: '[REDACTED]',
        normal: 'value',
      });
    });

    it('should redact keys containing "token" substring', () => {
      const obj = { refreshToken: 'rt-xxx', data: 'ok' };
      expect(sanitize(obj)).toEqual({
        refreshToken: '[REDACTED]',
        data: 'ok',
      });
    });

    it('should redact deep objects at depth boundary returning [REDACTED]', () => {
      const obj = {
        a: {
          b: {
            c: {
              d: {
                password: 'deep',
              },
            },
          },
        },
      };
      const result = sanitize(obj) as Record<string, unknown>;
      const a = result.a as Record<string, unknown>;
      const b = a.b as Record<string, unknown>;
      expect(b.c).toBe('[REDACTED]');
    });

    it('should handle empty object', () => {
      expect(sanitize({})).toEqual({});
    });

    it('should handle empty array', () => {
      expect(sanitize([])).toEqual([]);
    });

    it('should redact authorization key from SENSITIVE_KEYS', () => {
      const obj = { authorization: 'Bearer abc.def', method: 'POST' };
      expect(sanitize(obj)).toEqual({
        authorization: '[REDACTED]',
        method: 'POST',
      });
    });

    it('should redact cookie key from SENSITIVE_KEYS', () => {
      const obj = { cookie: 'session=xyz', host: 'api.example.com' };
      expect(sanitize(obj)).toEqual({
        cookie: '[REDACTED]',
        host: 'api.example.com',
      });
    });

    it('should redact auth and bearer keys from SENSITIVE_KEYS', () => {
      const obj = { auth: 'Basic abc', bearer: 'xyz', keep: 1 };
      expect(sanitize(obj)).toEqual({
        auth: '[REDACTED]',
        bearer: '[REDACTED]',
        keep: 1,
      });
    });

    it('should redact Bearer token values even under non-sensitive keys', () => {
      const obj = { header: 'Bearer sk-abcdef1234567890' };
      expect(sanitize(obj)).toEqual({ header: '[REDACTED]' });
    });

    it('should redact sk- API key values', () => {
      const obj = { leaked: 'sk-proj-abcdefgh12345678' };
      expect(sanitize(obj)).toEqual({ leaked: '[REDACTED]' });
    });

    it('should redact JWT values', () => {
      const obj = {
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
      };
      expect(sanitize(obj)).toEqual({ jwt: '[REDACTED]' });
    });

    it('should not redact ordinary strings that only resemble tokens', () => {
      const obj = { note: 'hello world' };
      expect(sanitize(obj)).toEqual({ note: 'hello world' });
    });
  });
});
