import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as bcrypt from 'bcrypt';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

// IDs Determinísticos para Fixtures
const COMPANY_B_ID = '00000000-0000-0000-0000-00000000000b';
const USER_B_ID = '00000000-0000-0000-0000-00000000005b';
const CLIENT_B_ID = '00000000-0000-0000-0000-00000000002b';

const CONV_1_ID = '00000000-0000-0000-0000-000000000101';
const CONV_2_ID = '00000000-0000-0000-0000-000000000102';
const MSG_1_ID = '00000000-0000-0000-0000-000000000201';
const MSG_2_ID = '00000000-0000-0000-0000-000000000202';
const MSG_3_ID = '00000000-0000-0000-0000-000000000203';

const DOC_1_ID = '00000000-0000-0000-0000-000000000301';
const CHUNK_1_ID = '00000000-0000-0000-0000-000000000401';

async function main() {
  console.log('=== Carregando Fixtures Ricas de Teste e Desenvolvimento ===\n');

  const COMPANY_A_ID = '00000000-0000-0000-0000-000000000001';
  const CLIENT_A_ID = '00000000-0000-0000-0000-000000000002';
  const KB_A_ID = '00000000-0000-0000-0000-000000000003';

  // ── 1. Empresa B (Multi-tenancy Isolation Test) ───────────────
  await prisma.companies.upsert({
    where: { id: COMPANY_B_ID },
    update: { name: 'Empresa Beta Ltda', plan: 'enterprise', status: 'active' },
    create: {
      id: COMPANY_B_ID,
      name: 'Empresa Beta Ltda',
      cnpj: '98.765.432/0001-10',
      plan: 'enterprise',
      status: 'active',
    },
  });

  const password_hash = await bcrypt.hash('BetaAdmin2026!', 10);
  await prisma.users.upsert({
    where: { id: USER_B_ID },
    update: { name: 'Admin Beta', email: 'admin@beta.com.br', role: 'admin' },
    create: {
      id: USER_B_ID,
      company_id: COMPANY_B_ID,
      name: 'Admin Beta',
      email: 'admin@beta.com.br',
      password_hash,
      role: 'admin',
    },
  });

  await prisma.painel_clients.upsert({
    where: { id: CLIENT_B_ID },
    update: { company_name: 'Cliente Beta Teste', status: 'active' },
    create: {
      id: CLIENT_B_ID,
      company_id: COMPANY_B_ID,
      company_name: 'Cliente Beta Teste',
      status: 'active',
      agent_name: 'Assistente Beta',
    },
  });

  console.log(`[fixtures] Empresa B criada para testes de isolamento: ${COMPANY_B_ID}`);

  // ── 2. Conversas e Mensagens ─────────────────────────────────
  await prisma.conversations.upsert({
    where: { id: CONV_1_ID },
    update: { status: 'active' },
    create: {
      id: CONV_1_ID,
      company_id: COMPANY_A_ID,
      client_id: CLIENT_A_ID,
      origin_channel: 'whatsapp',
      external_conversation_key: 'conv-wa-001',
      status: 'active',
      last_message_at: new Date(),
    },
  });

  await prisma.conversations.upsert({
    where: { id: CONV_2_ID },
    update: { status: 'closed' },
    create: {
      id: CONV_2_ID,
      company_id: COMPANY_A_ID,
      client_id: CLIENT_A_ID,
      origin_channel: 'api',
      external_conversation_key: 'conv-api-002',
      status: 'closed',
      last_message_at: new Date(Date.now() - 3600000),
    },
  });

  await prisma.messages.upsert({
    where: { id: MSG_1_ID },
    update: { content: 'Olá, gostaria de informações sobre produtos e horários.' },
    create: {
      id: MSG_1_ID,
      company_id: COMPANY_A_ID,
      conversation_id: CONV_1_ID,
      direction: 'inbound',
      channel: 'whatsapp',
      sender_type: 'customer',
      content: 'Olá, gostaria de informações sobre produtos e horários.',
      status: 'received',
    },
  });

  await prisma.messages.upsert({
    where: { id: MSG_2_ID },
    update: { content: 'Olá! Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.' },
    create: {
      id: MSG_2_ID,
      company_id: COMPANY_A_ID,
      conversation_id: CONV_1_ID,
      direction: 'outbound',
      channel: 'whatsapp',
      sender_type: 'ai',
      content: 'Olá! Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.',
      status: 'sent',
    },
  });

  await prisma.messages.upsert({
    where: { id: MSG_3_ID },
    update: { content: 'Perfeito, muito obrigado!' },
    create: {
      id: MSG_3_ID,
      company_id: COMPANY_A_ID,
      conversation_id: CONV_1_ID,
      direction: 'inbound',
      channel: 'whatsapp',
      sender_type: 'customer',
      content: 'Perfeito, muito obrigado!',
      status: 'received',
    },
  });

  console.log(`[fixtures] Conversas e mensagens criadas (CONV_1: ${CONV_1_ID})`);

  // ── 3. Documento RAG, Chunks e Vetores Sintéticos ─────────────
  await prisma.knowledge_documents.upsert({
    where: { id: DOC_1_ID },
    update: { title: 'Manual de Políticas e Horários', status: 'ready' },
    create: {
      id: DOC_1_ID,
      company_id: COMPANY_A_ID,
      client_id: CLIENT_A_ID,
      knowledge_base_id: KB_A_ID,
      title: 'Manual de Políticas e Horários',
      source_type: 'text',
      status: 'ready',
      metadata: {
        raw_content: 'A Synexa opera 24/7 com suporte automatizado e agentes de voz integrados.',
      } as any,
    },
  });

  await prisma.knowledge_chunks.upsert({
    where: { id: CHUNK_1_ID },
    update: { content: 'A Synexa opera 24/7 com suporte automatizado e agentes de voz integrados.' },
    create: {
      id: CHUNK_1_ID,
      company_id: COMPANY_A_ID,
      client_id: CLIENT_A_ID,
      knowledge_base_id: KB_A_ID,
      document_id: DOC_1_ID,
      chunk_index: 0,
      content: 'A Synexa opera 24/7 com suporte automatizado e agentes de voz integrados.',
    },
  });

  console.log('[fixtures] Documento e chunk RAG criados com sucesso');

  // ── 4. Outbox Events & Delivery History ───────────────────────
  const outboxId = '00000000-0000-0000-0000-000000000601';
  await prisma.outbox_events.upsert({
    where: { id: outboxId },
    update: { status: 'published' },
    create: {
      id: outboxId,
      company_id: COMPANY_A_ID,
      client_id: CLIENT_A_ID,
      aggregate_type: 'conversation',
      event_type: 'message.received',
      payload: { message_id: MSG_1_ID, text: 'Olá!' } as any,
      status: 'published',
    },
  });

  console.log('\n✅ Fixtures carregadas com sucesso!');
}

main()
  .catch((err) => {
    console.error('\nErro ao carregar fixtures:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
