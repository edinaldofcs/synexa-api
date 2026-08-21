import { IsString, IsOptional, IsBoolean, IsNumber } from 'class-validator';

export class UpdateSubagentDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  system_prompt?: string;

  @IsString()
  @IsOptional()
  llm_provider?: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsOptional()
  allowed_tool_names?: string[];

  @IsOptional()
  allowed_knowledge_base_ids?: string[];

  @IsNumber()
  @IsOptional()
  temperature?: number;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
