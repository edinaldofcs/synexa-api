import { IsString, MinLength, IsNotEmpty, Matches } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Token é obrigatório' })
  token: string;

  @IsString()
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, {
    message: 'Senha deve conter letras e números',
  })
  password: string;
}
