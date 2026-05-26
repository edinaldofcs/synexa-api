import { IsString, IsOptional, IsArray, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ActivationCondition {
  @IsString()
  @IsOptional()
  variable: string;

  @IsString()
  @IsIn(['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'gt', 'lt', 'gte', 'lte', 'exists', 'not_exists', 'in', 'not_in', 'regex'])
  @IsOptional()
  operator: string;

  @IsOptional()
  value: unknown;
}

export class ActivationConditionGroup {
  @IsString()
  @IsIn(['AND', 'OR'])
  @IsOptional()
  logic: 'AND' | 'OR';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActivationCondition)
  @IsOptional()
  conditions: ActivationCondition[];
}
