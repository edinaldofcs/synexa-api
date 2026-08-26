import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();
const isDevelopment = process.env.ENVIRONMENT === 'development';

async function main() {
  console.log('⚠️  === RESET DESTRUTIVO DO BANCO SYNEXA ===\n');

  const tables = [
    'knowledge_embeddings',
    'knowledge_chunks',
    'knowledge_documents',
    'knowledge_bases',
    'message_parts',
    'message_events',
    'tool_calls',
    'agent_runs',
    'webhook_deliveries',
    'webhook_endpoints',
    'channel_identities',
    'end_users',
    'inbound_events',
    'outbox_events',
    'media_assets',
    'messages',
    'conversation_state',
    'conversations',
    'channel_connections',
    'painel_clients',
    'painel_agents',
    'painel_apis',
    'painel_intentions',
    'credential_audit_logs',
    'provider_credentials',
    'users',
    'companies',
  ];

  for (const t of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
      console.log(`  [reset] Tabela "${t}" limpa com sucesso.`);
    } catch {
      // Tabela pode não existir
    }
  }

  if (
    !isDevelopment &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    try {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const { data: users } = await supabase.auth.admin.listUsers();
      for (const u of users.users) {
        if (u.email === 'admin@synexa.com.br') {
          await supabase.auth.admin.deleteUser(u.id);
          console.log(
            '  [reset] Usuário Supabase admin@synexa.com.br removido.',
          );
        }
      }
    } catch {}
  }

  console.log('\n✅ Reset do banco concluído com sucesso!');
}

main()
  .catch((err) => {
    console.error('\nErro no reset:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
