import { IsString, IsArray, IsOptional } from 'class-validator';

export class ImportContactsDto {
  @IsString()
  userId: string;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsString()
  @IsOptional()
  fileType?: string;

  @IsArray()
  data: Record<string, unknown>[];
}
