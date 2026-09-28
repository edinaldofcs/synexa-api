import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { UUID_SHAPE_REGEX } from '../../common/validators/uuid-shape';

class PreviewCorrelationDto {
  @IsOptional() @IsString() @MaxLength(200) id?: string;
  @IsOptional() @IsUUID() turn_id?: string;
  @IsOptional() @Matches(UUID_SHAPE_REGEX) agent_id?: string;
  @IsOptional() @IsISO8601() created_at?: string;
}

class PreviewTranscriptDto extends PreviewCorrelationDto {
  @IsIn(['user', 'ai']) role: 'user' | 'ai';
  @IsString() @MaxLength(20000) text: string;
}

class PreviewToolDto extends PreviewCorrelationDto {
  @IsOptional() @IsISO8601() completed_at?: string;
  @IsOptional() @IsObject() arguments?: Record<string, unknown>;
  @IsString() @MaxLength(200) tool_name: string;
  @IsIn(['executing', 'success', 'error']) status: string;
  @Allow() result?: unknown;
}

export class CallPreviewDto {
  @IsOptional() @IsBoolean() include_transcript?: boolean;
  @IsOptional() @IsIn([3]) payload_version?: 3;
  @IsOptional() @Matches(UUID_SHAPE_REGEX) agent_id?: string;
  @IsOptional() @IsString() @MaxLength(200) caller_number?: string;
  @IsOptional() @IsString() @MaxLength(200) dialed_number?: string;
  @IsOptional() @IsString() @MaxLength(200) end_reason?: string;
  @IsInt() @Min(0) @Max(604800) duration_seconds: number;
  @IsObject() variables: Record<string, unknown>;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PreviewTranscriptDto)
  transcript: PreviewTranscriptDto[];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PreviewToolDto)
  tools: PreviewToolDto[];
}
