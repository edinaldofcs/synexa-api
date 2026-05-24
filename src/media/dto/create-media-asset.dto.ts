import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateMediaAssetDto {
  @IsString()
  @IsNotEmpty()
  mime_type!: string;

  @IsOptional()
  @IsString()
  message_id?: string;

  @IsOptional()
  @IsString()
  storage_bucket?: string;

  @IsOptional()
  @IsString()
  storage_path?: string;

  @IsOptional()
  @IsString()
  source_url?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  file_size?: number;

  @IsOptional()
  @IsString()
  checksum?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  duration_ms?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  height?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
