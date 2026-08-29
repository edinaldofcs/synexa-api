import { NativeToolsService } from './native-tools.service';

describe('NativeToolsService', () => {
  let service: NativeToolsService;

  beforeEach(() => {
    service = new NativeToolsService();
  });

  describe('getDeclarations', () => {
    it('deve retornar as declarações das ferramentas nativas', () => {
      const decls = service.getDeclarations();
      expect(decls.length).toBe(3);
      const names = decls.map((d) => d.name);
      expect(names).toContain('validate_variable_part');
      expect(names).toContain('set_session_variable');
      expect(names).toContain('calculate_financial');
    });
  });

  describe('validateVariablePart', () => {
    const sessionState = {
      cnpj_cpf: '123.456.789-00',
      telefone: '11987654321',
      cliente_nome: 'Carlos Eduardo da Silva',
      codigo_acesso: 'ABC9988',
    };

    it('deve validar os primeiros dígitos do CPF (left)', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'cnpj_cpf',
          match_type: 'left',
          value_to_check: '123',
        },
        sessionState,
      );

      expect(res.ok).toBe(true);
      expect(res.valid).toBe(true);
      expect(res.matches).toBe(true);
    });

    it('deve validar os últimos dígitos do CPF (right)', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'cnpj_cpf',
          match_type: 'right',
          value_to_check: '900',
        },
        sessionState,
      );

      expect(res.ok).toBe(true);
      expect(res.valid).toBe(true);
      expect(res.matches).toBe(true);
    });

    it('deve falhar se os dígitos não conferirem', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'cnpj_cpf',
          match_type: 'left',
          value_to_check: '999',
        },
        sessionState,
      );

      expect(res.ok).toBe(true);
      expect(res.valid).toBe(false);
      expect(res.matches).toBe(false);
    });

    it('deve validar texto com contains', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'cliente_nome',
          match_type: 'contains',
          value_to_check: 'Eduardo',
        },
        sessionState,
      );

      expect(res.ok).toBe(true);
      expect(res.valid).toBe(true);
    });

    it('deve resolver alias semântico (cpf -> cnpj_cpf)', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'cpf',
          match_type: 'left',
          value_to_check: '123',
        },
        sessionState,
      );

      expect(res.ok).toBe(true);
      expect(res.valid).toBe(true);
    });

    it('deve retornar erro se a variável não existir na sessão', () => {
      const res = service.validateVariablePart(
        {
          variable_name: 'variavel_inexistente',
          match_type: 'left',
          value_to_check: '123',
        },
        sessionState,
      );

      expect(res.ok).toBe(false);
      expect(res.valid).toBe(false);
    });
  });

  describe('setSessionVariable', () => {
    it('deve gravar variável na sessão e criar aliases', () => {
      const state: Record<string, unknown> = {};
      const res = service.setSessionVariable(
        {
          name: 'forma_pagamento',
          value: 'PIX',
        },
        state,
      );

      expect(res.ok).toBe(true);
      expect(state.forma_pagamento).toBe('PIX');
    });

    it('deve criar aliases automáticos para CPF', () => {
      const state: Record<string, unknown> = {};
      const res = service.setSessionVariable(
        {
          name: 'cpf',
          value: '12345678900',
        },
        state,
      );

      expect(res.ok).toBe(true);
      expect(state.cpf).toBe('12345678900');
      expect(state.cnpj_cpf).toBe('12345678900');
      expect(state.documento).toBe('12345678900');
    });
  });

  describe('calculateFinancial', () => {
    it('deve calcular desconto percentual e parcelas sem juros', () => {
      const res = service.calculateFinancial({
        operation: 'both',
        principal_amount: 1000,
        discount_percentage: 10,
        installments_count: 3,
      });

      expect(res.ok).toBe(true);
      expect(res.original_amount).toBe(1000);
      expect(res.discount_applied).toBe(100);
      expect(res.final_cash_amount).toBe(900);
      expect(res.installment_value).toBe(300);
      expect(res.total_with_installments).toBe(900);
      expect(res.total_interest).toBe(0);
    });

    it('deve calcular parcelamento com juros compostos', () => {
      const res = service.calculateFinancial({
        operation: 'installment',
        principal_amount: 1000,
        installments_count: 6,
        interest_rate_monthly: 2,
      });

      expect(res.ok).toBe(true);
      expect(res.original_amount).toBe(1000);
      expect(res.installment_value).toBeGreaterThan(166.67);
      expect(res.total_with_installments).toBeGreaterThan(1000);
      expect(res.total_interest).toBeGreaterThan(0);
    });

    it('deve aceitar strings monetárias brasileiras', () => {
      const res = service.calculateFinancial({
        operation: 'discount',
        principal_amount: 'R$ 1.500,50',
        discount_percentage: 20,
      });

      expect(res.ok).toBe(true);
      expect(res.original_amount).toBe(1500.5);
      expect(res.discount_applied).toBe(300.1);
      expect(res.final_cash_amount).toBe(1200.4);
    });
  });
});
