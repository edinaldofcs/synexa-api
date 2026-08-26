import {
  evaluateConditions,
  ActivationConditionGroup,
} from './condition-evaluator.util';

describe('evaluateConditions', () => {
  const state = {
    intent: 'suporte',
    sentiment_score: 0.8,
    tier: 'premium',
    count: 5,
    user: { name: 'João', plan: 'enterprise' },
    tags: ['urgente', 'financeiro'],
    empty: null,
  };

  describe('operators', () => {
    it('equals', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'equals', value: 'suporte' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = 'vendas';
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('not_equals', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'not_equals', value: 'vendas' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('contains', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'contains', value: 'sup' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = 'xyz';
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('starts_with', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'starts_with', value: 'sup' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = 'por';
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('ends_with', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'ends_with', value: 'rte' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('gt', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'sentiment_score', operator: 'gt', value: 0.5 },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = 0.9;
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('lt', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'sentiment_score', operator: 'lt', value: 0.9 },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('gte', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'sentiment_score', operator: 'gte', value: 0.8 },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('lte', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'sentiment_score', operator: 'lte', value: 0.8 },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('exists', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [{ variable: 'intent', operator: 'exists', value: null }],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('not_exists', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'nao_existe', operator: 'not_exists', value: null },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('in', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'tier', operator: 'in', value: ['premium', 'vip'] },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = ['basic', 'free'];
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('not_in', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'tier', operator: 'not_in', value: ['basic', 'free'] },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('regex', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [{ variable: 'intent', operator: 'regex', value: '^sup' }],
      };
      expect(evaluateConditions(group, state)).toBe(true);
      group.conditions[0].value = '^ven';
      expect(evaluateConditions(group, state)).toBe(false);
    });
  });

  describe('dot notation', () => {
    it('accesses nested values', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'user.name', operator: 'equals', value: 'João' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('accesses deeply nested values', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'user.plan', operator: 'equals', value: 'enterprise' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('returns false for missing nested paths', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'user.email', operator: 'exists', value: null },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('handles null parent in path', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'empty.something', operator: 'exists', value: null },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });
  });

  describe('logic operators', () => {
    it('AND - all must match', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'equals', value: 'suporte' },
          { variable: 'tier', operator: 'equals', value: 'premium' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('AND - one fails', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'intent', operator: 'equals', value: 'suporte' },
          { variable: 'tier', operator: 'equals', value: 'basic' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('OR - any matches', () => {
      const group: ActivationConditionGroup = {
        logic: 'OR',
        conditions: [
          { variable: 'intent', operator: 'equals', value: 'vendas' },
          { variable: 'tier', operator: 'equals', value: 'premium' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('OR - none matches', () => {
      const group: ActivationConditionGroup = {
        logic: 'OR',
        conditions: [
          { variable: 'intent', operator: 'equals', value: 'vendas' },
          { variable: 'tier', operator: 'equals', value: 'basic' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty conditions', () => {
      const group: ActivationConditionGroup = { logic: 'AND', conditions: [] };
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [{ variable: 'empty', operator: 'equals', value: null }],
      };
      expect(evaluateConditions(group, state)).toBe(true);
    });

    it('contains with null value returns false', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [
          { variable: 'empty', operator: 'contains', value: 'test' },
        ],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });

    it('regex with invalid pattern returns false', () => {
      const group: ActivationConditionGroup = {
        logic: 'AND',
        conditions: [{ variable: 'intent', operator: 'regex', value: '[' }],
      };
      expect(evaluateConditions(group, state)).toBe(false);
    });
  });

  describe('message aliases and coercion', () => {
    it('resolves text conditions through message aliases case-insensitively', () => {
      expect(
        evaluateConditions(
          {
            logic: 'AND',
            conditions: [
              {
                variable: 'mensagem_usuario',
                operator: 'contains',
                value: 'FINANCEIRO',
              },
              {
                variable: 'last_message',
                operator: 'starts_with',
                value: 'quero',
              },
              { variable: 'texto', operator: 'ends_with', value: 'ajuda' },
              {
                variable: 'message',
                operator: 'equals',
                value: 'Quero financeiro ajuda',
              },
            ],
          },
          { user_message: 'Quero financeiro ajuda' },
        ),
      ).toBe(true);
    });

    it('coerces numeric and boolean values safely', () => {
      expect(
        evaluateConditions(
          {
            logic: 'AND',
            conditions: [
              { variable: 'debt', operator: 'gt', value: 0 },
              { variable: 'approved', operator: 'equals', value: true },
            ],
          },
          { debt: '12.50', approved: 'true' },
        ),
      ).toBe(true);
      expect(
        evaluateConditions(
          {
            logic: 'AND',
            conditions: [{ variable: 'debt', operator: 'gt', value: 0 }],
          },
          { debt: 'not-a-number' },
        ),
      ).toBe(false);
    });
  });
});
