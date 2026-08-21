import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsNumber } from 'class-validator';

export class CreateSubagentDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsString()
  @IsNotEmpty()
  system_prompt: string;

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
