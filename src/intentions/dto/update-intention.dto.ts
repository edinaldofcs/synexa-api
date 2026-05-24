import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class UpdateIntentionDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
