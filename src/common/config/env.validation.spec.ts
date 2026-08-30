import 'reflect-metadata';
import {
  validateEnv,
  EnvironmentVariables,
  transformBoolean,
} from './env.validation';

const baseConfig = {
  ENVIRONMENT: 'development',
  DATABASE_URL: 'postgresql://localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'this-is-a-very-long-jwt-secret-key!',
};

describe('validateEnv', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('valid configurations', () => {
    it('should accept a minimal valid config', () => {
      const result = validateEnv(baseConfig);
      expect(result).toBeInstanceOf(EnvironmentVariables);
      expect(result.DATABASE_URL).toBe(baseConfig.DATABASE_URL);
      expect(result.REDIS_URL).toBe(baseConfig.REDIS_URL);
      expect(result.JWT_SECRET).toBe(baseConfig.JWT_SECRET);
    });

    it('should accept a full valid config', () => {
      const fullConfig = {
        ...baseConfig,
        PORT: '4000',
        ENVIRONMENT: 'development',
        NODE_ENV: 'development',
        DIRECT_URL: 'postgresql://localhost:5432/direct',
        CORS_ORIGIN: 'http://localhost:3000',
        BODY_LIMIT: '2mb',
        LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'gemini-key',
        GEMINI_MODEL: 'gemini-pro',
        LLM_MAX_RETRIES: '5',
        EXTERNAL_TOOL_TIMEOUT: '60000',
        SEED_ADMIN_PASSWORD: 'admin123',
        UPLOAD_MAX_SIZE: '10000000',
      };
      const result = validateEnv(fullConfig);
      expect(result).toBeInstanceOf(EnvironmentVariables);
      expect(result.DATABASE_URL).toBe(fullConfig.DATABASE_URL);
    });
  });

  describe('default values', () => {
    it('should default NODE_ENV to development', () => {
      const result = validateEnv(baseConfig);
      expect(result.NODE_ENV).toBe('development');
    });

    it('should reject a missing ENVIRONMENT', () => {
      const { ENVIRONMENT: _environment, ...config } = baseConfig;
      expect(() => validateEnv(config as any)).toThrow(/ENVIRONMENT/);
    });

    it('should default PORT to 3000', () => {
      const result = validateEnv(baseConfig);
      expect(result.PORT).toBe(3000);
    });

    it('should default BODY_LIMIT to 1mb', () => {
      const result = validateEnv(baseConfig);
      expect(result.BODY_LIMIT).toBe('1mb');
    });

    it('should default LLM_MAX_RETRIES to 2', () => {
      const result = validateEnv(baseConfig);
      expect(result.LLM_MAX_RETRIES).toBe(2);
    });

    it('should default EXTERNAL_TOOL_TIMEOUT to 30000', () => {
      const result = validateEnv(baseConfig);
      expect(result.EXTERNAL_TOOL_TIMEOUT).toBe(30000);
    });

    it('should default UPLOAD_MAX_SIZE to 52428800', () => {
      const result = validateEnv(baseConfig);
      expect(result.UPLOAD_MAX_SIZE).toBe(52428800);
    });
  });

  describe('validation errors', () => {
    it('should throw when DATABASE_URL is missing', () => {
      const config = { REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'key' };
      expect(() => validateEnv(config as any)).toThrow(
        'DATABASE_URL is required',
      );
    });

    it('should throw when REDIS_URL is missing', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'key',
      };
      expect(() => validateEnv(config as any)).toThrow('REDIS_URL is required');
    });

    it('should throw when JWT_SECRET is missing', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379',
      };
      expect(() => validateEnv(config as any)).toThrow(
        'JWT_SECRET is required',
      );
    });

    it('should throw when PORT is not a valid number', () => {
      const config = { ...baseConfig, PORT: 'not-a-number' };
      expect(() => validateEnv(config)).toThrow('PORT must be a valid number');
    });

    it('should throw when ENVIRONMENT is invalid', () => {
      const config = { ...baseConfig, ENVIRONMENT: 'invalid' };
      expect(() => validateEnv(config)).toThrow(/ENVIRONMENT/);
    });

    it('should throw when NODE_ENV is invalid', () => {
      const config = { ...baseConfig, NODE_ENV: 'invalid' };
      expect(() => validateEnv(config)).toThrow(/NODE_ENV/);
    });

    it('should throw for unknown properties', () => {
      const config = { ...baseConfig, UNKNOWN_PROP: 'value' };
      expect(() => validateEnv(config as any)).toThrow(/UNKNOWN_PROP/);
    });
  });

  describe('environment-specific checks', () => {
    it('should reject Supabase auth on a development worker', () => {
      const config = {
        ...baseConfig,
        SERVICE_ROLE: 'worker-agent',
        AUTH_PROVIDER: 'supabase',
      };
      expect(() => validateEnv(config)).toThrow(
        'Worker development runtime must use AUTH_PROVIDER=local',
      );
    });

    it('should throw in production when JWT_SECRET is less than 32 chars', () => {
      const config = {
        ...baseConfig,
        JWT_SECRET: 'short',
        ENVIRONMENT: 'production',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
        ENCRYPTION_KEY: 'a-32-character-encryption-key!',
      };
      expect(() => validateEnv(config)).toThrow(
        'JWT_SECRET must be at least 32 characters in production environment',
      );
    });

    it('should throw in production when ENCRYPTION_KEY is missing', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'production',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
      };
      expect(() => validateEnv(config)).toThrow(
        'ENCRYPTION_KEY must be at least 32 characters in production environment',
      );
    });

    it('should throw in production when ENCRYPTION_KEY is less than 32 chars', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'production',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
        ENCRYPTION_KEY: 'short',
      };
      expect(() => validateEnv(config)).toThrow(
        'ENCRYPTION_KEY must be at least 32 characters in production environment',
      );
    });

    it('should throw in production when SUPABASE_URL is missing', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'production',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
        ENCRYPTION_KEY: 'this-is-a-very-long-encryption-key!',
      };
      expect(() => validateEnv(config)).toThrow(
        'SUPABASE_URL is required in production/staging environment',
      );
    });

    it('should throw in staging when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'staging',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
      };
      expect(() => validateEnv(config)).toThrow(
        'SUPABASE_SERVICE_ROLE_KEY is required in production/staging environment',
      );
    });

    it('should throw in staging when SUPABASE_URL is missing', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'staging',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
      };
      expect(() => validateEnv(config)).toThrow(
        'SUPABASE_URL is required in production/staging environment',
      );
    });

    it('should accept development without SUPABASE credentials', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'development',
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it('should accept valid production config', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'production',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
        ENCRYPTION_KEY: 'this-is-a-very-long-encryption-key!',
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it('should accept valid staging config', () => {
      const config = {
        ...baseConfig,
        ENVIRONMENT: 'staging',
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISH_KEY: 'supabase-publish-key',
        SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
      };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  describe('boolean flags com transformBoolean (regression: "false" vira true)', () => {
    const booleanFlags: Array<[string, boolean]> = [
      ['FASTAGI_ENABLED', false],
      ['AUDIOSOCKET_ENABLED', false],
      ['AUDIO_GATE_ENABLED', true],
      ['GROQ_STT_ENABLED', false],
      ['GEMINI_CONTEXT_COMPRESSION_ENABLED', false],
    ];

    it.each(booleanFlags)(
      'converte %s="false" para false (não true)',
      (flag) => {
        const result = validateEnv({ ...baseConfig, [flag]: 'false' });
        expect(result[flag]).toBe(false);
      },
    );

    it.each(booleanFlags)('converte %s="true" para true', (flag) => {
      const result = validateEnv({ ...baseConfig, [flag]: 'true' });
      expect(result[flag]).toBe(true);
    });

    it.each(booleanFlags)('mantém default quando ausente (%s)', (flag, def) => {
      const result = validateEnv(baseConfig);
      expect(result[flag]).toBe(def);
    });

    it('transformBoolean cobre variantes de string', () => {
      expect(transformBoolean({ value: 'TRUE' })).toBe(true);
      expect(transformBoolean({ value: '1' })).toBe(true);
      expect(transformBoolean({ value: 'yes' })).toBe(true);
      expect(transformBoolean({ value: 'on' })).toBe(true);
      expect(transformBoolean({ value: 'false' })).toBe(false);
      expect(transformBoolean({ value: '0' })).toBe(false);
      expect(transformBoolean({ value: 'no' })).toBe(false);
      expect(transformBoolean({ value: 'off' })).toBe(false);
      expect(transformBoolean({ value: '' })).toBe(false);
      expect(transformBoolean({ value: true })).toBe(true);
      expect(transformBoolean({ value: false })).toBe(false);
      expect(transformBoolean({ value: 1 })).toBe(true);
      expect(transformBoolean({ value: 0 })).toBe(false);
      expect(transformBoolean({ value: 'garbage' })).toBe(false);
      expect(transformBoolean({ value: undefined })).toBe(false);
    });
  });
});
