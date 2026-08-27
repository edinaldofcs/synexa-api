import { Matches } from 'class-validator';
import { UUID_SHAPE_REGEX } from '../../../common/validators/uuid-shape';

export class ImpersonateDto {
  @Matches(UUID_SHAPE_REGEX, {
    message: 'company_id deve ser um UUID válido',
  })
  company_id!: string;
}
