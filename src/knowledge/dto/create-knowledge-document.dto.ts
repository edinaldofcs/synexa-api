import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateKnowledgeDocumentDto {
  @IsString()
  title!: string;

  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsString()
  source_type?: string;

  @IsOptional()
  @IsString()
  source_url?: string;

  @IsOptional()
  @IsString()
  media_asset_id?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
