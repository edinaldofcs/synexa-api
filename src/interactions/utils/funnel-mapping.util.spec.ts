import {
  extractFunnelFromState,
  CANONICAL_FUNNEL_VARIABLES,
} from './funnel-mapping.util';

describe('extractFunnelFromState', () => {
  it('deve extrair acordo fechado com todos os dados monetários e identificadores', () => {
    const state = {
      cpf: '08334993942',
      nome_cliente: 'João da Silva',
      valor_original: 589.9,
      acordo_id: 'ACD-2026-083349',
      valor_total: 589.9,
      contrato: '015184516516561',
    };

    const res = extractFunnelFromState(state);

    expect(res.client_identifier).toBe('08334993942');
    expect(res.client_name).toBe('João da Silva');
    expect(res.is_right_party).toBe(true);
    expect(res.is_debt_presented).toBe(true);
    expect(res.debt_amount).toBe(589.9);
    expect(res.is_agreement_reached).toBe(true);
    expect(res.agreement_id).toBe('ACD-2026-083349');
    expect(res.agreement_amount).toBe(589.9);
    expect(res.disposition).toBe('AGREEMENT_CLOSED');
  });

  it('deve extrair promessa de pagamento (PTP)', () => {
    const state = {
      cpf: '12345678900',
      cliente_nome: 'Maria Souza',
      valor_original: 1200.5,
      promessa_pagamento: true,
      data_promessa: '2026-09-20',
      promessa_valor: 1200.5,
    };

    const res = extractFunnelFromState(state);

    expect(res.is_right_party).toBe(true);
    expect(res.is_debt_presented).toBe(true);
    expect(res.is_agreement_reached).toBe(false);
    expect(res.is_promise_to_pay).toBe(true);
    expect(res.promise_amount).toBe(1200.5);
    expect(res.promise_due_date).toBeInstanceOf(Date);
    expect(res.disposition).toBe('PTP');
  });

  it('deve identificar CPC sem acordo quando apenas CPF é informado', () => {
    const state = {
      cpf: '99988877766',
      nome: 'Carlos Lima',
    };

    const res = extractFunnelFromState(state);

    expect(res.is_right_party).toBe(true);
    expect(res.is_debt_presented).toBe(false);
    expect(res.is_agreement_reached).toBe(false);
    expect(res.disposition).toBe('CPC_NO_DEAL');
  });

  it('deve identificar retorno_api com acordo_id', () => {
    const state = {
      retorno_api: { acordo_id: 'API-ACD-999' },
      valor_acordo: 350.0,
    };

    const res = extractFunnelFromState(state);

    expect(res.is_agreement_reached).toBe(true);
    expect(res.agreement_id).toBe('API-ACD-999');
    expect(res.agreement_amount).toBe(350.0);
    expect(res.disposition).toBe('AGREEMENT_CLOSED');
  });

  it('deve conter catálogo canônico completo com todas as variáveis essenciais', () => {
    expect(CANONICAL_FUNNEL_VARIABLES.length).toBeGreaterThanOrEqual(10);
    const keys = CANONICAL_FUNNEL_VARIABLES.map((v) => v.key);
    expect(keys).toContain('cliente_cpf');
    expect(keys).toContain('valor_original');
    expect(keys).toContain('cpc');
    expect(keys).toContain('acordo_id');
    expect(keys).toContain('promessa_pagamento');
    expect(keys).toContain('data_promessa');
  });
});
