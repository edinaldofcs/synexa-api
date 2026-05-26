import { IsString, IsOptional, MaxLength } from 'class-validator';

export class ListModelsDto {
  @IsString()
  @MaxLength(50)
  provider: string;

  @IsString()
  @MaxLength(500)
  apiKey: string;
}
