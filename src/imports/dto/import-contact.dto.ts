import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class ImportContactDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsArray()
  @ArrayMaxSize(10000)
  @IsObject({ each: true })
  data: Record<string, any>[];
}
