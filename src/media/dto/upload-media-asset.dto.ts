import { IsObject, IsOptional, IsString } from 'class-validator';

export class UploadMediaAssetDto {
  @IsOptional()
  @IsString()
  message_id?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
