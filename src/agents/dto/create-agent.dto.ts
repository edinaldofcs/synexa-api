import { IsString, IsOptional, IsInt, IsBoolean, IsArray } from 'class-validator';

export class CreateAgentDto {
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

  @IsArray()
  @IsOptional()
  allowed_tool_names?: string[];
}
