import { plainToInstance, Transform } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  IsNumber,
  IsIn,
  IsBoolean,
  validateSync,
} from 'class-validator';

/**
 * Conversão explícita de boolean a partir de string de ambiente.
 * Com enableImplicitConversion o class-transformer converte 'false' em true
 * (Boolean('false')) ANTES do hook @Transform — portanto a normalização
 * também é aplicada nos valores brutos em validateEnv (ver BOOLEAN_ENV_FIELDS).
 */
export function transformBoolean({ value }: { value: unknown }): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return parseBooleanString(value);
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

function parseBooleanString(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return false;
}

// Campos booleanos lidos de env como string: normalizados antes do
// plainToInstance para que 'false' NÃO vire true na conversão implícita.
const BOOLEAN_ENV_FIELDS = [
  'FASTAGI_ENABLED',
  'AUDIOSOCKET_ENABLED',
  'AUDIO_GATE_ENABLED',
  'GROQ_STT_ENABLED',
  'GEMINI_CONTEXT_COMPRESSION_ENABLED',
] as const;

function normalizeBooleanEnvFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...config };
  for (const field of BOOLEAN_ENV_FIELDS) {
    const raw = normalized[field];
    if (typeof raw === 'string') {
      normalized[field] = parseBooleanString(raw);
    } else if (raw === undefined || raw === null) {
      delete normalized[field];
    }
  }
  return normalized;
}

export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
  TEST = 'test',
}

export enum NodeEnv {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}

export enum ServiceRole {
  API = 'api',
  VOICE = 'voice',
  WORKER = 'worker',
  WORKER_INGESTION = 'worker-ingestion',
  WORKER_AGENT = 'worker-agent',
  WORKER_DISPATCHER = 'worker-dispatcher',
  WORKER_MEDIA = 'worker-media',
  WORKER_KNOWLEDGE = 'worker-knowledge',
  WORKER_WEBHOOK = 'worker-webhook',
  WORKER_DLQ = 'worker-dlq',
}

export enum StorageProvider {
  LOCAL = 'local',
  SUPABASE = 'supabase',
  S3 = 's3',
}

export enum AuthProvider {
  LOCAL = 'local',
  SUPABASE = 'supabase',
}

export enum LlmProvider {
  GEMINI = 'gemini',
  GROQ = 'groq',
  OPENROUTER = 'openrouter',
  MOCK = 'mock',
}

export enum VoiceProvider {
  GEMINI = 'gemini',
  MOCK = 'mock',
}

export class EnvironmentVariables {
  @IsIn(Object.values(Environment))
  ENVIRONMENT!: string;

  @IsIn(Object.values(NodeEnv))
  @IsOptional()
  NODE_ENV?: string = NodeEnv.DEVELOPMENT;

  @IsIn(Object.values(ServiceRole))
  @IsOptional()
  SERVICE_ROLE?: string = ServiceRole.API;

  @IsIn(Object.values(StorageProvider))
  @IsOptional()
  STORAGE_PROVIDER?: string = StorageProvider.LOCAL;

  @IsIn(Object.values(AuthProvider))
  @IsOptional()
  AUTH_PROVIDER?: string = AuthProvider.LOCAL;

  @IsNumber({}, { message: 'PORT must be a valid number' })
  @IsOptional()
  PORT?: number = 3000;

  @IsNumber({}, { message: 'VOICE_PORT must be a valid number' })
  @IsOptional()
  VOICE_PORT?: number = 3001;

  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL is required' })
  DATABASE_URL: string;

  @IsString()
  @IsOptional()
  DIRECT_URL?: string;

  @IsUrl(
    { require_tld: false },
    { message: 'SUPABASE_URL must be a valid URL' },
  )
  @IsOptional()
  SUPABASE_URL?: string;

  @IsString()
  @IsOptional()
  SUPABASE_PUBLISH_KEY?: string;

  @IsString()
  @IsOptional()
  SUPABASE_SERVICE_ROLE_KEY?: string;

  @IsString()
  @IsNotEmpty({ message: 'REDIS_URL is required' })
  REDIS_URL: string;

  @IsString()
  @IsNotEmpty({ message: 'JWT_SECRET is required' })
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  CORS_ORIGIN?: string;

  @IsIn(['lax', 'strict', 'none'])
  @IsOptional()
  AUTH_COOKIE_SAME_SITE?: string = 'lax';

  @IsUrl({ require_tld: false })
  @IsOptional()
  AUTH_CALLBACK_URL?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  AUTH_FRONTEND_URL?: string;

  @IsString()
  @IsOptional()
  SMTP_HOST?: string;

