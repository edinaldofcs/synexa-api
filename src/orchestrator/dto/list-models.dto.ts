import { IsString, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class ListModelsDto {
  @IsString()
  @MaxLength(50)
  provider: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(36)
  clientId?: string;
}
