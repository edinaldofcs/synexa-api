import {
  evaluateChainingCondition,
  extractChainingConfig,
  resolveChainedApiId,
} from './api-chaining.util';

const API_A = '11111111-1111-1111-1111-111111111111';
const API_B = '22222222-2222-2222-2222-222222222222';
const API_C = '33333333-3333-3333-3333-333333333333';

describe('api-chaining.util', () => {
  describe('extractChainingConfig', () => {
    it('retorna null quando extract_data não tem _chaining', () => {
      expect(extractChainingConfig({ tipo: 'data.tipo' })).toBeNull();
      expect(extractChainingConfig(null)).toBeNull();
      expect(extractChainingConfig(undefined)).toBeNull();
      expect(extractChainingConfig('string')).toBeNull();
      expect(extractChainingConfig({ _chaining: 'invalido' })).toBeNull();
    });

    it('retorna null quando _chaining não tem regras válidas nem default', () => {
      expect(
        extractChainingConfig({ _chaining: { rules: [{ field: 'tipo' }] } }),
      ).toBeNull();
      expect(extractChainingConfig({ _chaining: {} })).toBeNull();
    });

    it('descarta regras sem next_api_id ou sem field', () => {
      const config = extractChainingConfig({
        _chaining: {
          rules: [
            { field: 'tipo', operator: '==', next_api_id: API_A },
            { field: 'tipo', operator: '==' },
            { operator: '==', next_api_id: API_B },
            'invalido',
          ],
        },
      });
      expect(config?.rules).toHaveLength(1);
      expect(config?.rules?.[0].next_api_id).toBe(API_A);
    });

    it('aceita operadores sem field (is_empty_array etc.)', () => {
      const config = extractChainingConfig({
        _chaining: {
          rules: [{ operator: 'is_empty_array', next_api_id: API_A }],
        },
      });
      expect(config?.rules).toHaveLength(1);
    });
  });

  describe('evaluateChainingCondition', () => {
    it('operadores de comparação', () => {
      expect(evaluateChainingCondition('alto risco', '==', 'alto risco')).toBe(
        true,
      );
      expect(evaluateChainingCondition('ALTO', '==', 'alto')).toBe(false);
      expect(evaluateChainingCondition('baixo', '!=', 'alto')).toBe(true);
      expect(evaluateChainingCondition(10, '>', 5)).toBe(true);
      expect(evaluateChainingCondition('10', '>=', 10)).toBe(true);
      expect(evaluateChainingCondition(3, '<', 5)).toBe(true);
      expect(evaluateChainingCondition(3, '<=', 2)).toBe(false);
      expect(
        evaluateChainingCondition('risco alto detectado', 'includes', 'alto'),
      ).toBe(true);
    });

    it('operadores de vazio', () => {
      expect(evaluateChainingCondition([], 'is_empty_array', null)).toBe(true);
      expect(evaluateChainingCondition([1], 'is_empty_array', null)).toBe(
        false,
      );
      expect(evaluateChainingCondition([1], 'is_not_empty_array', null)).toBe(
        true,
      );
      expect(evaluateChainingCondition(null, 'is_empty', null)).toBe(true);
      expect(evaluateChainingCondition('', 'is_empty', null)).toBe(true);
      expect(evaluateChainingCondition({}, 'is_empty', null)).toBe(true);
      expect(evaluateChainingCondition('x', 'is_not_empty', null)).toBe(true);
      expect(evaluateChainingCondition(null, 'is_not_empty', null)).toBe(false);
    });

    it('compara igualdade numérica entre string e number', () => {
      expect(evaluateChainingCondition('2', '==', 2)).toBe(true);
      expect(evaluateChainingCondition('2', '==', '2')).toBe(true);
    });
  });

  describe('resolveChainedApiId', () => {
    const extractData = {
      tipo: { path: 'data.tipo' },
      _chaining: {
        rules: [
          {
            field: 'tipo',
            operator: '==',
            compare_value: 'alto risco',
            next_api_id: API_A,
          },
          {
            field: 'tipo',
            operator: '==',
            compare_value: 'baixo risco',
            next_api_id: API_B,
          },
        ],
      },
    };

    it('roteia para a API da primeira regra que casa', () => {
      expect(resolveChainedApiId(extractData, { tipo: 'alto risco' })).toBe(
        API_A,
      );
      expect(resolveChainedApiId(extractData, { tipo: 'baixo risco' })).toBe(
        API_B,
      );
    });

    it('cai no fallback legado quando nenhuma regra casa e não há default', () => {
      expect(
        resolveChainedApiId(extractData, { tipo: 'medio' }, 'legacy-id'),
      ).toBe('legacy-id');
      expect(
        resolveChainedApiId(extractData, { tipo: 'medio' }, 'legacy-id'),
      ).not.toBe(API_A);
    });

    it('usa default_next_api_id quando nenhuma regra casa', () => {
      const comDefault = {
        ...extractData,
        _chaining: { ...extractData._chaining, default_next_api_id: API_C },
      };
      expect(
        resolveChainedApiId(comDefault, { tipo: 'medio' }, 'legacy-id'),
      ).toBe(API_C);
    });

    it('suporta campo com dot path', () => {
      const nested = {
        _chaining: {
          rules: [
            {
              field: 'risk.level',
              operator: '==',
              compare_value: 'high',
              next_api_id: API_A,
            },
          ],
        },
      };
      expect(resolveChainedApiId(nested, { risk: { level: 'high' } })).toBe(
        API_A,
      );
    });

    it('mantém encadeamento direto quando não há _chaining', () => {
      expect(resolveChainedApiId({ tipo: 'x' }, {}, 'legacy-id')).toBe(
        'legacy-id',
      );
      expect(resolveChainedApiId(null, {}, 'legacy-id')).toBe('legacy-id');
      expect(resolveChainedApiId(null, {})).toBeNull();
    });

    it('avalia regras contra dados extraídos mesmo sem campo mapeado', () => {
      const porArray = {
        _chaining: {
          rules: [
            {
              field: 'ofertas',
              operator: 'is_empty_array',
              next_api_id: API_A,
            },
            {
              field: 'ofertas',
              operator: 'is_not_empty_array',
              next_api_id: API_B,
            },
          ],
        },
      };
      expect(resolveChainedApiId(porArray, { ofertas: [] })).toBe(API_A);
      expect(resolveChainedApiId(porArray, { ofertas: [{ id: 1 }] })).toBe(
        API_B,
      );
    });

    it('não roteia quando dados não são objeto e regra exige campo', () => {
      const comDefault = {
        _chaining: {
          rules: [
            {
              field: 'tipo',
              operator: '==',
              compare_value: 'x',
              next_api_id: API_A,
            },
          ],
          default_next_api_id: API_C,
        },
      };
      expect(resolveChainedApiId(comDefault, 'texto')).toBe(API_C);
    });
  });
});