  @IsNumber({}, { message: 'SMTP_PORT must be a valid number' })
  @IsOptional()
  SMTP_PORT?: number = 587;

  @IsIn(['true', 'false'])
  @IsOptional()
  SMTP_SECURE?: string = 'false';

  @IsString()
  @IsOptional()
  SMTP_USER?: string;

  @IsString()
  @IsOptional()
  SMTP_PASS?: string;

  @IsString()
  @IsOptional()
  SMTP_FROM?: string;

  @IsString()
  @IsOptional()
  BODY_LIMIT?: string = '1mb';

  @IsIn(Object.values(LlmProvider))
  @IsOptional()
  LLM_PROVIDER?: string = LlmProvider.MOCK;

  @IsIn(Object.values(VoiceProvider))
  @IsOptional()
  VOICE_PROVIDER?: string = VoiceProvider.MOCK;

  @IsString()
  @IsOptional()
  GEMINI_API_KEY?: string;

  @IsString()
  @IsOptional()
  GROQ_API_KEY?: string;

  @IsString()
  @IsOptional()
  OPENROUTER_API_KEY?: string;

  @IsString()
  @IsOptional()
  GEMINI_MODEL?: string;

  @IsString()
  @IsOptional()
  GROQ_MODEL?: string;

  @IsString()
  @IsOptional()
  OPENROUTER_MODEL?: string;

  @IsString()
  @IsOptional()
  OPENROUTER_HTTP_REFERER?: string;

  @IsString()
  @IsOptional()
  OPENROUTER_APP_TITLE?: string;

  @IsNumber({}, { message: 'LLM_MAX_RETRIES must be a valid number' })
  @IsOptional()
  LLM_MAX_RETRIES?: number = 2;

  @IsNumber({}, { message: 'EXTERNAL_TOOL_TIMEOUT must be a valid number' })
  @IsOptional()
  EXTERNAL_TOOL_TIMEOUT?: number = 30000;

  @IsNumber({}, { message: 'MOCK_LLM_LATENCY_MS must be a valid number' })
  @IsOptional()
  MOCK_LLM_LATENCY_MS?: number = 80;

  @IsNumber({}, { message: 'MOCK_VOICE_LATENCY_MS must be a valid number' })
  @IsOptional()
  MOCK_VOICE_LATENCY_MS?: number = 40;

  @IsString()
  @IsOptional()
  ENCRYPTION_KEY?: string;

  @IsString()
  @IsOptional()
  SEED_ADMIN_PASSWORD?: string;

  @IsNumber({}, { message: 'UPLOAD_MAX_SIZE must be a valid number' })
  @IsOptional()
  UPLOAD_MAX_SIZE?: number = 52428800;

  @IsNumber({}, { message: 'FASTAGI_PORT must be a valid number' })
  @IsOptional()
  FASTAGI_PORT?: number = 4573;

  @Transform(transformBoolean)
  @IsBoolean()
  @IsOptional()
  FASTAGI_ENABLED?: boolean = false;

  @IsNumber({}, { message: 'AUDIOSOCKET_PORT must be a valid number' })
  @IsOptional()
  AUDIOSOCKET_PORT?: number = 8090;

  @Transform(transformBoolean)
  @IsBoolean()
  @IsOptional()
  AUDIOSOCKET_ENABLED?: boolean = false;

  @IsString()
  @IsOptional()
  TELEPHONY_WS_TOKEN_PEPPER?: string;

  @IsString()
  @IsOptional()
  ASTERISK_AMI_HOST?: string;

  @IsNumber({}, { message: 'ASTERISK_AMI_PORT must be a valid number' })
  @IsOptional()
  ASTERISK_AMI_PORT?: number = 5038;

  @IsString()
  @IsOptional()
  ASTERISK_AMI_USER?: string;

  @IsString()
  @IsOptional()
  ASTERISK_AMI_SECRET?: string;

  @Transform(transformBoolean)
  @IsBoolean()
  @IsOptional()
  AUDIO_GATE_ENABLED?: boolean = true;

  @IsNumber({}, { message: 'AUDIO_GATE_THRESHOLD must be a valid number' })
  @IsOptional()
  AUDIO_GATE_THRESHOLD?: number = 500;

  @IsNumber(
    {},
    { message: 'AUDIO_GATE_HANGOVER_MARGIN_MS must be a valid number' },
  )
  @IsOptional()
  AUDIO_GATE_HANGOVER_MARGIN_MS?: number = 500;

