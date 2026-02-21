import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
} from 'class-validator';

export class CreatePainelAgentDto {
  @IsString()
  @IsNotEmpty()
  client_id: string; // Will receive as string (from params or body), converted to number in service

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  service_step?: string;

  @IsInt()
  @IsOptional()
  execution_order?: number;

  @IsString()
  @IsOptional()
  system_prompt?: string;

  @IsInt()
  @IsOptional()
  version?: number;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
