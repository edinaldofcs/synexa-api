import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateMediaAssetDto {
  @IsOptional()
  @IsIn(['pending', 'stored', 'processing', 'ready', 'failed'])
  status?: string;

  @IsOptional()
  @IsString()
  transcript?: string;

  @IsOptional()
  @IsString()
  ocr_text?: string;

  @IsOptional()
  @IsString()
  error_message?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
