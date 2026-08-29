import {
  IsString,
  IsOptional,
  MaxLength,
  ValidateIf,
  Allow,
  IsBoolean,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @IsOptional()
  @MaxLength(36)
  user_id?: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  company_name?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(255)
  agent_name?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  logo_url?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  logo_icon?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  voice_name?: string | null;

  @Allow()
  @IsOptional()
  audio_gate_enabled?: boolean | null;

  @Allow()
  @IsOptional()
  audio_gate_threshold?: number | null;

  @Allow()
  @IsOptional()
  audio_gate_hangover_margin_ms?: number | null;

  @Allow()
  @IsOptional()
  audio_gate_preroll_ms?: number | null;

  @Allow()
  @IsOptional()
  hybrid_stt_enabled?: boolean | null;

  @Allow()
  @IsOptional()
  gemini_thinking_budget?: number | null;

  @Allow()
  @IsOptional()
  gemini_thinking_level?: string | null;

  @Allow()
  @IsOptional()
  context_compression_enabled?: boolean | null;

  @Allow()
  @IsOptional()
  metadata?: Record<string, unknown> | null;

  // FALSE = IA de texto roda inline no processo da API (sem fila BullMQ)
  @IsOptional()
  @IsBoolean()
  queue_enabled?: boolean;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  sip_extension?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  telephony_provider?: string | null;
}
