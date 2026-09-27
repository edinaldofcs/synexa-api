import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class PreviewTranscriptDto {
  @IsIn(['user', 'ai']) role: 'user' | 'ai';
  @IsString() @MaxLength(20000) text: string;
}

class PreviewToolDto {
  @IsString() @MaxLength(200) tool_name: string;
  @IsIn(['executing', 'success', 'error']) status: string;
  @Allow() result?: unknown;
}

export class CallPreviewDto {
  @IsOptional() @IsUUID() agent_id?: string;
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
