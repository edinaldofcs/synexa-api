import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ASSIGNABLE_ROLES, ROLES } from '../../common/auth/roles.constants';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn([...ASSIGNABLE_ROLES, ROLES.PLATFORM_ADMIN], {
    message: 'Role inválida',
  })
  role?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  password?: string;
}
