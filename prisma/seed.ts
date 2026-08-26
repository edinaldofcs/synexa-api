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
const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const KB_ID = '00000000-0000-0000-0000-000000000003';
const END_USER_ID = '00000000-0000-0000-0000-000000000004';
const USER_ID = '00000000-0000-0000-0000-000000000005';

const AGENT_RECEPTION_ID = '00000000-0000-0000-0000-000000000011';
const AGENT_SUPPORT_ID = '00000000-0000-0000-0000-000000000012';
const AGENT_SALES_ID = '00000000-0000-0000-0000-000000000013';
const AGENT_FINANCE_ID = '00000000-0000-0000-0000-000000000014';

const CONN_API_ID = '00000000-0000-0000-0000-000000000021';
const CONN_WA_ID = '00000000-0000-0000-0000-000000000022';
const WEBHOOK_ID = '00000000-0000-0000-0000-000000000031';

async function main() {
  console.log('=== Seed Synexa Enterprise (Idempotente) ===\n');
  console.log(
    `  Mode: ${isDevelopment ? 'DEVELOPMENT (local auth)' : 'PRODUCTION (Supabase auth)'}\n`,
  );

  // ── 1. Company ───────────────────────────────────────────────
  await prisma.companies.upsert({
    where: { id: COMPANY_ID },
    update: { name: 'Synexa Admin', plan: 'scale', status: 'active' },
    create: {
      id: COMPANY_ID,
      name: 'Synexa Admin',
      cnpj: '12.345.678/0001-90',
      plan: 'scale',
      status: 'active',
    },
  });
  console.log(`[companies]     ${COMPANY_ID}`);

  // ── 2. Auth User ─────────────────────────────────────────────
  const email = 'admin@synexa.com.br';
  const password = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (!password || password.length < 12) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required and must be at least 12 characters',
    );
  }
  const userName = 'Administrador Synexa';

  let userId = USER_ID;

  if (isDevelopment) {
    const password_hash = await bcrypt.hash(password, 10);
    const existingUser = await prisma.users.findFirst({ where: { email } });
    if (existingUser) {
      userId = existingUser.id;
      await prisma.users.update({
        where: { id: userId },
        data: { name: userName, password_hash, role: 'admin' },
      });
    } else {
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
    }
  } else {
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
    const { data: users } = await supabase.auth.admin.listUsers();
    let authUser = users.users.find((u) => u.email === email);

    if (!authUser) {
      const { data: auth, error: authError } =
        await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { name: userName },
        });
      if (authError) throw authError;
      authUser = auth.user!;
    }
    userId = authUser.id;

    await prisma.users.upsert({
      where: { id: userId },
      update: { name: userName, email, role: 'admin' },
      create: {
        id: userId,
        company_id: COMPANY_ID,
        name: userName,
        email,
        role: 'admin',
      },
    });
  }
  console.log(`[users]         ${userId} (admin@synexa.com.br)`);

  // ── 3. Painel Client ─────────────────────────────────────────
  await prisma.painel_clients.upsert({
    where: { id: CLIENT_ID },
    update: {
      company_name: 'Cliente Teste',
      status: 'active',
      agent_name: 'Assistente Synexa',
    },
    create: {
      id: CLIENT_ID,
      company_id: COMPANY_ID,
      company_name: 'Cliente Teste',
      status: 'active',
      agent_name: 'Assistente Synexa',
    },
  });
  console.log(`[painel_clients] ${CLIENT_ID} (Cliente Teste)`);

  // ── 4. Channel Connections ───────────────────────────────────
  const apiConn = await prisma.channel_connections.upsert({
    where: { id: CONN_API_ID },
    update: { status: 'active', inbound_secret_hash: 'test-secret-api-key' },
    create: {
      id: CONN_API_ID,
      company_id: COMPANY_ID,
      client_id: CLIENT_ID,
      channel_type: 'api',
      provider: 'synexa',
      status: 'active',
      inbound_secret_hash: 'test-secret-api-key',
    },
  });

  const waConn = await prisma.channel_connections.upsert({
    where: { id: CONN_WA_ID },
    update: {
      status: 'active',
      provider_account_id: '5511999999999',
      inbound_secret_hash: 'test-secret-whatsapp',
    },
    create: {
      id: CONN_WA_ID,
      company_id: COMPANY_ID,
      client_id: CLIENT_ID,
      channel_type: 'whatsapp',
      provider: 'evolution',
      provider_account_id: '5511999999999',
      status: 'active',
      config: {
        instanceUrl: 'https://evo.example.com',
        apiKey: 'evo-key',
      } as any,
      inbound_secret_hash: 'test-secret-whatsapp',
    },
  });
  console.log(`[channel_connections] ${apiConn.id} (api)`);
  console.log(`[channel_connections] ${waConn.id} (whatsapp)`);

  // ── 5. Webhook ───────────────────────────────────────────────
  await prisma.webhook_endpoints.upsert({
    where: { id: WEBHOOK_ID },
    update: {
      url: 'https://httpbin.org/post',
      enabled: true,
    },
    create: {
      id: WEBHOOK_ID,
      client_id: CLIENT_ID,
      channel_connection_id: apiConn.id,
      url: 'https://httpbin.org/post',
      events: ['message.completed', 'message.failed'] as any,
      secret_hash: 'webhook-secret',
      enabled: true,
    },
  });
  console.log(`[webhook_endpoints] ${WEBHOOK_ID} (httpbin.org/post)`);

  // ── 6. Knowledge Base ────────────────────────────────────────
  await prisma.knowledge_bases.upsert({
    where: { id: KB_ID },
    update: { name: 'Base de Conhecimento Padrao', status: 'active' },
    create: {
      id: KB_ID,
      company_id: COMPANY_ID,
      client_id: CLIENT_ID,
      name: 'Base de Conhecimento Padrao',
      description: 'Base para testes RAG',
      status: 'active',
    },
  });
  console.log(`[knowledge_bases] ${KB_ID}`);

  // ── 7. Agents ─────────────────────────────────────────────────
  const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-mini';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const defaultModel =
    process.env.LLM_PROVIDER === 'openrouter'
      ? openRouterModel
      : process.env.LLM_PROVIDER === 'groq'
        ? groqModel
        : process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  const agentMain = await prisma.painel_agents.upsert({
    where: { id: AGENT_RECEPTION_ID },
    update: {
      model: defaultModel,
      is_active: true,
      service_step: 'reception',
      execution_order: 1,
      allowed_tool_names: [],
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [
          {
            target: 'suporte_tecnico',
            keywords: [
              'suporte',
              'técnico',
              'problema',
              'erro',
              'não funciona',
              'quebrou',
              'defeito',
              'bug',
            ],
          },
          {
            target: 'vendas',
            keywords: [
              'produto',
              'preço',
              'comprar',
              'orçamento',
              'catálogo',
              'quanto custa',
            ],
          },
        ],
      } as any,
    },
    create: {
      id: AGENT_RECEPTION_ID,
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'reception',
      execution_order: 1,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o assistente de recepção da Synexa.
Seu papel é receber o cliente, identificar o motivo do contato e resolver problemas simples.
Atenda com educação e profissionalismo. A transferência para outros agentes acontece
automaticamente quando as condições de ativação configuradas no painel forem atendidas.`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [
          {
            target: 'suporte_tecnico',
            keywords: [
              'suporte',
              'técnico',
              'problema',
              'erro',
              'não funciona',
              'quebrou',
              'defeito',
              'bug',
            ],
          },
          {
            target: 'vendas',
            keywords: [
              'produto',
              'preço',
              'comprar',
              'orçamento',
              'catálogo',
              'quanto custa',
            ],
          },
        ],
      } as any,
      allowed_tool_names: [],
    },
  });

  const agentSupport = await prisma.painel_agents.upsert({
    where: { id: AGENT_SUPPORT_ID },
    update: {
      model: defaultModel,
      is_active: true,
      service_step: 'suporte_tecnico',
      execution_order: 2,
      allowed_tool_names: [],
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [
          {
            target: 'financeiro',
            keywords: [
              'pagamento',
              'boleto',
              'fatura',
              'cobrança',
              'reembolso',
            ],
          },
          {
            target: 'humano',
            keywords: [
              'não resolveu',
              'humano',
              'atendente',
              'falou com gerente',
            ],
          },
        ],
      } as any,
    },
    create: {
      id: AGENT_SUPPORT_ID,
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'suporte_tecnico',
      execution_order: 2,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o agente de suporte técnico da Synexa.
Ajude o cliente a resolver problemas técnicos com produtos e serviços.
Consulte a base de conhecimento e ferramentas disponíveis.
A transferência para outros agentes acontece automaticamente quando as
condições de ativação configuradas no painel forem atendidas.`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [
          {
            target: 'financeiro',
            keywords: [
              'pagamento',
              'boleto',
              'fatura',
              'cobrança',
              'reembolso',
            ],
          },
          {
            target: 'humano',
            keywords: [
              'não resolveu',
              'humano',
              'atendente',
              'falou com gerente',
            ],
          },
        ],
      } as any,
      allowed_tool_names: [],
    },
  });

  const agentSales = await prisma.painel_agents.upsert({
    where: { id: AGENT_SALES_ID },
    update: {
      model: defaultModel,
      is_active: true,
      service_step: 'vendas',
      execution_order: 3,
      allowed_tool_names: [],
    },
    create: {
      id: AGENT_SALES_ID,
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
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [],
      } as any,
      allowed_tool_names: [],
    },
  });

  const agentFinance = await prisma.painel_agents.upsert({
    where: { id: AGENT_FINANCE_ID },
    update: {
      model: defaultModel,
      is_active: true,
      service_step: 'financeiro',
      execution_order: 4,
      allowed_tool_names: [],
    },
    create: {
      id: AGENT_FINANCE_ID,
      client_id: CLIENT_ID,
      model: defaultModel,
      service_step: 'financeiro',
      execution_order: 4,
      system_prompt: `Seu nome é [[nome_agente]].

Você é o agente financeiro da Synexa.
Ajude com questões de pagamento, boletos, faturas e reembolsos.
Consulte as ferramentas disponíveis para verificar status de pagamentos.
A transferência para outros agentes acontece automaticamente quando as
condições de ativação configuradas no painel forem atendidas.`,
      is_active: true,
      transitions: {
        llm_provider: process.env.LLM_PROVIDER || 'mock',
        type: 'keyword',
        rules: [
          {
            target: 'suporte_tecnico',
            keywords: ['problema técnico', 'sistema', 'não consigo acessar'],
          },
        ],
      } as any,
      allowed_tool_names: [],
    },
  });

  console.log(`[painel_agents]  ${agentMain.id} (Recepção)`);
  console.log(`[painel_agents]  ${agentSupport.id} (Suporte Técnico)`);
  console.log(`[painel_agents]  ${agentSales.id} (Vendas)`);
  console.log(`[painel_agents]  ${agentFinance.id} (Financeiro)`);

  // ── 8. API Tools ─────────────────────────────────────────────
  const existingTools = await prisma.painel_apis.findMany({
    where: { client_id: CLIENT_ID },
  });

  if (existingTools.length === 0) {
    await prisma.painel_apis.createMany({
      data: [
        {
          client_id: CLIENT_ID,
          agent_id: agentSupport.id,
          name: 'Buscar CEP (ViaCEP)',
          description:
            'Busca endereço completo a partir de um CEP brasileiro. API gratuita sem chave.',
          method: 'GET',
          url: 'https://viacep.com.br/ws/{cep}/json/',
          headers: { 'Content-Type': 'application/json' } as any,
          visible_to_agent: true,
          active: true,
          execution_order: 1,
        },
        {
          client_id: CLIENT_ID,
          agent_id: agentSales.id,
          name: 'Cotações de Moedas (AwesomeAPI)',
          description:
            'Cotação atual do dólar, euro e outras moedas em relação ao real. API gratuita.',
          method: 'GET',
          url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
          headers: { 'Content-Type': 'application/json' } as any,
          visible_to_agent: true,
          active: true,
          execution_order: 1,
        },
        {
          client_id: CLIENT_ID,
          agent_id: agentMain.id,
          name: 'Listar Feriados (BrasilAPI)',
          description:
            'Lista todos os feriados nacionais do Brasil para um ano. API gratuita sem chave.',
          method: 'GET',
          url: 'https://brasilapi.com.br/api/feriados/v1/{ano}',
          headers: { 'Content-Type': 'application/json' } as any,
          visible_to_agent: true,
          active: true,
          execution_order: 1,
        },
      ],
    });
    console.log(
      `[painel_apis]    3 APIs criadas (Buscar CEP, Cotações, Feriados)`,
    );
  }

  // ── 9. Intentions ─────────────────────────────────────────────
  const existingIntentions = await prisma.painel_intentions.findMany({
    where: { client_id: CLIENT_ID },
  });

  if (existingIntentions.length === 0) {
    await prisma.painel_intentions.createMany({
      data: [
        {
          client_id: CLIENT_ID,
          code: 'saudacao',
          description: 'Cliente cumprimenta ou inicia conversa',
          is_active: true,
        },
        {
          client_id: CLIENT_ID,
          code: 'suporte_tecnico',
          description: 'Cliente solicita suporte técnico',
          is_active: true,
        },
        {
          client_id: CLIENT_ID,
          code: 'financeiro',
          description: 'Dúvidas sobre pagamentos, boletos e fatura',
          is_active: true,
        },
        {
          client_id: CLIENT_ID,
          code: 'cancelamento',
          description: 'Cliente deseja cancelar serviço',
          is_active: true,
        },
      ],
    });
    console.log(`[painel_intentions] 4 intenções criadas`);
  }

  // ── 10. End User + Identity ───────────────────────────────────
  await prisma.end_users.upsert({
    where: { id: END_USER_ID },
    update: { name: 'Usuario Teste' },
    create: {
      id: END_USER_ID,
      company_id: COMPANY_ID,
      client_id: CLIENT_ID,
      name: 'Usuario Teste',
    },
  });

  const existingIdentity = await prisma.channel_identities.findFirst({
    where: {
      company_id: COMPANY_ID,
      client_id: CLIENT_ID,
      channel_type: 'api',
      external_user_id: 'test-user-1',
    },
  });

  if (!existingIdentity) {
    await prisma.channel_identities.create({
      data: {
        company_id: COMPANY_ID,
        client_id: CLIENT_ID,
        end_user_id: END_USER_ID,
        channel_type: 'api',
        external_user_id: 'test-user-1',
      },
    });
  }
  console.log(`[end_users]       ${END_USER_ID} (test-user-1)`);

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n=== Seed idempotente executado com sucesso ===');
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
  .catch((err) => {
    console.error('\nErro:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
