import { tenantLocalStorage } from '../auth/tenant-context';
import { ForbiddenException } from '@nestjs/common';

export interface TenantContext {
  userId: string;
  companyId: string;
  role: string;
}

export function extractTenantContext(user: any): TenantContext {
  if (!user) {
    throw new ForbiddenException('Acesso negado: usuário não autenticado');
  }

  const userId = user.id || user.sub;
  const companyId = user.company_id || null;
  const role = user.role || 'operator';

  if (!userId) {
    throw new ForbiddenException(
      'Acesso negado: ID do usuário não encontrado no token',
    );
  }

  return { userId, companyId, role };
}

export function assertTenantAccess(
  userCompanyId: string,
  resourceCompanyId: string,
): void {
  if (userCompanyId !== resourceCompanyId) {
    throw new ForbiddenException('Acesso negado: tenant mismatch');
  }
}

export function applyTenantFilter(userCompanyId: string): {
  company_id: string;
} {
  return { company_id: userCompanyId };
}

/** Resolve a empresa efetiva sem consultar o usuário original dentro do tenant visitado. */
export async function resolveUserCompanyId(
  prisma: {
    users: {
      findUnique: (args: any) => Promise<{ company_id: string } | null>;
    };
  },
  userId: string,
): Promise<string> {
  const context = tenantLocalStorage.getStore();
  if (context) {
    if (context.userId !== userId || !context.companyId) {
      throw new ForbiddenException('Invalid tenant context');
    }
    return context.companyId;
  }
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { company_id: true },
  });
  if (!user?.company_id) throw new ForbiddenException('User has no company');
  return user.company_id;
}
