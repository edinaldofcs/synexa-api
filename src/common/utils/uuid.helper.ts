import { BadRequestException } from '@nestjs/common';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value?: string | null): boolean {
  if (!value || typeof value !== 'string') return false;
  return UUID_REGEX.test(value.trim());
}

export function validateUUID(id: string, fieldName = 'id'): string {
  if (!isUuid(id)) {
    throw new BadRequestException(`${fieldName} deve ser um UUID válido`);
  }
  return id;
}

