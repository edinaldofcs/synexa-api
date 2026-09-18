/**
 * Helper utilitário para extração padronizada de métricas de funil de cobrança
 * e interlocutores a partir do estado de sessão (variáveis de contexto e retornos de API).
 * 
 * Unifica a lógica para todos os canais do Synexa:
 * - Voz WebRTC (Navegador)
 * - Voz SIP/Asterisk (Telefonia)
 * - Chat Web / WhatsApp / Simulador
 */

export interface MappedFunnelData {
  client_identifier: string | null;
  client_name: string | null;
  is_right_party: boolean;
  right_party_at: Date | null;
  is_debt_presented: boolean;
  debt_presented_at: Date | null;
  debt_amount: number | null;
  is_agreement_reached: boolean;
  agreement_at: Date | null;
  agreement_id: string | null;
  agreement_amount: number | null;
  is_promise_to_pay: boolean;
  promise_to_pay_at: Date | null;
  promise_due_date: Date | null;
  promise_amount: number | null;
  disposition: string;
}

export interface CanonicalFunnelVariableDefinition {
  key: string;
  label: string;
  stage: 'identification' | 'cpc' | 'cpca' | 'agreement' | 'ptp' | 'handover';
  stageLabel: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  description: string;
  biMetric: string;
  aliases: string[];
}

export const CANONICAL_FUNNEL_VARIABLES: CanonicalFunnelVariableDefinition[] = [
  {
    key: 'cliente_cpf',
    label: 'CPF / Identificador do Cliente',
    stage: 'identification',
    stageLabel: 'Identificação do Cliente',
    type: 'string',
    description: 'Documento ou telefone único do cliente. Alimenta client_identifier e ativa CPC.',
    biMetric: 'Clientes únicos contatados e ativação de CPC',
    aliases: ['cpf', 'telefone', 'phone', 'client_identifier'],
  },
  {
    key: 'cliente_nome',
    label: 'Nome do Cliente',
    stage: 'identification',
    stageLabel: 'Identificação do Cliente',
    type: 'string',
    description: 'Nome completo ou primeiro nome do cliente para personalização e relatórios.',
    biMetric: 'Identificação nominal do interlocutor',
    aliases: ['nome_cliente', 'nome', 'client_name'],
  },
  {
    key: 'cpc',
    label: 'Contato com Pessoa Certa (CPC)',
    stage: 'cpc',
    stageLabel: 'Pessoa Certa (CPC)',
    type: 'boolean',
    description: 'Flag booleana (true) indicando que o contato foi estabelecido com o titular.',
    biMetric: 'Total CPC e Taxa de CPC (%)',
    aliases: ['pessoa_certa'],
  },
  {
    key: 'valor_original',
    label: 'Valor da Dívida (CPCA)',
    stage: 'cpca',
    stageLabel: 'Apresentação da Dívida (CPCA)',
    type: 'number',
    description: 'Valor monetário original ou pendente do débito. Ativa automaticamente CPCA no BI.',
    biMetric: 'Total CPCA e Volume de dívida trabalhado',
    aliases: ['divida_valor', 'valor_divida', 'saldo_devedor', 'debt_amount'],
  },
  {
    key: 'cpca',
    label: 'Confirmação de CPCA',
    stage: 'cpca',
    stageLabel: 'Apresentação da Dívida (CPCA)',
    type: 'boolean',
    description: 'Flag booleana (true) confirmando que a dívida/proposta foi apresentada.',
    biMetric: 'Taxa de Apresentação de Dívida (CPCA)',
    aliases: ['divida_apresentada'],
  },
  {
    key: 'acordo_id',
    label: 'ID do Acordo Fechado',
    stage: 'agreement',
    stageLabel: 'Acordo Fechado',
    type: 'string',
    description: 'Identificador do acordo gerado pela API de cobrança/CRM.',
    biMetric: 'Total de Acordos e Tabulação AGREEMENT_CLOSED',
    aliases: ['id_acordo', 'retorno_api.acordo_id'],
  },
  {
    key: 'acordo',
    label: 'Confirmação de Acordo',
    stage: 'agreement',
    stageLabel: 'Acordo Fechado',
    type: 'boolean',
    description: 'Flag booleana (true) confirmando fechamento de acordo na sessão.',
    biMetric: 'Taxa de Conversão de Acordo (%)',
    aliases: ['acordo_confirmado'],
  },
  {
    key: 'valor_total',
    label: 'Valor do Acordo Negociado',
    stage: 'agreement',
    stageLabel: 'Acordo Fechado',
    type: 'number',
    description: 'Valor final acordado para pagamento (volume financeiro recuperado em R$).',
    biMetric: 'Valor Total Negociado (Recuperação de Crédito)',
    aliases: ['valor_acordo', 'agreement_amount'],
  },
  {
    key: 'promessa_pagamento',
    label: 'Promessa de Pagamento (PTP)',
    stage: 'ptp',
    stageLabel: 'Promessa de Pagamento (PTP)',
    type: 'boolean',
    description: 'Flag booleana (true) indicando intenção ou compromisso de pagamento.',
    biMetric: 'Volume e Taxa de PTP',
    aliases: [],
  },
  {
    key: 'data_promessa',
    label: 'Data de Vencimento da Promessa',
    stage: 'ptp',
    stageLabel: 'Promessa de Pagamento (PTP)',
    type: 'date',
    description: 'Data acordada para quitação (formato ISO ou DD/MM/AAAA).',
    biMetric: 'Controle de Vencimentos e Quebra de Acordo',
    aliases: ['data_pagamento', 'promise_date'],
  },
  {
    key: 'promessa_valor',
    label: 'Valor da Promessa de Pagamento',
    stage: 'ptp',
    stageLabel: 'Promessa de Pagamento (PTP)',
    type: 'number',
    description: 'Valor monetário específico prometido pelo cliente.',
    biMetric: 'Volume financeiro de promessas de pagamento',
    aliases: ['valor_promessa', 'promise_amount'],
  },
  {
    key: 'atendimento_humano',
    label: 'Transbordo / Alô Humano',
    stage: 'handover',
    stageLabel: 'Transbordo / Alô Humano',
    type: 'boolean',
    description: 'Flag indicando transbordo para operador humano ou atendimento humano.',
    biMetric: 'Taxa de Automação vs. Transbordo Humano',
    aliases: ['has_human_answer'],
  },
];

