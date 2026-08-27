/**
 * Formato canônico de UUID SEM checagem de versão.
 * Necessário porque os ids legados de seeds/fixtures (ex.: 00000000-0000-0000-
 * 0000-000000000001) usam "versão 0", rejeitados pelo @IsUUID do class-validator,
 * embora sejam aceitos pelo Postgres (coluna uuid) e pelo Prisma.
 */
export const UUID_SHAPE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
