import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MarkerConditionDto {
  @IsString()
  @MaxLength(100)
  variable!: string;

  @IsIn([
    'equals',
    'not_equals',
    'contains',
    'starts_with',
    'ends_with',
    'gt',
    'lt',
    'gte',
    'lte',
    'exists',
    'not_exists',
    'in',
    'not_in',
    'regex',
  ])
  operator!: string;

  @IsOptional()
  value?: unknown;
}

export class MarkerTriggerDto {
  /** Nome da ferramenta/API cujo retorno bem-sucedido dispara o marcador */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tool?: string;
}

export class BusinessMarkerDto {
  @IsString()
  @MaxLength(60)
  code!: string;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarkerTriggerDto)
  trigger?: MarkerTriggerDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarkerConditionDto)
  conditions?: MarkerConditionDto[];

  /** Variáveis do estado capturadas no momento do disparo (ex.: valores numéricos) */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capture?: string[];

  @IsOptional()
  @IsIn(['sum', 'count'])
  aggregate?: 'sum' | 'count';
}

export interface AnalyticsConfigPayload {
  markers: BusinessMarkerDto[];
  funnel: string[];
}

export class AnalyticsConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BusinessMarkerDto)
  markers!: BusinessMarkerDto[];

  @IsArray()
  @IsString({ each: true })
  funnel!: string[];
}

export class BusinessEventRecord {
  marker_code!: string;
  values!: Record<string, unknown>;
}