export function extractFunnelFromState(
  state: Record<string, unknown> = {},
  now: Date = new Date(),
): MappedFunnelData {
  const vars = (state || {}) as Record<string, any>;

  // 1. Identificadores do Cliente
  const clientIdentifier =
    (vars.cliente_cpf as string) ||
    (vars.cpf as string) ||
    (vars.telefone as string) ||
    (vars.phone as string) ||
    (vars.client_identifier as string) ||
    null;

  const clientName =
    (vars.cliente_nome as string) ||
    (vars.nome_cliente as string) ||
    (vars.nome as string) ||
    (vars.client_name as string) ||
    null;

  // 2. CPC (Contato com a Pessoa Certa)
  const isRightParty = !!(
    vars.cpc === true ||
    vars.cpc === 'true' ||
    vars.pessoa_certa === true ||
    vars.pessoa_certa === 'true' ||
    clientIdentifier !== null
  );

  // 3. CPCA (Apresentação da Dívida)
  const rawDebt =
    vars.valor_original ??
    vars.divida_valor ??
    vars.valor_divida ??
    vars.saldo_devedor ??
    vars.debt_amount ??
    null;
  const debtAmount =
    rawDebt !== null && !isNaN(Number(rawDebt)) ? Number(rawDebt) : null;

  const isDebtPresented = !!(
    vars.cpca === true ||
    vars.cpca === 'true' ||
    vars.divida_apresentada === true ||
    vars.divida_apresentada === 'true' ||
    (debtAmount !== null && debtAmount > 0)
  );

  // 4. Acordo Fechado
  const agreementId =
    (vars.acordo_id as string) ||
    (vars.id_acordo as string) ||
    (vars.retorno_api?.acordo_id as string) ||
    null;

  const isAgreementReached = !!(
    vars.acordo === true ||
    vars.acordo === 'true' ||
    vars.acordo_confirmado === true ||
    vars.acordo_confirmado === 'true' ||
    agreementId !== null
  );

  const rawAgreementAmount =
    vars.valor_total ??
    vars.valor_acordo ??
    vars.agreement_amount ??
    (debtAmount !== null ? debtAmount : null);
  const agreementAmount =
    rawAgreementAmount !== null && !isNaN(Number(rawAgreementAmount))
      ? Number(rawAgreementAmount)
      : null;

  // 5. Promessa de Pagamento (PTP)
  const isPromiseToPay = !!(
    vars.promessa_pagamento === true ||
    vars.promessa_pagamento === 'true' ||
    vars.data_promessa ||
    vars.data_pagamento ||
    vars.promise_date
  );

  const rawPromiseAmount =
    vars.promessa_valor ??
    vars.valor_promessa ??
    vars.promise_amount ??
    null;
  const promiseAmount =
    rawPromiseAmount !== null && !isNaN(Number(rawPromiseAmount))
      ? Number(rawPromiseAmount)
      : agreementAmount;

  let promiseDueDate: Date | null = null;
  const rawDate = vars.data_promessa || vars.data_pagamento || vars.promise_date;
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) {
      promiseDueDate = parsed;
    }
  }

  // 6. Tabulação / Disposição
  let disposition = 'IN_PROGRESS';
  if (isAgreementReached) {
    disposition = 'AGREEMENT_CLOSED';
  } else if (isPromiseToPay) {
    disposition = 'PTP';
  } else if (isDebtPresented) {
    disposition = 'CPCA_DEBT_PRESENTED';
  } else if (isRightParty) {
    disposition = 'CPC_NO_DEAL';
  } else if (vars.atendimento_humano === true || vars.has_human_answer === true) {
    disposition = 'HUMAN_ANSWERED';
  }

  return {
    client_identifier: clientIdentifier,
    client_name: clientName,
    is_right_party: isRightParty,
    right_party_at: isRightParty ? now : null,
    is_debt_presented: isDebtPresented,
    debt_presented_at: isDebtPresented ? now : null,
    debt_amount: debtAmount,
    is_agreement_reached: isAgreementReached,
    agreement_at: isAgreementReached ? now : null,
    agreement_id: agreementId,
    agreement_amount: isAgreementReached ? agreementAmount : null,
    is_promise_to_pay: isPromiseToPay,
    promise_to_pay_at: isPromiseToPay ? now : null,
    promise_due_date: promiseDueDate,
    promise_amount: isPromiseToPay ? promiseAmount : null,
    disposition,
  };
}
