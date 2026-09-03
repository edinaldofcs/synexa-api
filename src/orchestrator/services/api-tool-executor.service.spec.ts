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
});

function mockedResolve(nextApiId: string) {
  mockedResolveChainedApiId.mockReturnValue(nextApiId);
}
