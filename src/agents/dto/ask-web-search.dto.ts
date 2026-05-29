import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AskWebSearchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  question?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  pergunta?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  query?: string;
}
