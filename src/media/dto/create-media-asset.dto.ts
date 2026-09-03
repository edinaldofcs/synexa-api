import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
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
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'source_url deve ser uma URL válida http ou https' },
  )
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
