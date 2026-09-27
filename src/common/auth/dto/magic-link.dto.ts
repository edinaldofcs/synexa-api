import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MagicLinkDto {
  @IsEmail({}, { message: 'Email inválido' })
  @IsNotEmpty({ message: 'Email é obrigatório' })
  email: string;
}

export class CompleteMagicLinkDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16384)
  token: string;
}
