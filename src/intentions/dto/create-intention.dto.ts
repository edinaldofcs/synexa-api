import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreateIntentionDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
