export const ROLES = {
  PLATFORM_ADMIN: 'platform_admin',
  COMPANY_ADMIN: 'company_admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
} as const;

export type UserRole = (typeof ROLES)[keyof typeof ROLES];

export const ASSIGNABLE_ROLES: UserRole[] = [
  ROLES.COMPANY_ADMIN,
  ROLES.OPERATOR,
  ROLES.VIEWER,
];

export function isPlatformAdmin(role?: string | null): boolean {
  return role === ROLES.PLATFORM_ADMIN;
}

export function isCompanyAdmin(role?: string | null): boolean {
  return role === ROLES.COMPANY_ADMIN;
}
