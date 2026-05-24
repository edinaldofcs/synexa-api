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

async function main() {
  console.log('=== Seed Synexa Enterprise ===\n');

  // 1. Company
  const company = await prisma.companies.upsert({
    where: { cnpj: '12.345.678/0001-90' },
    update: {},
    create: {
      name: 'Synexa Admin',
      cnpj: '12.345.678/0001-90',
      plan: 'scale',
      status: 'active',
    },
  });
  console.log(`[company] ${company.name} (${company.id})`);

  // 2. Auth User + Profile
  const email = 'admin@synexa.com.br';
  const password = 'SynexaAdmin2026!';

  let userId: string;
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: 'Administrador Synexa' },
  });

  if (authError) {
    if (authError.message.includes('already registered') || authError.message.includes('already been registered')) {
      const { data: users } = await supabase.auth.admin.listUsers();
      const existing = users.users.find(u => u.email === email);
      if (!existing) throw new Error('User not found');
      userId = existing.id;
      console.log(`[auth] Usuario ja existia: ${email}`);
    } else {
      throw authError;
    }
  } else {
    userId = authUser.user!.id;
    console.log(`[auth] Usuario criado: ${email}`);
  }

  await prisma.users.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, company_id: company.id, name: 'Administrador Synexa', role: 'admin' },
  });
  console.log(`[user] Perfil criado (${userId})`);

  // 3. Painel Client
  const client = await prisma.painel_clients.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      company_id: company.id,
      company_name: 'Cliente Teste',
      status: 'active',
      phone_number: '5511999999999',
    },
  });
  console.log(`[client] ${client.company_name} (${client.id})`);

  // 4. Channel Connection (API)
  const apiConn = await prisma.channel_connections.upsert({
    where: { client_id_channel_type: { client_id: client.id, channel_type: 'api' } },
    update: {},
    create: {
      company_id: company.id,
      client_id: client.id,
      channel_type: 'api',
      provider: 'synexa',
      status: 'active',
      inbound_secret_hash: 'test-secret-api-key',
    },
  });
  console.log(`[channel] API connection (${apiConn.id})`);

  // 5. Channel Connection (WhatsApp)
  const waConn = await prisma.channel_connections.upsert({
    where: { client_id_channel_type: { client_id: client.id, channel_type: 'whatsapp' } },
    update: {},
    create: {
      company_id: company.id,
      client_id: client.id,
      channel_type: 'whatsapp',
      provider: 'evolution',
      provider_account_id: '5511999999999',
      status: 'active',
      config: { instanceUrl: 'https://evo.example.com', apiKey: 'evo-key' } as any,
      inbound_secret_hash: 'test-secret-whatsapp',
    },
  });
  console.log(`[channel] WhatsApp connection (${waConn.id})`);

  // 6. Webhook Endpoint
  const webhook = await prisma.webhook_endpoints.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      client_id: client.id,
      channel_connection_id: apiConn.id,
      url: 'https://httpbin.org/post',
      events: ['message.completed', 'message.failed'] as any,
      secret_hash: 'webhook-secret',
      enabled: true,
    },
  });
  console.log(`[webhook] ${webhook.url} (${webhook.id})`);

  // 7. Knowledge Base
  const kb = await prisma.knowledge_bases.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      company_id: company.id,
      client_id: client.id,
      name: 'Base de Conhecimento Padrao',
      description: 'Base para testes RAG',
      status: 'active',
    },
  });
  console.log(`[knowledge] ${kb.name} (${kb.id})`);

  // 8. End-User + Identity (for testing)
  const endUser = await prisma.end_users.upsert({
    where: { id: '00000000-0000-0000-0000-000000000004' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000004',
      company_id: company.id,
      client_id: client.id,
      name: 'Usuario Teste',
    },
  });
  console.log(`[end_user] ${endUser.name} (${endUser.id})`);

  await prisma.channel_identities.upsert({
    where: {
      client_id_channel_type_external_user_id: {
        client_id: client.id,
        channel_type: 'api',
        external_user_id: 'test-user-1',
      },
    },
    update: {},
    create: {
      company_id: company.id,
      client_id: client.id,
      end_user_id: endUser.id,
      channel_type: 'api',
      external_user_id: 'test-user-1',
    },
  });
  console.log(`[identity] test-user-1 -> ${endUser.id}`);

  console.log('\n=== Seed completo ===');
  console.log(`Login: ${email}`);
  console.log(`Senha: ${password}`);
  console.log(`client_id: ${client.id}`);
  console.log(`channel_connection api: ${apiConn.id}`);
  console.log(`channel_connection whatsapp: ${waConn.id}`);
  console.log(`end_user: test-user-1`);
  console.log(`secret api: test-secret-api-key`);
  console.log(`secret whatsapp: test-secret-whatsapp`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
