import { plainToInstance } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsUrl,
  IsNumber,
  IsIn,
  validateSync,
} from 'class-validator';

export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export enum NodeEnv {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
}

export enum LlmProvider {
  GEMINI = 'gemini',
  GROQ = 'groq',
  OPENROUTER = 'openrouter',
}

export class EnvironmentVariables {
  @IsIn(Object.values(Environment))
  @IsOptional()
  ENVIRONMENT?: string = Environment.DEVELOPMENT;

  @IsIn(Object.values(NodeEnv))
  @IsOptional()
  NODE_ENV?: string = NodeEnv.DEVELOPMENT;

  @IsNumber({}, { message: 'PORT must be a valid number' })
  @IsOptional()
  PORT?: number = 3000;

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

  @IsString()
  @IsOptional()
  BODY_LIMIT?: string = '1mb';

  @IsIn(Object.values(LlmProvider))
  @IsOptional()
  LLM_PROVIDER?: string;

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

  @IsString()
  @IsOptional()
  ENCRYPTION_KEY?: string;

  @IsString()
  @IsOptional()
  SEED_ADMIN_PASSWORD?: string;

  @IsNumber({}, { message: 'UPLOAD_MAX_SIZE must be a valid number' })
  @IsOptional()
  UPLOAD_MAX_SIZE?: number = 52428800;
}

export function validateEnv(
  config: Record<string, unknown>,
  options: { forbidUnknown?: boolean } = {},
) {
  const forbidUnknown = options.forbidUnknown ?? true;
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

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

  if (validatedConfig.ENVIRONMENT !== Environment.DEVELOPMENT) {
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
  }

  return validatedConfig;
}
