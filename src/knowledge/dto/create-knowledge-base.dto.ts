import { IsObject, IsOptional, IsString } from 'class-validator';

export class CreateKnowledgeBaseDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
