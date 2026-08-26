import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

const AGENT_RECEPTION_ID = '00000000-0000-0000-0000-000000000011';
const AGENT_NEGOCIACAO_ID = '00000000-0000-0000-0000-000000000012';
const AGENT_ENCERRAMENTO_ID = '00000000-0000-0000-0000-000000000013';

const API_BUSCAR_CPF_ID = 'c029b6b1-4406-4857-8139-1ade67302858';
const API_OFFERS_ID = '66003399-485c-40ce-b7e8-fa8e1af0d437';
const API_AGREEMENT_ID = 'ce22257e-fcb8-45d1-9753-9418395c4c1d';

async function main() {
  console.log(
    '🚀 Iniciando configuração do Fluxo de Cobrança com 3 APIs e 3 Agentes...',
  );

  // 1. Garantir Cliente
  await prisma.painel_clients.upsert({
    where: { id: CLIENT_ID },
    update: {
      company_name: 'Synexa Cobrança & Negociação',
      status: 'active',
      agent_name: 'Sofia - Assistente Synexa',
    },
    create: {
      id: CLIENT_ID,
      company_id: COMPANY_ID,
      company_name: 'Synexa Cobrança & Negociação',
      status: 'active',
      agent_name: 'Sofia - Assistente Synexa',
    },
  });

  // 2. Configurar APIs

  // 2.1 API: offers (Encadeada)
  await prisma.painel_apis.upsert({
    where: { id: API_OFFERS_ID },
    update: {
      client_id: CLIENT_ID,
      agent_id: AGENT_RECEPTION_ID,
      name: 'offers',
      description:
        'Busca as propostas de desconto à vista e parcelamentos disponíveis para o débito do cliente.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_offers',
      headers: {
        'Content-Type': 'application/json',
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: 'cpf',
          source: 'system',
        },
      } as any,
      parameters: undefined,
      extract_data: {
        planos: 'data.planos',
        valor_total_ofertas: 'data.valor_total_original',
        tem_ofertas: true,
      } as any,
      visible_to_agent: false,
      active: true,
      next_tool: null,
      execution_order: 2,
    },
    create: {
      id: API_OFFERS_ID,
      client_id: CLIENT_ID,
      agent_id: AGENT_RECEPTION_ID,
      name: 'offers',
      description:
        'Busca as propostas de desconto à vista e parcelamentos disponíveis para o débito do cliente.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_offers',
      headers: {
        'Content-Type': 'application/json',
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: 'cpf',
          source: 'system',
        },
      } as any,
      parameters: undefined,
      extract_data: {
        planos: 'data.planos',
        valor_total_ofertas: 'data.valor_total_original',
        tem_ofertas: true,
      } as any,
      visible_to_agent: false,
      active: true,
      next_tool: null,
      execution_order: 2,
    },
  });

  // 2.2 API: buscar_cpf (Primeira API com encadeamento para offers)
  await prisma.painel_apis.upsert({
    where: { id: API_BUSCAR_CPF_ID },
    update: {
      client_id: CLIENT_ID,
      agent_id: AGENT_RECEPTION_ID,
      name: 'buscar_cpf',
      description:
        'Consulta débitos e dados cadastrais do cliente a partir do número do CPF.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_debts',
      headers: {
        'Content-Type': 'application/json',
        next_api_id: API_OFFERS_ID,
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: '',
          source: 'ai',
          save_to_session: true,
        },
      } as any,
      parameters: {
        cpf: {
          type: 'string',
          description:
            'Número do CPF do cliente (somente números ou formatado)',
          required: true,
        },
      } as any,
      extract_data: {
        cliente_nome: 'cliente.nome',
        cliente_cpf: 'cliente.cpf',
        valor_divida: 'divida.valor_atualizado',
        dias_atraso: 'divida.dias_atraso',
        data_vencimento: 'divida.data_vencimento',
        contrato: 'divida.contrato',
        origem_divida: 'divida.origem',
      } as any,
      visible_to_agent: true,
      active: true,
      next_tool: 'offers',
      execution_order: 1,
    },
    create: {
      id: API_BUSCAR_CPF_ID,
      client_id: CLIENT_ID,
      agent_id: AGENT_RECEPTION_ID,
      name: 'buscar_cpf',
      description:
        'Consulta débitos e dados cadastrais do cliente a partir do número do CPF.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_debts',
      headers: {
        'Content-Type': 'application/json',
        next_api_id: API_OFFERS_ID,
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: '',
          source: 'ai',
          save_to_session: true,
        },
      } as any,
      parameters: {
        cpf: {
          type: 'string',
          description:
            'Número do CPF do cliente (somente números ou formatado)',
          required: true,
        },
      } as any,
      extract_data: {
        cliente_nome: 'cliente.nome',
        cliente_cpf: 'cliente.cpf',
        valor_divida: 'divida.valor_atualizado',
        dias_atraso: 'divida.dias_atraso',
        data_vencimento: 'divida.data_vencimento',
        contrato: 'divida.contrato',
        origem_divida: 'divida.origem',
      } as any,
      visible_to_agent: true,
      active: true,
      next_tool: 'offers',
      execution_order: 1,
    },
  });

  // 2.3 API: agreement (Fechamento de Acordo e PIX)
  await prisma.painel_apis.upsert({
    where: { id: API_AGREEMENT_ID },
    update: {
      client_id: CLIENT_ID,
      agent_id: AGENT_NEGOCIACAO_ID,
      name: 'agreement',
      description:
        'Formaliza e registra o acordo de quitação escolhido pelo cliente gerando chave PIX e vencimento.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_agreement',
      headers: {
        'Content-Type': 'application/json',
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: 'cpf',
          source: 'system',
        },
        codigo_plano: {
          type: 'string',
          value:
            'Código do plano de pagamento aceito pelo cliente (ex: NEG-001)',
          source: 'ai',
        },
        forma_pagamento: {
          type: 'string',
          value: 'PIX',
          source: 'ai',
        },
      } as any,
      parameters: {
        codigo_plano: {
          type: 'string',
          description:
            'Código do plano aceito pelo cliente (ex: NEG-001 para à vista com desconto, NEG-002, NEG-003, NEG-004 ou NEG-005)',
          required: true,
        },
        forma_pagamento: {
          type: 'string',
          description: 'Forma de pagamento (padrão: PIX)',
          required: false,
        },
      } as any,
      extract_data: {
        acordo_id: 'data.acordo_id',
        acordo_status: 'data.status',
        copia_e_cola: 'data.pagamento.pix.copia_e_cola',
        vencimento_acordo: 'data.vencimento_primeira_parcela',
        acordo_confirmado: true,
      } as any,
      visible_to_agent: true,
      active: true,
      next_tool: null,
      execution_order: 3,
    },
    create: {
      id: API_AGREEMENT_ID,
      client_id: CLIENT_ID,
      agent_id: AGENT_NEGOCIACAO_ID,
      name: 'agreement',
      description:
        'Formaliza e registra o acordo de quitação escolhido pelo cliente gerando chave PIX e vencimento.',
      method: 'POST',
      url: 'https://prd.naldofcs-ai.com/webhook/synexa_agreement',
      headers: {
        'Content-Type': 'application/json',
      } as any,
      body: {
        cpf: {
          type: 'string',
          value: 'cpf',
          source: 'system',
        },
        codigo_plano: {
          type: 'string',
          value:
            'Código do plano de pagamento aceito pelo cliente (ex: NEG-001)',
          source: 'ai',
        },
        forma_pagamento: {
          type: 'string',
          value: 'PIX',
          source: 'ai',
        },
      } as any,
      parameters: {
        codigo_plano: {
          type: 'string',
          description:
            'Código do plano aceito pelo cliente (ex: NEG-001 para à vista com desconto, NEG-002, NEG-003, NEG-004 ou NEG-005)',
          required: true,
        },
        forma_pagamento: {
          type: 'string',
          description: 'Forma de pagamento (padrão: PIX)',
          required: false,
        },
      } as any,
      extract_data: {
        acordo_id: 'data.acordo_id',
        acordo_status: 'data.status',
        copia_e_cola: 'data.pagamento.pix.copia_e_cola',
        vencimento_acordo: 'data.vencimento_primeira_parcela',
        acordo_confirmado: true,
      } as any,
      visible_to_agent: true,
      active: true,
      next_tool: null,
      execution_order: 3,
    },
  });

  console.log(
    '✅ 3 APIs cadastradas com sucesso: buscar_cpf -> offers, agreement',
  );

  // 3. Configurar os 3 Agentes

  // 3.1 Agente 1: Recepção e Identificação
  const promptAgente1 = `## Identidade e Papel
Você é a Sofia, assistente virtual de atendimento da Synexa.
Seu objetivo é acolher o cliente com cordialidade, solicitar a confirmação do CPF para localização no sistema e consultar os dados cadastrais.

## Diretrizes de Voz e Conversação
- Seja direta, profissional e calorosa.
- Responda em frases curtas (1 a 2 frases), ideais tanto para chat de texto quanto para síntese de voz (TTS).
- Evite símbolos complexos, tabelas ou asteriscos desnecessários.

## Fluxo de Acolhimento
1. Cumprimente o cliente cordialmente e solicite o número do CPF para prosseguir com o atendimento.
2. Assim que o cliente informar o CPF (exemplo: "083.349.939-42" ou "08334993942"), chame IMEDIATAMENTE a ferramenta \`buscar_cpf(cpf: "...")\`.
3. Não invente valores ou contratos antes de executar a consulta.
4. Caso o sistema retorne que não há débitos ou CPF não encontrado, informe ao cliente com gentileza que seu cadastro está em dia.`;

  await prisma.painel_agents.upsert({
    where: { id: AGENT_RECEPTION_ID },
    update: {
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'inicio_atendimento',
      execution_order: 1,
      is_initial: true,
      is_active: true,
      interaction_mode: 'both',
      activation_conditions: undefined,
      activation_mode: 'on_next_message',
      allowed_tool_names: ['buscar_cpf'] as any,
      system_prompt: promptAgente1,
      persona_blocks: {
        identidade:
          'Você é a Sofia, assistente de acolhimento e identificação da Synexa.',
        diretrizes_voz:
          'Fale de forma natural, calorosa e concisa. Respostas diretas adequadas para texto e voz.',
        roteiro:
          'Solicite o CPF do cliente. Ao receber, execute imediatamente a ferramenta buscar_cpf.',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
    create: {
      id: AGENT_RECEPTION_ID,
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'inicio_atendimento',
      execution_order: 1,
      is_initial: true,
      is_active: true,
      interaction_mode: 'both',
      activation_conditions: undefined,
      activation_mode: 'on_next_message',
      allowed_tool_names: ['buscar_cpf'] as any,
      system_prompt: promptAgente1,
      persona_blocks: {
        identidade:
          'Você é a Sofia, assistente de acolhimento e identificação da Synexa.',
        diretrizes_voz:
          'Fale de forma natural, calorosa e concisa. Respostas diretas adequadas para texto e voz.',
        roteiro:
          'Solicite o CPF do cliente. Ao receber, execute imediatamente a ferramenta buscar_cpf.',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
  });

  // 3.2 Agente 2: Negociação de Débitos e Fechamento
  const promptAgente2 = `## Identidade e Tom de Voz
Você é o Especialista de Negociação e Acordos da Synexa.
Você assume o atendimento imediatamente após a localização da dívida para apresentar propostas facilitadas de quitação e regularização.

## Dados do Cliente e Pendência
- Cliente: [[cliente_nome]]
- CPF: [[cliente_cpf]]
- Contrato: [[contrato]] ([[origem_divida]])
- Valor Original: R$ [[valor_divida]]
- Dias em Atraso: [[dias_atraso]] dias
- Vencimento Original: [[data_vencimento]]

## Regras de Abordagem Condicionais
[SE [[dias_atraso]] > 30]
O débito está com mais de 30 dias de vencimento ([[dias_atraso]] dias em aberto). Destaque a oportunidade imperdível de regularizar seu nome hoje mesmo com desconto especial à vista de 15% ou em parcelas flexíveis sem juros.
[SENÃO SE [[dias_atraso]] > 0]
O débito está recente ([[dias_atraso]] dias de atraso). Adote tom leve e solícito, apresentando as opções para manter a conta quitada sem complicações.
[SENÃO]
Débito localizado para regularização imediata.
[FIM SE]

## Planos de Negociação Disponíveis
1. **À Vista com 15% de Desconto**: Código \`NEG-001\` por apenas **R$ 501,42** (economia de R$ 88,48).
2. **2x sem juros**: Código \`NEG-002\` em 2 parcelas de **R$ 294,95** (Total: R$ 589,90).
3. **3x sem juros**: Código \`NEG-003\` em 3 parcelas de **R$ 196,63** (Total: R$ 589,90).
4. **4x**: Código \`NEG-004\` em 4 parcelas de **R$ 147,48**.
5. **5x**: Código \`NEG-005\` em 5 parcelas de **R$ 117,98**.

## Diretrizes de Fechamento
- Apresente as opções com clareza, destacando a economia do pagamento à vista ou o parcelamento suave.
- Quando o cliente escolher ou concordar com uma proposta, execute IMEDIATAMENTE a ferramenta \`agreement(codigo_plano: "CODIGO_ESCOLHIDO")\`.
- Não finalize o acordo antes de acionar a ferramenta. A ferramenta irá gerar o PIX e o protocolo oficial.`;

  await prisma.painel_agents.upsert({
    where: { id: AGENT_NEGOCIACAO_ID },
    update: {
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'negociacao',
      execution_order: 2,
      is_initial: false,
      is_active: true,
      interaction_mode: 'both',
      activation_mode: 'immediate',
      activation_conditions: {
        logic: 'AND',
        conditions: [
          { variable: 'valor_divida', operator: 'gt', value: '0' },
          { variable: 'tem_ofertas', operator: 'equals', value: true },
        ],
      } as any,
      allowed_tool_names: ['agreement'] as any,
      system_prompt: promptAgente2,
      persona_blocks: {
        identidade:
          'Especialista de negociação financeira da Synexa focado em conciliação e facilidades de pagamento.',
        condicionais:
          '[SE [[dias_atraso]] > 30] Foco em regularização urgente do nome [SENÃO] Foco em desconto facilitado [FIM SE]',
        planos:
          'Plano à vista com desconto (NEG-001) e planos parcelados em até 5x (NEG-002 a NEG-005).',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
    create: {
      id: AGENT_NEGOCIACAO_ID,
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'negociacao',
      execution_order: 2,
      is_initial: false,
      is_active: true,
      interaction_mode: 'both',
      activation_mode: 'immediate',
      activation_conditions: {
        logic: 'AND',
        conditions: [
          { variable: 'valor_divida', operator: 'gt', value: '0' },
          { variable: 'tem_ofertas', operator: 'equals', value: true },
        ],
      } as any,
      allowed_tool_names: ['agreement'] as any,
      system_prompt: promptAgente2,
      persona_blocks: {
        identidade:
          'Especialista de negociação financeira da Synexa focado em conciliação e facilidades de pagamento.',
        condicionais:
          '[SE [[dias_atraso]] > 30] Foco em regularização urgente do nome [SENÃO] Foco em desconto facilitado [FIM SE]',
        planos:
          'Plano à vista com desconto (NEG-001) e planos parcelados em até 5x (NEG-002 a NEG-005).',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
  });

  // 3.3 Agente 3: Formalização, PIX e Encerramento
  const promptAgente3 = `## Identidade e Papel
Você é o assistente de formalização e encerramento de acordos da Synexa.
Você assume a conversa no instante em que o acordo foi registrado no sistema pela API \`agreement\`.

## Dados do Acordo Formalizado
- Protocolo: [[acordo_id]]
- Status do Acordo: [[acordo_status]]
- Vencimento da 1ª Parcela: [[vencimento_acordo]]
- Código PIX Copia e Cola: [[copia_e_cola]]

## Roteiro de Encerramento (Voz e Texto)
1. Parabenize o cliente pela negociação e confirme a formalização do acordo sob o protocolo **[[acordo_id]]**.
2. **Para Canais de Texto**: Envie a chave PIX Copia e Cola em um bloco de código destacado:
\`\`\`
[[copia_e_cola]]
\`\`\`
3. **Para Canais de Voz**: Informe que a chave PIX e o comprovante foram enviados para o canal de mensagens e confirme o vencimento para **[[vencimento_acordo]]**.
4. Oriente o cliente a concluir o pagamento no aplicativo do seu banco até a data de vencimento para garantir a ativação do acordo.
5. Pergunte cordialmente se pode ajudar em algo mais e despeça-se com profissionalismo e simpatia.`;

  await prisma.painel_agents.upsert({
    where: { id: AGENT_ENCERRAMENTO_ID },
    update: {
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'encerramento',
      execution_order: 3,
      is_initial: false,
      is_active: true,
      interaction_mode: 'both',
      activation_mode: 'immediate',
      activation_conditions: {
        logic: 'OR',
        conditions: [
          { variable: 'acordo_confirmado', operator: 'equals', value: true },
          { variable: 'acordo_id', operator: 'exists', value: '' },
        ],
      } as any,
      allowed_tool_names: [] as any,
      system_prompt: promptAgente3,
      persona_blocks: {
        identidade:
          'Assistente de formalização e entrega de chaves PIX e protocolos de acordos fechados.',
        instrucoes_pix:
          'Entregar código PIX copia e cola, orientar pagamento no app bancário até o vencimento e encerrar com cordialidade.',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
    create: {
      id: AGENT_ENCERRAMENTO_ID,
      client_id: CLIENT_ID,
      model: 'gemini-3.6-flash',
      service_step: 'encerramento',
      execution_order: 3,
      is_initial: false,
      is_active: true,
      interaction_mode: 'both',
      activation_mode: 'immediate',
      activation_conditions: {
        logic: 'OR',
        conditions: [
          { variable: 'acordo_confirmado', operator: 'equals', value: true },
          { variable: 'acordo_id', operator: 'exists', value: '' },
        ],
      } as any,
      allowed_tool_names: [] as any,
      system_prompt: promptAgente3,
      persona_blocks: {
        identidade:
          'Assistente de formalização e entrega de chaves PIX e protocolos de acordos fechados.',
        instrucoes_pix:
          'Entregar código PIX copia e cola, orientar pagamento no app bancário até o vencimento e encerrar com cordialidade.',
      } as any,
      transitions: {
        llm_provider: 'gemini',
        capabilities: { web_search: false, rag: false },
      } as any,
    },
  });

  console.log('✅ 3 Agentes cadastrados e configurados com sucesso:');
  console.log('   1. inicio_atendimento (Inicial, tool: buscar_cpf)');
  console.log(
    '   2. negociacao (Ativação imediata: valor_divida > 0, tool: agreement)',
  );
  console.log(
    '   3. encerramento (Ativação imediata: acordo_confirmado == true, entrega PIX)',
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
