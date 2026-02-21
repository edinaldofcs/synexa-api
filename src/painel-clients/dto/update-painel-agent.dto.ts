import { IsString, IsOptional, IsInt, IsBoolean } from 'class-validator';

export class UpdatePainelAgentDto {
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
