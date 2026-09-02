import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantLocalStorage } from '../auth/tenant-context';

// Lista de modelos que possuem a coluna 'company_id' para aplicação do filtro
export const TENANT_SUPPORTED_MODELS = [
  'users',
  'conversations',
  'messages',
  'media_assets',
  'painel_clients',
  'channel_connections',
  'end_users',
  'channel_identities',
  'inbound_events',
  'outbox_events',
  'message_events',
  'agent_runs',
  'tool_calls',
  'knowledge_bases',
  'knowledge_documents',
  'knowledge_chunks',
  'knowledge_embeddings',
  'workflow_versions',
  'business_events',
  'provider_credentials',
  'credential_audit_logs',
  'painel_interactions',
  'voice_session_telemetry',
  'telephony_endpoints',
];

const WHERE_SCOPED_OPERATIONS = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
];

/**
 * Injeta o escopo de tenant nos args de uma operação Prisma.
 * Retorna os args possivelmente modificados (mutação intencional, igual ao comportamento original).
 */
export function applyTenantInjection(
  model: string | undefined,
  operation: string,
  args: any,
  companyId: string | undefined,
): any {
  if (!companyId || !model || !TENANT_SUPPORTED_MODELS.includes(model)) {
    return args;
  }

  const anyArgs = args as any;

  // Em operações que usam cláusula 'where', injeta o tenant ID
  if (WHERE_SCOPED_OPERATIONS.includes(operation)) {
    anyArgs.where = anyArgs.where || {};
    anyArgs.where.company_id = companyId;
  }

  // Em operações de criação de novos registros, garante que o company_id correto seja associado
  if (['create', 'createMany'].includes(operation)) {
    if (anyArgs.data) {
      if (Array.isArray(anyArgs.data)) {
        anyArgs.data = anyArgs.data.map((item) => ({
          ...item,
          company_id: companyId,
        }));
      } else {
        anyArgs.data.company_id = companyId;
      }
    }
  }

  return args;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  // Cliente Prisma estendido com filtros de tenant dinâmicos
  private readonly extendedClient = this.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = tenantLocalStorage.getStore();
          applyTenantInjection(model, operation, args, store?.companyId);
          return query(args);
        },
      },
    },
  });

  constructor() {
    super();
    // Retorna um Proxy para que qualquer chamada de modelo no PrismaService
    // seja delegada de forma transparente para o extendedClient com filtros
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop in target.extendedClient) {
          const value = Reflect.get(target.extendedClient, prop);
          return typeof value === 'function'
            ? value.bind(target.extendedClient)
            : value;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
