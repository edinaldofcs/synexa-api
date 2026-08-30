import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { ASSIGNABLE_ROLES } from '../../common/auth/roles.constants';
import { UUID_SHAPE_REGEX } from '../../common/validators/uuid-shape';

export class AdminCreateUserDto {
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, {
    message: 'Senha deve conter letras e números',
  })
  password?: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES, {
    message: `Role deve ser um de: ${ASSIGNABLE_ROLES.join(', ')}`,
  })
  role?: string;

  @IsOptional()
  @Matches(UUID_SHAPE_REGEX, {
    message: 'company_id deve ser um UUID válido',
  })
  company_id?: string;

  @IsOptional()
  @IsString()
  name?: string;
}
