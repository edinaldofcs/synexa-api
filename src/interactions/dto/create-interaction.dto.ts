import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsObject,
  IsArray,
  IsEnum,
} from 'class-validator';

export class CreateInteractionDto {
  @IsString()
  company_id: string;

  @IsString()
  client_id: string;

  @IsOptional()
  @IsString()
  agent_id?: string;

  @IsString()
  session_id: string;

  @IsOptional()
  @IsString()
  channel?: string; // 'voice_webrtc' | 'voice_sip' | 'whatsapp' | 'webchat'

  @IsOptional()
  @IsString()
  direction?: string; // 'inbound' | 'outbound'

  @IsOptional()
  @IsString()
  interaction_mode?: string;

  @IsOptional()
  @IsString()
  client_identifier?: string;

  @IsOptional()
  @IsString()
  company_identifier?: string;

  @IsOptional()
  @IsString()
  client_name?: string;

  @IsOptional()
  @IsString()
  agent_name?: string;

  @IsOptional()
  @IsObject()
  context_variables?: Record<string, any>;

  @IsOptional()
  @IsArray()
  messages?: any[];
}
