import { Prisma } from '@prisma/client';
import { tenantLocalStorage } from '../auth/tenant-context';
import type { PrismaService } from './prisma.service';

/** Merge only the supplied keys in PostgreSQL; parallel patches cannot erase each other. */
export async function patchConversationState(
  prisma: PrismaService,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tenant = tenantLocalStorage.getStore();
  const scope =
    tenant?.companyId && tenant.role !== 'platform_admin'
      ? Prisma.sql`AND c.company_id = ${tenant.companyId}::uuid`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<
    { state: Record<string, unknown> }[]
  >(Prisma.sql`
    INSERT INTO conversation_state (conversation_id, state)
    SELECT c.id, ${JSON.stringify(patch)}::jsonb
    FROM conversations c WHERE c.id = ${conversationId}::uuid ${scope}
    ON CONFLICT (conversation_id) DO UPDATE
      SET state = conversation_state.state || EXCLUDED.state
    RETURNING state
  `);
  if (!rows.length) throw new Error('conversation_state_not_found');
  return rows[0].state;
}
