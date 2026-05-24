import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsObject,
} from 'class-validator';

export class UpdateApiDto {
  @IsString()
  @IsOptional()
  agent_id?: string;

  @IsString()
  @IsOptional()
  next_api_id?: string | null;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  field_description?: string;

  @IsString()
  @IsOptional()
  method?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsBoolean()
  @IsOptional()
  visible_to_agent?: boolean;

  @IsObject()
  @IsOptional()
  request_schema?: unknown;

  @IsObject()
  @IsOptional()
  body?: unknown;

  @IsObject()
  @IsOptional()
  response_schema?: unknown;

  @IsObject()
  @IsOptional()
  extract_data?: unknown;

  @IsInt()
  @IsOptional()
  execution_order?: number;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
