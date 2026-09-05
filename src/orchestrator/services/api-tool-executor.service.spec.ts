import { ApiToolExecutorService } from './api-tool-executor.service';

jest.mock('../../common/utils/api-chaining.util', () => ({
  resolveChainedApiId: jest.fn(),
}));
jest.mock('../../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
}));

import { resolveChainedApiId } from '../../common/utils/api-chaining.util';
import { validateWebhookUrl } from '../../common/utils/ssrf-guard';

const mockedResolveChainedApiId = resolveChainedApiId as jest.Mock;
const mockedValidateWebhookUrl = validateWebhookUrl as jest.Mock;

describe('ApiToolExecutorService - chaining tenant scope & cycle guard', () => {
  const prisma = {
    painel_apis: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    conversation_state: { findUnique: jest.fn().mockResolvedValue(null) },
    painel_subagents: { findFirst: jest.fn() },
  };
  const service = new ApiToolExecutorService(
    prisma as never,
    {} as never,
    {} as never,
    { requestHandoff: jest.fn() } as never,
    {} as never,
  );

  const fetchMock = (
    body: Record<string, unknown>,
    status = 200,
    ok = true,
  ) => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
      ok,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    prisma.conversation_state.findUnique.mockResolvedValue(null);
  });

  it('filters chained API lookup by client_id (no cross-tenant execution)', async () => {
    mockedResolveChainedApiId.mockReturnValue('api-next');
    prisma.painel_apis.findFirst.mockResolvedValue(null);
    fetchMock({});

    await (service as any).executeApiTool(
      {
        id: 'api-1',
        name: 'Primeira',
        functionName: 'primeira',
        method: 'GET',
        url: 'https://api.example.com/step1',
        client_id: 'client-1',
        extract_data: {},
      },
      {},
      {},
      new Set(['api-1']),
    );

    expect(prisma.painel_apis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          client_id: 'client-1',
          active: true,
        }),
      }),
    );
  });

  it('aborts chain before any lookup when next API was already visited (cycle)', async () => {
    mockedResolveChainedApiId.mockReturnValue('api-1');
    fetchMock({});

    const result = await (service as any).executeApiTool(
      {
        id: 'api-1',
        name: 'Ciclica',
        functionName: 'ciclica',
        method: 'GET',
        url: 'https://api.example.com/self',
        client_id: 'client-1',
        extract_data: {
          _chaining: [{ when: 'always', next_api_id: 'api-1' }],
        },
      },
      {},
      {},
      new Set(['api-1']),
    );

    expect(result.ok).toBe(true);
    expect(prisma.painel_apis.findFirst).not.toHaveBeenCalled();
  });

  it('allows legitimate chain of distinct APIs', async () => {
    mockedResolveChainedApiId.mockReturnValue('api-2');
    fetchMock({ step: 1 });

    prisma.painel_apis.findFirst.mockResolvedValue({
      id: 'api-2',
      name: 'Segunda',
      method: 'GET',
      url: 'https://api.example.com/step2',
      headers: null,
      body: null,
      parameters: null,
      extract_data: null,
    });

    const result = await (service as any).executeApiTool(
      {
        id: 'api-1',
        name: 'Primeira',
        functionName: 'primeira',
        method: 'GET',
        url: 'https://api.example.com/step1',
        client_id: 'client-1',
        extract_data: null,
      },
      {},
      {},
      new Set(['api-1']),
    );

    expect(prisma.painel_apis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ client_id: 'client-1' }),
      }),
    );
    expect(result.chained_result).toBeDefined();
  });

  it('rejeita execução quando validateWebhookUrl detecta SSRF', async () => {
    mockedValidateWebhookUrl.mockRejectedValueOnce(
      new Error('Access to private/internal IP is not allowed'),
    );

    await expect(
      (service as any).executeApiTool(
        {
          id: 'api-ssrf',
          name: 'Privada',
          functionName: 'privada',
          method: 'GET',
          url: 'http://169.254.169.254/latest/meta-data',
          client_id: 'client-1',
          extract_data: null,
        },
        {},
        {},
        new Set(['api-ssrf']),
      ),
    ).rejects.toThrow(/Access to private\/internal IP is not allowed/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('applyExtractData com condições compostas e retorno de caminhos dinâmicos', () => {
    const rawPayload = {
      status_code: 200,
      customer: {
        nome: 'Carlos Souza',
        plano: 'premium',
        saldo: 350.5,
      },
      divida: {
        dias_atraso: 25,
        status: 'EM_ATRASO',
        valor_original: 300,
        valor_atualizado: 350.5,
      },
    };

    it('retorna campo dinâmico da API via return_type path e fallback_type path', () => {
      const extractMap = {
        valor_final: {
          path: 'divida.status',
          rules: [
            {
              operator: '==',
              compare_value: 'EM_ATRASO',
              return_value: 'divida.valor_atualizado',
              return_type: 'path',
            },
          ],
        },
        documento_contingencia: {
          path: 'customer.doc_inexistente',
          fallback: 'customer.nome',
          fallback_type: 'path',
        },
      };

      const extracted = (service as any).applyExtractData(
        rawPayload,
        extractMap,
      );
      expect(extracted.valor_final).toBe(350.5);
      expect(extracted.documento_contingencia).toBe('Carlos Souza');
    });

    it('avalia regras compostas com operador lógico AND e OR', () => {
      const extractMap = {
        elegivel_desconto: {
          path: 'divida.dias_atraso',
          rules: [
            {
              operator: '==',
              compare_value: '',
              return_value: true,
              return_type: 'boolean',
              logic: 'and',
              conditions: [
                {
                  path: 'divida.dias_atraso',
                  operator: '>',
                  compare_value: '10',
                },
                {
                  path: 'customer.plano',
                  operator: '==',
                  compare_value: 'premium',
                },
              ],
            },
          ],
          fallback: false,
          fallback_type: 'boolean',
        },
        regra_and_com_falha: {
          path: 'divida.dias_atraso',
          rules: [
            {
              operator: '==',
              compare_value: '',
              return_value: 'Aprovado',
              logic: 'and',
              conditions: [
                {
                  path: 'divida.dias_atraso',
                  operator: '>',
                  compare_value: '100',
                }, // falso
                {
                  path: 'customer.plano',
                  operator: '==',
                  compare_value: 'premium',
                },
              ],
            },
          ],
          fallback: 'Recusado pelo Fallback',
        },
        regra_or: {
          path: 'divida.status',
          rules: [
            {
              operator: '==',
              compare_value: '',
              return_value: 'Aprovado pelo OR',
              logic: 'or',
              conditions: [
                {
                  path: 'divida.dias_atraso',
                  operator: '>',
                  compare_value: '1000',
                }, // falso
                {
                  path: 'divida.status',
                  operator: '==',
                  compare_value: 'EM_ATRASO',
                }, // verdadeiro
              ],
            },
          ],
        },
      };

      const extracted = (service as any).applyExtractData(
        rawPayload,
        extractMap,
      );
      expect(extracted.elegivel_desconto).toBe(true);
      expect(extracted.regra_and_com_falha).toBe('Recusado pelo Fallback');
      expect(extracted.regra_or).toBe('Aprovado pelo OR');
    });
  });
});

function mockedResolve(nextApiId: string) {
  mockedResolveChainedApiId.mockReturnValue(nextApiId);
}