  @IsNumber({}, { message: 'AUDIO_GATE_PREROLL_MS must be a valid number' })
  @IsOptional()
  AUDIO_GATE_PREROLL_MS?: number = 300;

  @Transform(transformBoolean)
  @IsBoolean()
  @IsOptional()
  GROQ_STT_ENABLED?: boolean = false;

  @IsString()
  @IsOptional()
  GROQ_STT_MODEL?: string = 'whisper-large-v3-turbo';

  @IsString()
  @IsOptional()
  GEMINI_LIVE_VOICE_MODEL?: string = 'gemini-3.1-flash-live-preview';

  @IsString()
  @IsOptional()
  GEMINI_LIVE_DEFAULT_VOICE?: string = 'Aoede';

  @Transform(transformBoolean)
  @IsBoolean()
  @IsOptional()
  GEMINI_CONTEXT_COMPRESSION_ENABLED?: boolean = false;

  @IsNumber(
    {},
    { message: 'GEMINI_WS_HANDSHAKE_TIMEOUT_MS must be a valid number' },
  )
  @IsOptional()
  GEMINI_WS_HANDSHAKE_TIMEOUT_MS?: number = 15000;

  // S15: mantida como string ('true'/'false') para compatibilidade com a
  // leitura === 'true' no ApiKeyGuard.
  @IsIn(['true', 'false'], {
    message: 'BYPASS_API_KEY_DEV must be "true" or "false"',
  })
  @IsOptional()
  BYPASS_API_KEY_DEV?: string;

  @IsNumber(
    {},
    { message: 'LLM_MAX_CONCURRENT_STREAMS must be a valid number' },
  )
  @IsOptional()
  LLM_MAX_CONCURRENT_STREAMS?: number = 5;
}

export function validateEnv(
  config: Record<string, unknown>,
  options: { forbidUnknown?: boolean } = {},
) {
  const forbidUnknown = options.forbidUnknown ?? true;
  const validatedConfig = plainToInstance(
    EnvironmentVariables,
    normalizeBooleanEnvFields(config),
    {
      enableImplicitConversion: true,
    },
  );

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
    whitelist: true,
    forbidNonWhitelisted: forbidUnknown,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => {
        const constraints = error.constraints
          ? Object.values(error.constraints).join(', ')
          : 'unknown validation error';
        return `${error.property}: ${constraints}`;
      })
      .join('\n');
    throw new Error(`Environment validation failed:\n${messages}`);
  }

  const serviceRole = validatedConfig.SERVICE_ROLE || ServiceRole.API;
  const isWorker =
    serviceRole === ServiceRole.WORKER || serviceRole.startsWith('worker-');

  if (isWorker && validatedConfig.ENVIRONMENT === Environment.DEVELOPMENT) {
    if (validatedConfig.AUTH_PROVIDER !== AuthProvider.LOCAL) {
      throw new Error(
        'Worker development runtime must use AUTH_PROVIDER=local',
      );
    }
  }

  if (
    validatedConfig.ENVIRONMENT !== Environment.DEVELOPMENT &&
    validatedConfig.ENVIRONMENT !== Environment.TEST
  ) {
    if (!validatedConfig.SUPABASE_URL) {
      throw new Error(
        'SUPABASE_URL is required in production/staging environment',
      );
    }
    if (!validatedConfig.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is required in production/staging environment',
      );
    }
    if (validatedConfig.AUTH_PROVIDER !== AuthProvider.SUPABASE) {
      throw new Error(
        'AUTH_PROVIDER must be supabase in production/staging environment',
      );
    }
    if (!validatedConfig.SUPABASE_PUBLISH_KEY) {
      throw new Error(
        'SUPABASE_PUBLISH_KEY is required for Supabase authentication',
      );
    }
  }

  if (validatedConfig.ENVIRONMENT === Environment.PRODUCTION) {
    if (!validatedConfig.JWT_SECRET || validatedConfig.JWT_SECRET.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters in production environment',
      );
    }
    if (
      !validatedConfig.ENCRYPTION_KEY ||
      validatedConfig.ENCRYPTION_KEY.length < 32
    ) {
      throw new Error(
        'ENCRYPTION_KEY must be at least 32 characters in production environment',
      );
    }
    if (validatedConfig.BYPASS_API_KEY_DEV === 'true') {
      throw new Error(
        'BYPASS_API_KEY_DEV cannot be enabled in production environment',
      );
    }
    if (validatedConfig.VOICE_PROVIDER === VoiceProvider.MOCK) {
      throw new Error(
        'VOICE_PROVIDER cannot be "mock" in production environment',
      );
    }
  }

  return validatedConfig;
}
