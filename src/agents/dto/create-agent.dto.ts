import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ActivationCondition, ActivationConditionGroup } from './activation-condition.dto';

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

  @IsBoolean()
  @IsOptional()
  is_initial?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ActivationConditionGroup)
  activation_conditions?: ActivationConditionGroup | null;

  @IsString()
  @IsOptional()
  @IsIn(['on_next_message', 'immediate'])
  activation_mode?: string;

  @IsArray()
  @IsOptional()
  allowed_tool_names?: string[];

  @IsString()
  @IsOptional()
  llm_provider?: string;
}
