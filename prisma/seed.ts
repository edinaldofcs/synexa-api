import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env.prod') });

const prisma = new PrismaClient();
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CLIENT_ID  = '00000000-0000-0000-0000-000000000002';
const KB_ID      = '00000000-0000-0000-0000-000000000003';
const END_USER_ID = '00000000-0000-0000-0000-000000000004';

async function main() {
  console.log('=== Seed Synexa Enterprise ===\n');

  // ── 0. Clean all tables ──────────────────────────────────────
  console.log('Limpando dados existentes...');
  const tables = [
    'knowledge_embeddings', 'knowledge_chunks', 'knowledge_documents', 'knowledge_bases',
    'message_parts', 'message_events', 'tool_calls', 'agent_runs',
    'webhook_deliveries', 'webhook_endpoints',
    'channel_identities', 'end_users', 'inbound_events',
    'outbox_events', 'media_assets',
    'messages', 'conversation_state', 'conversations',
    'channel_connections',
    'painel_clients', 'painel_agents', 'painel_apis', 'painel_intentions',
    'users',
    'companies',
  ];
  for (const t of tables) {
    try { await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`); } catch { /* table may not exist */ }
  }

  // also remove from auth
  try {
    const { data: users } = await supabase.auth.admin.listUsers();
    for (const u of users.users) {
      if (u.email === 'admin@synexa.com.br') {
        await supabase.auth.admin.deleteUser(u.id);
      }
    }
  } catch {}
  console.log('  OK\n');

  // ── 1. Company ───────────────────────────────────────────────
  await prisma.companies.create({
    data: { id: COMPANY_ID, name: 'Synexa Admin', cnpj: '12.345.678/0001-90', plan: 'scale', status: 'active' },
  });
  console.log(`[companies]     ${COMPANY_ID}`);

  // ── 2. Auth User ─────────────────────────────────────────────
  const email = 'admin@synexa.com.br';
  const password = 'SynexaAdmin2026!';

  const { data: auth, error: authError } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name: 'Administrador Synexa' },
  });
  if (authError) throw authError;
  const userId = auth.user!.id;

  await prisma.users.create({
    data: { id: userId, company_id: COMPANY_ID, name: 'Administrador Synexa', role: 'admin' },
  });
  console.log(`[users]         ${userId} (admin@synexa.com.br)`);

  // ── 3. Painel Client ─────────────────────────────────────────
  await prisma.painel_clients.create({
    data: { id: CLIENT_ID, company_id: COMPANY_ID, company_name: 'Cliente Teste', status: 'active', phone_number: '5511999999999' },
  });
  console.log(`[painel_clients] ${CLIENT_ID} (Cliente Teste)`);

  // ── 4. Channel Connections ───────────────────────────────────
  const apiConn = await prisma.channel_connections.create({
    data: {
      company_id: COMPANY_ID, client_id: CLIENT_ID,
      channel_type: 'api', provider: 'synexa', status: 'active',
      inbound_secret_hash: 'test-secret-api-key',
    },
  });

  const waConn = await prisma.channel_connections.create({
    data: {
      company_id: COMPANY_ID, client_id: CLIENT_ID,
      channel_type: 'whatsapp', provider: 'evolution',
      provider_account_id: '5511999999999', status: 'active',
      config: { instanceUrl: 'https://evo.example.com', apiKey: 'evo-key' } as any,
      inbound_secret_hash: 'test-secret-whatsapp',
    },
  });
  console.log(`[channel_connections] ${apiConn.id} (api)`);
  console.log(`[channel_connections] ${waConn.id} (whatsapp)`);

  // ── 5. Webhook ───────────────────────────────────────────────
  await prisma.webhook_endpoints.create({
    data: {
      client_id: CLIENT_ID, channel_connection_id: apiConn.id,
      url: 'https://httpbin.org/post',
      events: ['message.completed', 'message.failed'] as any,
      secret_hash: 'webhook-secret', enabled: true,
    },
  });
  console.log(`[webhook_endpoints] (httpbin.org/post)`);

  // ── 6. Knowledge Base ────────────────────────────────────────
  await prisma.knowledge_bases.create({
    data: { id: KB_ID, company_id: COMPANY_ID, client_id: CLIENT_ID, name: 'Base de Conhecimento Padrao', description: 'Base para testes RAG', status: 'active' },
  });
  console.log(`[knowledge_bases] ${KB_ID}`);

  // ── 7. End User + Identity ───────────────────────────────────
  await prisma.end_users.create({
    data: { id: END_USER_ID, company_id: COMPANY_ID, client_id: CLIENT_ID, name: 'Usuario Teste' },
  });

  await prisma.channel_identities.create({
    data: {
      company_id: COMPANY_ID, client_id: CLIENT_ID, end_user_id: END_USER_ID,
      channel_type: 'api', external_user_id: 'test-user-1',
    },
  });
  console.log(`[end_users]       ${END_USER_ID} (test-user-1)`);

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n=== Seed completo ===');
  console.log(`Entrada          | Valor`);
  console.log(`------------------|----------------------------------------`);
  console.log(`Login             | ${email}`);
  console.log(`Senha             | ${password}`);
  console.log(`company_id        | ${COMPANY_ID}`);
  console.log(`client_id         | ${CLIENT_ID}`);
  console.log(`channel_conn (api)| ${apiConn.id}`);
  console.log(`channel_conn (wa) | ${waConn.id}`);
  console.log(`api_key (secret)  | test-secret-api-key`);
  console.log(`end_user          | test-user-1`);
  console.log(`user_id (auth)    | ${userId}`);
}

main()
  .catch(err => { console.error('\nErro:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
