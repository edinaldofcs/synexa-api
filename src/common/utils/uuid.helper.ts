import { BadRequestException } from '@nestjs/common';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(id: string, fieldName = 'id'): string {
  if (!UUID_REGEX.test(id)) {
    throw new BadRequestException(`${fieldName} deve ser um UUID válido`);
  }
  return id;
}
