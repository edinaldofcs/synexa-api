import {
  IsString,
  MinLength,
  IsNotEmpty,
  Matches,
  IsOptional,
  MaxLength,
} from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Token é obrigatório' })
  @MaxLength(16384)
  token: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  refreshToken?: string;

  @IsString()
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, {
    message: 'Senha deve conter letras e números',
  })
  password: string;
}
