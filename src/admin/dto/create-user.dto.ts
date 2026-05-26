import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsEmail,
  MinLength,
  IsUUID,
} from 'class-validator';

export class AdminCreateUserDto {
  @IsEmail({}, { message: 'Email inválido' })
  @IsNotEmpty({ message: 'Email é obrigatório' })
  email: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  password?: string;

  @IsOptional()
  @IsIn(['admin', 'operator', 'viewer'], { message: 'Role inválida' })
  role?: string;

  @IsUUID('4', { message: 'company_id deve ser um UUID válido' })
  @IsNotEmpty({ message: 'company_id é obrigatório' })
  company_id: string;

  @IsOptional()
  @IsString()
  name?: string;
}
