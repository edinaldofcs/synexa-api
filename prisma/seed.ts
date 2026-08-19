import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();
const isDevelopment = process.env.ENVIRONMENT === 'development';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CLIENT_ID  = '00000000-0000-0000-0000-000000000002';
const KB_ID      = '00000000-0000-0000-0000-000000000003';
const END_USER_ID = '00000000-0000-0000-0000-000000000004';

async function main() {
  console.log('=== Seed Synexa Enterprise ===\n');
  console.log(`  Mode: ${isDevelopment ? 'DEVELOPMENT (local auth)' : 'PRODUCTION (Supabase auth)'}\n`);

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

  if (!isDevelopment) {
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    );
    try {
      const { data: users } = await supabase.auth.admin.listUsers();
      for (const u of users.users) {
        if (u.email === 'admin@synexa.com.br') {
          await supabase.auth.admin.deleteUser(u.id);
        }
      }
    } catch {}
  }
  console.log('  OK\n');

  // ── 1. Company ───────────────────────────────────────────────
  await prisma.companies.create({
    data: { id: COMPANY_ID, name: 'Synexa Admin', cnpj: '12.345.678/0001-90', plan: 'scale', status: 'active' },
  });
  console.log(`[companies]     ${COMPANY_ID}`);

  // ── 2. Auth User ─────────────────────────────────────────────
  const email = 'admin@synexa.com.br';
  const password = process.env.SEED_ADMIN_PASSWORD || 'SynexaAdmin2026!';
  const userName = 'Administrador Synexa';

  let userId: string;

  if (isDevelopment) {
    userId = randomUUID();
    const password_hash = await bcrypt.hash(password, 10);
    await prisma.users.create({
      data: {
        id: userId,
        company_id: COMPANY_ID,
        name: userName,
        email,
        password_hash,
        role: 'admin',
      },
    });
  } else {
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    );
    const { data: auth, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { name: userName },
    });
    if (authError) throw authError;
    userId = auth.user!.id;

    await prisma.users.create({
      data: { id: userId, company_id: COMPANY_ID, name: userName, email, role: 'admin' },
    });
  }
  console.log(`[users]         ${userId} (admin@synexa.com.br)`);

  // ── 3. Painel Client ─────────────────────────────────────────
  await prisma.painel_clients.create({
    data: {
      id: CLIENT_ID,
      company_id: COMPANY_ID,
      company_name: 'Cliente Teste',
      status: 'active',
      agent_name: 'Assistente Synexa',
    },
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

  // ── 7. Agents ─────────────────────────────────────────────────
  const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-mini';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const defaultModel = process.env.LLM_PROVIDER === 'openrouter' ? openRouterModel
    : process.env.LLM_PROVIDER === 'groq' ? groqModel
    : process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  const agentMain = await prisma.painel_agents.create({
    data: {
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'reception',
      execution_order: 1,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o assistente de recepção da Synexa.
Seu papel é receber o cliente, identificar o motivo do contato e resolver problemas simples.
Se o cliente precisar de suporte técnico, responda exatamente: "TRANSFERIR:suporte_tecnico"
Se o cliente quiser consultar produtos ou preços, responda exatamente: "TRANSFERIR:vendas"
Responda de forma educada e profissional.`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'gemini',
        type: 'keyword',
        rules: [
          { target: 'suporte_tecnico', keywords: ['suporte', 'técnico', 'problema', 'erro', 'não funciona', 'quebrou', 'defeito', 'bug'] },
          { target: 'vendas', keywords: ['produto', 'preço', 'comprar', 'orçamento', 'catálogo', 'quanto custa'] },
        ],
      } as any,
      allowed_tool_names: ['search_knowledge_base', 'execute_api'],
    },
  });

  const agentSupport = await prisma.painel_agents.create({
    data: {
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'suporte_tecnico',
      execution_order: 2,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o agente de suporte técnico da Synexa.
Ajude o cliente a resolver problemas técnicos com produtos e serviços.
Consulte a base de conhecimento e ferramentas disponíveis.
Se o problema for financeiro, responda exatamente: "TRANSFERIR:financeiro"
Se não conseguir resolver, responda exatamente: "TRANSFERIR:humano"`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'gemini',
        type: 'keyword',
        rules: [
          { target: 'financeiro', keywords: ['pagamento', 'boleto', 'fatura', 'cobrança', 'reembolso'] },
          { target: 'humano', keywords: ['não resolveu', 'humano', 'atendente', 'falou com gerente'] },
        ],
      } as any,
      allowed_tool_names: ['search_knowledge_base', 'execute_api'],
    },
  });

  const agentSales = await prisma.painel_agents.create({
    data: {
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'vendas',
      execution_order: 3,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o agente de vendas da Synexa.
Apresente produtos e serviços, tire dúvidas sobre preços e condições.
Use a ferramenta de consulta de produtos para buscar informações atualizadas.
Se o cliente quiser fechar negócio, colete os dados e registre o pedido.`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'gemini',
        type: 'keyword',
        rules: [],
      } as any,
      allowed_tool_names: ['search_knowledge_base', 'execute_api', 'search_web'],
    },
  });

  const agentFinance = await prisma.painel_agents.create({
    data: {
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'financeiro',
      execution_order: 4,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o agente financeiro da Synexa.
Ajude com questões de pagamento, boletos, faturas e reembolsos.
Consulte as ferramentas disponíveis para verificar status de pagamentos.
Se o problema for técnico, responda exatamente: "TRANSFERIR:suporte_tecnico"`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'gemini',
        type: 'keyword',
        rules: [
          { target: 'suporte_tecnico', keywords: ['problema técnico', 'sistema', 'não consigo acessar'] },
        ],
      } as any,
      allowed_tool_names: ['execute_api'],
    },
  });

  console.log(`[painel_agents]  ${agentMain.id} (Recepção)`);
  console.log(`[painel_agents]  ${agentSupport.id} (Suporte Técnico)`);
  console.log(`[painel_agents]  ${agentSales.id} (Vendas)`);
  console.log(`[painel_agents]  ${agentFinance.id} (Financeiro)`);

  // ── 8. API Tools ─────────────────────────────────────────────
  await prisma.painel_apis.create({
    data: {
      client_id: CLIENT_ID,
      agent_id: agentSupport.id,
      name: 'Buscar CEP (ViaCEP)',
      description: 'Busca endereço completo a partir de um CEP brasileiro. API gratuita sem chave.',
      method: 'GET',
      url: 'https://viacep.com.br/ws/{cep}/json/',
      headers: { 'Content-Type': 'application/json' } as any,
      visible_to_agent: true,
      active: true,
      execution_order: 1,
    },
  });
  await prisma.painel_apis.create({
    data: {
      client_id: CLIENT_ID,
      agent_id: agentSales.id,
      name: 'Cotações de Moedas (AwesomeAPI)',
      description: 'Cotação atual do dólar, euro e outras moedas em relação ao real. API gratuita.',
      method: 'GET',
      url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
      headers: { 'Content-Type': 'application/json' } as any,
      visible_to_agent: true,
      active: true,
      execution_order: 1,
    },
  });
  await prisma.painel_apis.create({
    data: {
      client_id: CLIENT_ID,
      agent_id: agentMain.id,
      name: 'Listar Feriados (BrasilAPI)',
      description: 'Lista todos os feriados nacionais do Brasil para um ano. API gratuita sem chave.',
      method: 'GET',
      url: 'https://brasilapi.com.br/api/feriados/v1/{ano}',
      headers: { 'Content-Type': 'application/json' } as any,
      visible_to_agent: true,
      active: true,
      execution_order: 1,
    },
  });

  console.log(`[painel_apis]    3 APIs criadas (Buscar CEP, Cotações, Feriados)`);

  // ── 9. Intentions ─────────────────────────────────────────────
  await prisma.painel_intentions.create({
    data: { client_id: CLIENT_ID, code: 'saudacao', description: 'Cliente cumprimenta ou inicia conversa', is_active: true },
  });
  await prisma.painel_intentions.create({
    data: { client_id: CLIENT_ID, code: 'suporte_tecnico', description: 'Cliente solicita suporte técnico', is_active: true },
  });
  await prisma.painel_intentions.create({
    data: { client_id: CLIENT_ID, code: 'financeiro', description: 'Dúvidas sobre pagamentos, boletos e fatura', is_active: true },
  });
  await prisma.painel_intentions.create({
    data: { client_id: CLIENT_ID, code: 'cancelamento', description: 'Cliente deseja cancelar serviço', is_active: true },
  });
  console.log(`[painel_intentions] 4 intenções criadas (saudacao, suporte_tecnico, financeiro, cancelamento)`);

  // ── 10. End User + Identity ───────────────────────────────────
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

  // ── 11. LLM Providers (depois de tudo, pra nao ser sobrescrito) ──
  const llmProviderEntries: string[] = [];
  if (process.env.GEMINI_API_KEY) {
    llmProviderEntries.push(`'gemini', jsonb_build_object('apiKey', '${process.env.GEMINI_API_KEY.replace(/'/g, "''")}', 'enabledModels', jsonb_build_array('${(process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').replace(/'/g, "''")}'))`);
  }
  if (process.env.GROQ_API_KEY) {
    llmProviderEntries.push(`'groq', jsonb_build_object('apiKey', '${process.env.GROQ_API_KEY.replace(/'/g, "''")}', 'enabledModels', jsonb_build_array('${(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').replace(/'/g, "''")}'))`);
  }
  if (process.env.OPENROUTER_API_KEY) {
    llmProviderEntries.push(`'openrouter', jsonb_build_object('apiKey', '${process.env.OPENROUTER_API_KEY.replace(/'/g, "''")}', 'enabledModels', jsonb_build_array('${(process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-mini').replace(/'/g, "''")}'))`);
  }

  if (llmProviderEntries.length > 0) {
    const sql = `
      UPDATE painel_clients
      SET metadata = metadata || jsonb_build_object(
        'llm_providers', jsonb_build_object(${llmProviderEntries.join(', ')}),
        'llm_providers_updated_at', '${new Date().toISOString()}'
      )
      WHERE id = '${CLIENT_ID}'
    `;
    await prisma.$executeRawUnsafe(sql);
    const providerNames = llmProviderEntries.map(e => e.split(',')[0].replace(/'/g, '').trim());
    console.log(`[llm_providers]  ${providerNames.length} providers configurados (${providerNames.join(', ')})`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n=== Seed completo ===');
  console.log(`Entrada            | Valor`);
  console.log(`------------------|----------------------------------------`);
  console.log(`Login             | ${email}`);
  console.log(`Senha             | ${password}`);
  console.log(`company_id        | ${COMPANY_ID}`);
  console.log(`client_id         | ${CLIENT_ID}`);
  console.log(`agent_reception   | ${agentMain.id}`);
  console.log(`agent_support     | ${agentSupport.id}`);
  console.log(`agent_sales       | ${agentSales.id}`);
  console.log(`agent_finance     | ${agentFinance.id}`);
  console.log(`channel_conn (api)| ${apiConn.id}`);
  console.log(`channel_conn (wa) | ${waConn.id}`);
  console.log(`api_key (secret)  | test-secret-api-key`);
  console.log(`end_user          | test-user-1`);
  console.log(`user_id (auth)    | ${userId}`);
}

main()
  .catch(err => { console.error('\nErro:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
