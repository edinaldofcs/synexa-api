import {
  resolveConditionalBlocks,
  evaluateConditionGroup,
  evaluateConditionRule,
  PromptContentBlock,
} from './conditional-prompt.util';

describe('conditional-prompt.util', () => {
  describe('evaluateConditionRule', () => {
    it('should evaluate equals and not_equals with strings', () => {
      expect(
        evaluateConditionRule(
          { variable: 'role', operator: 'equals', value: 'admin' },
          { role: 'admin' },
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'role', operator: 'not_equals', value: 'user' },
          { role: 'admin' },
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'role', operator: 'equals', value: 'admin' },
          { role: 'user' },
        ),
      ).toBe(false);
    });

    it('should evaluate numeric comparisons (gt, lt, gte, lte)', () => {
      const state = { saldo: 1500, idade: 18 };
      expect(
        evaluateConditionRule(
          { variable: 'saldo', operator: 'gt', value: 1000 },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'saldo', operator: 'lt', value: 1000 },
          state,
        ),
      ).toBe(false);

      expect(
        evaluateConditionRule(
          { variable: 'idade', operator: 'gte', value: 18 },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'idade', operator: 'lte', value: 18 },
          state,
        ),
      ).toBe(true);
    });

    it('should evaluate string operations (contains, starts_with, ends_with)', () => {
      const state = { tag: 'cliente_vip_gold' };
      expect(
        evaluateConditionRule(
          { variable: 'tag', operator: 'contains', value: 'vip' },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'tag', operator: 'starts_with', value: 'cliente_' },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'tag', operator: 'ends_with', value: 'gold' },
          state,
        ),
      ).toBe(true);
    });

    it('should evaluate exists and not_exists', () => {
      const state = { nome: 'João', vazio: null, indefinido: undefined };
      expect(
        evaluateConditionRule(
          { variable: 'nome', operator: 'exists' },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'vazio', operator: 'exists' },
          state,
        ),
      ).toBe(false);

      expect(
        evaluateConditionRule(
          { variable: 'indefinido', operator: 'not_exists' },
          state,
        ),
      ).toBe(true);
    });

    it('should evaluate in and not_in', () => {
      const state = { status: 'ativo' };
      expect(
        evaluateConditionRule(
          { variable: 'status', operator: 'in', value: ['ativo', 'pendente'] },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'status', operator: 'in', value: 'ativo, pendente' },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionRule(
          { variable: 'status', operator: 'not_in', value: ['cancelado', 'bloqueado'] },
          state,
        ),
      ).toBe(true);
    });
  });

  describe('evaluateConditionGroup (AND / OR logic)', () => {
    it('should evaluate AND logic correctly', () => {
      const state = { tipo_cliente: 'premium', saldo: 500 };
      expect(
        evaluateConditionGroup(
          {
            logic: 'AND',
            rules: [
              { variable: 'tipo_cliente', operator: 'equals', value: 'premium' },
              { variable: 'saldo', operator: 'gt', value: 0 },
            ],
          },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionGroup(
          {
            logic: 'AND',
            rules: [
              { variable: 'tipo_cliente', operator: 'equals', value: 'premium' },
              { variable: 'saldo', operator: 'gt', value: 1000 },
            ],
          },
          state,
        ),
      ).toBe(false);
    });

    it('should evaluate OR logic correctly', () => {
      const state = { tipo_cliente: 'regular', saldo: 500 };
      expect(
        evaluateConditionGroup(
          {
            logic: 'OR',
            rules: [
              { variable: 'tipo_cliente', operator: 'equals', value: 'premium' },
              { variable: 'saldo', operator: 'gt', value: 0 },
            ],
          },
          state,
        ),
      ).toBe(true);

      expect(
        evaluateConditionGroup(
          {
            logic: 'OR',
            rules: [
              { variable: 'tipo_cliente', operator: 'equals', value: 'vip' },
              { variable: 'saldo', operator: 'lt', value: 0 },
            ],
          },
          state,
        ),
      ).toBe(false);
    });
  });

  describe('resolveConditionalBlocks', () => {
    it('should return raw string when string is provided', () => {
      expect(resolveConditionalBlocks('Texto simples legado', {})).toBe(
        'Texto simples legado',
      );
    });

    it('should concatenate plain text blocks', () => {
      const blocks: PromptContentBlock[] = [
        { type: 'text', content: 'Parágrafo 1' },
        { type: 'text', content: 'Parágrafo 2' },
      ];
      expect(resolveConditionalBlocks(blocks, {})).toBe(
        'Parágrafo 1\n\nParágrafo 2',
      );
    });

    it('should resolve simple IF condition', () => {
      const blocks: PromptContentBlock[] = [
        { type: 'text', content: 'Você é um assistente.' },
        {
          type: 'conditional',
          condition: {
            logic: 'AND',
            rules: [{ variable: 'tipo', operator: 'equals', value: 'vip' }],
          },
          then_blocks: [{ type: 'text', content: 'Ofereça 40% de desconto.' }],
        },
      ];

      expect(resolveConditionalBlocks(blocks, { tipo: 'vip' })).toBe(
        'Você é um assistente.\n\nOfereça 40% de desconto.',
      );

      expect(resolveConditionalBlocks(blocks, { tipo: 'normal' })).toBe(
        'Você é um assistente.',
      );
    });

    it('should resolve IF / ELSEIF / ELSE structure', () => {
      const blocks: PromptContentBlock[] = [
        {
          type: 'conditional',
          condition: {
            logic: 'AND',
            rules: [{ variable: 'plano', operator: 'equals', value: 'enterprise' }],
          },
          then_blocks: [{ type: 'text', content: 'Atendimento Platinum 24/7.' }],
          elseif_branches: [
            {
              condition: {
                logic: 'AND',
                rules: [{ variable: 'plano', operator: 'equals', value: 'pro' }],
              },
              then_blocks: [{ type: 'text', content: 'Atendimento Gold em horário comercial.' }],
            },
          ],
          else_blocks: [{ type: 'text', content: 'Atendimento Standard por email.' }],
        },
      ];

      expect(resolveConditionalBlocks(blocks, { plano: 'enterprise' })).toBe(
        'Atendimento Platinum 24/7.',
      );

      expect(resolveConditionalBlocks(blocks, { plano: 'pro' })).toBe(
        'Atendimento Gold em horário comercial.',
      );

      expect(resolveConditionalBlocks(blocks, { plano: 'free' })).toBe(
        'Atendimento Standard por email.',
      );
    });

    it('should handle nested conditionals', () => {
      const blocks: PromptContentBlock[] = [
        {
          type: 'conditional',
          condition: {
            logic: 'AND',
            rules: [{ variable: 'is_auth', operator: 'equals', value: true }],
          },
          then_blocks: [
            { type: 'text', content: 'Usuário autenticado.' },
            {
              type: 'conditional',
              condition: {
                logic: 'AND',
                rules: [{ variable: 'role', operator: 'equals', value: 'admin' }],
              },
              then_blocks: [{ type: 'text', content: 'Permissão de administrador total.' }],
              else_blocks: [{ type: 'text', content: 'Acesso padrão de cliente.' }],
            },
          ],
          else_blocks: [{ type: 'text', content: 'Solicite login ao usuário.' }],
        },
      ];

      expect(
        resolveConditionalBlocks(blocks, { is_auth: true, role: 'admin' }),
      ).toBe('Usuário autenticado.\n\nPermissão de administrador total.');

      expect(
        resolveConditionalBlocks(blocks, { is_auth: true, role: 'user' }),
      ).toBe('Usuário autenticado.\n\nAcesso padrão de cliente.');

      expect(
        resolveConditionalBlocks(blocks, { is_auth: false, role: 'admin' }),
      ).toBe('Solicite login ao usuário.');
    });

    it('should resolve text-based [SE ...] conditional syntax', () => {
      const text = `Você é um atendente.
[SE tipo_cliente == "vip"]
Ofereça desconto exclusivo de 30%.
[SENÃO]
Ofereça desconto padrão de 10%.
[FIM SE]
Tenha um bom dia!`;

      expect(resolveConditionalBlocks(text, { tipo_cliente: 'vip' })).toBe(
        `Você é um atendente.\nOfereça desconto exclusivo de 30%.\nTenha um bom dia!`,
      );

      expect(resolveConditionalBlocks(text, { tipo_cliente: 'normal' })).toBe(
        `Você é um atendente.\nOfereça desconto padrão de 10%.\nTenha um bom dia!`,
      );
    });

    it('should resolve text-based [SE ...] with E (AND) and OU (OR)', () => {
      const text = `[SE saldo > 0 E tipo == "vip"]
Aprovado VIP com saldo.
[FIM SE]`;

      expect(resolveConditionalBlocks(text, { saldo: 500, tipo: 'vip' })).toBe(
        'Aprovado VIP com saldo.',
      );

      expect(resolveConditionalBlocks(text, { saldo: 0, tipo: 'vip' })).toBe(
        '',
      );
    });
  });
});

