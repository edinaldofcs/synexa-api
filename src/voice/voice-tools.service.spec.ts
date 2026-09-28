jest.mock('../common/utils/public-http', () => ({
  publicFetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));
import { VoiceToolsService } from './voice-tools.service';
import type { HttpToolAudit } from './services/voice-tool-audit';

jest.mock('../common/utils/api-chaining.util', () => ({
  resolveChainedApiId: jest.fn(),
}));
jest.mock('../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
}));

import { resolveChainedApiId } from '../common/utils/api-chaining.util';
import { validateWebhookUrl } from '../common/utils/ssrf-guard';

const mockedResolveChainedApiId = resolveChainedApiId as jest.Mock;
const mockedValidateWebhookUrl = validateWebhookUrl as jest.Mock;

const buildPrisma = (apiRecord: Record<string, unknown>) => {
  const prisma = {
    painel_agents: {
      findFirst: jest.fn().mockResolvedValue({ allowed_tool_names: [] }),
    },
    painel_apis: {
      findMany: jest.fn().mockResolvedValue([apiRecord]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    painel_subagents: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    redis,
    service: new VoiceToolsService(prisma as any, {} as any, redis as any),
  };
};

const captureFetch = (
  respond: { ok: boolean; status?: number; body?: unknown } = { ok: true },
) => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: respond.ok,
        status: respond.status ?? 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => respond.body ?? {},
        text: async () => JSON.stringify(respond.body ?? {}),
      } as unknown as Response;
    });
  return requests;
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('webhook-only HTTP audit', () => {
  it('saves AI input before the next voice API reads its configured session variable', async () => {
    const first = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Primeira',
      method: 'POST',
      url: 'https://example.com/first',
      body: {
        documento: {
          source: 'ai',
          save_to_session: true,
          session_variable: '{{CPFConsulta}}',
        },
      },
    };
    const next = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Segunda',
      method: 'POST',
      url: 'https://example.com/second',
      body: { cpf: { source: 'system', value: 'CPFConsulta', required: true } },
    };
    const { service, prisma } = buildPrisma(first);
    prisma.painel_apis.findMany.mockResolvedValue([first, next]);
    prisma.painel_apis.findFirst.mockResolvedValue(next as any);
    mockedResolveChainedApiId.mockReset().mockReturnValueOnce(next.id);
    const requests = captureFetch({ ok: true, body: { accepted: true } });
    const state = {};
    const result = await service.execute(
      'client',
      'agent',
      'primeira',
      { documento: '00123456789' },
      state,
    );
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].init.body as string)).toEqual({
      cpf: '00123456789',
    });
    expect(state).toMatchObject({ CPFConsulta: '00123456789' });
    expect(state).not.toHaveProperty('cpf');
    expect(result).toMatchObject({ ok: true, CPFConsulta: '00123456789' });
  });

  const api = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Lookup',
    method: 'POST',
    url: 'https://example.com/customer/{cpf}',
    headers: { Authorization: 'Bearer test-audit-credential' },
    body: {
      amount: { source: 'system', value: 'amount' },
      cpf: { source: 'ai' },
    },
    extract_data: { balance: 'balance' },
  };
  beforeEach(() => mockedResolveChainedApiId.mockReturnValue(undefined));

  it.each([
    {},
    { unrelated: 'private-raw-value' },
    { balance: null },
    { balance: '' },
    { balance: '   ' },
    { balance: [] },
    { balance: {} },
    { balance: { missing: null } },
    [],
    'not-json-data',
    0,
    false,
  ])(
    'returns the configured fallback when mapped data is empty (%j)',
    async (body) => {
      const { service } = buildPrisma({
        ...api,
        extract_data: {
          balance: 'balance',
          _fallback_message: 'Não localizado',
          _chaining: { rules: [] },
        },
      });
      captureFetch({ ok: true, body });
      const audit: HttpToolAudit[] = [];
      const result = await service.execute(
        'client',
        'agent',
        'lookup',
        { cpf: '123' },
        {},
        undefined,
        audit,
      );
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        ok: false,
        status: 200,
        error: 'extraction_empty',
        message: 'Não localizado',
      });
      expect(audit[0].response?.body).toEqual(body);
      expect(mockedResolveChainedApiId).not.toHaveBeenCalled();
    },
  );

  it.each([0, false, 'available', [0], { available: false }])(
    'keeps valid extracted values including falsy values (%j)',
    async (balance) => {
      const { service } = buildPrisma(api);
      captureFetch({ ok: true, body: { balance } });
      expect(
        await service.execute('client', 'agent', 'lookup', { cpf: '123' }),
      ).toEqual({ ok: true, status: 200, balance });
    },
  );

  it('keeps field fallbacks and partially populated mappings valid', async () => {
    const { service } = buildPrisma({
      ...api,
      extract_data: {
        balance: { path: 'missing', fallback: 0, fallback_type: 'number' },
        absent: 'other_missing',
      },
    });
    captureFetch({ ok: true, body: {} });
    const result = await service.execute('client', 'agent', 'lookup', {
      cpf: '123',
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: true,
      status: 200,
      balance: 0,
    });
  });

  it('uses the fallback for empty responses without mappings, excluding chaining metadata', async () => {
    const { service } = buildPrisma({
      ...api,
      extract_data: {
        _fallback_message: 'Nenhum dado',
        _chaining: { rules: [] },
      },
    });
    captureFetch({ ok: true, body: {} });
    expect(
      await service.execute('client', 'agent', 'lookup', { cpf: '123' }),
    ).toMatchObject({ ok: false, message: 'Nenhum dado' });
  });

  it('captures resolved request and full response without changing the model-visible result', async () => {
    const { service } = buildPrisma(api);
    const requests = captureFetch({
      ok: true,
      body: { balance: 10, private_business_field: 'webhook-only' },
    });
    const audit: HttpToolAudit[] = [];
    const args = { cpf: '123' };
    const state = { amount: 25 };
    const ordinary = await service.execute(
      'client',
      'agent',
      'lookup',
      args,
      state,
    );
    const audited = await service.execute(
      'client',
      'agent',
      'lookup',
      args,
      state,
      undefined,
      audit,
    );
    expect(audited).toEqual(ordinary);
    expect(audited).toEqual({ ok: true, status: 200, balance: 10 });
    expect(JSON.stringify(audited)).not.toContain('webhook-only');
    expect(audit[0].request).toMatchObject({
      method: 'POST',
      url: 'https://example.com/customer/123',
      body: JSON.parse(requests[1].init.body as string),
    });
    expect(audit[0].response?.body).toEqual({
      balance: 10,
      private_business_field: 'webhook-only',
    });
    expect(audit[0].extracted_variables).toEqual({ balance: 10 });
    expect(JSON.stringify(audit)).not.toContain('test-audit-credential');
    expect(state).toMatchObject({ amount: 25, balance: 10 });
  });

  it('keeps error bodies in audit while the model receives the existing fallback', async () => {
    const { service } = buildPrisma(api);
    captureFetch({
      ok: false,
      status: 422,
      body: { validation_details: 'customer field rejected' },
    });
    const audit: HttpToolAudit[] = [];
    const result = await service.execute(
      'client',
      'agent',
      'lookup',
      { cpf: '123' },
      {},
      undefined,
      audit,
    );
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify(result)).not.toContain('validation_details');
    expect(audit[0].response).toMatchObject({
      status: 422,
      body: { validation_details: 'customer field rejected' },
    });
  });

  it('records timeout without exposing exception details', async () => {
    const { service } = buildPrisma(api);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(
        new DOMException('network private error', 'AbortError'),
      );
    const audit: HttpToolAudit[] = [];
    await service.execute(
      'client',
      'agent',
      'lookup',
      { cpf: '123' },
      {},
      undefined,
      audit,
    );
    expect(audit[0]).toMatchObject({ response: null, error: 'timeout' });
  });

  it('records every chained HTTP execution with a parent ID even when a child fails', async () => {
    const child = {
      ...api,
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Child',
      url: 'https://example.com/child',
      extract_data: { balance: 'balance', _fallback_message: 'Falha filha' },
    };
    const { service, prisma } = buildPrisma(api);
    prisma.painel_apis.findMany.mockResolvedValue([api, child]);
    prisma.painel_apis.findFirst.mockResolvedValue(child as any);
    mockedResolveChainedApiId
      .mockReturnValueOnce(child.id)
      .mockReturnValue(undefined);
    captureFetch({
      ok: true,
      body: { balance: 10, raw_extra: 'full-response' },
    });
    jest
      .mocked(global.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ balance: 10, raw_extra: 'full-response' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'child-rejected' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const audit: HttpToolAudit[] = [];
    const result = await service.execute(
      'client',
      'agent',
      'lookup',
      { cpf: '123' },
      {},
      undefined,
      audit,
    );
    expect(audit).toHaveLength(2);
    expect(audit[1].parent_id).toBe(audit[0].id);
    expect(audit[1].response).toMatchObject({
      status: 422,
      body: { detail: 'child-rejected' },
    });
    expect(audit[1].request.url).toBe('https://example.com/child');
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: 'Falha filha',
    });
    expect((result as any)._chainTrail).toEqual([
      expect.objectContaining({
        from: 'Lookup',
        to: 'Child',
        response: { ok: false, status: 422, message: 'Falha filha' },
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('full-response');
  });

  it.each(['empty', 'timeout', 'nested-empty'])(
    'propagates chained %s failures with a flat trace and webhook-only raw audit',
    async (failure) => {
      const child = {
        ...api,
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Child',
        url: 'https://example.com/child',
        extract_data: {
          balance: 'balance',
          _fallback_message: 'Fallback filha',
        },
      };
      const grandchild = {
        ...child,
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Grandchild',
        extract_data: {
          balance: 'balance',
          _fallback_message: 'Fallback neta',
        },
      };
      const { service, prisma } = buildPrisma(api);
      prisma.painel_apis.findMany.mockResolvedValue([api, child, grandchild]);
      prisma.painel_apis.findFirst.mockResolvedValueOnce(child as any);
      mockedResolveChainedApiId.mockReturnValueOnce(child.id);
      const jsonResponse = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValueOnce(jsonResponse({ balance: 10 }));
      if (failure === 'nested-empty') {
        prisma.painel_apis.findFirst.mockResolvedValueOnce(grandchild as any);
        mockedResolveChainedApiId.mockReturnValueOnce(grandchild.id);
        fetchMock.mockResolvedValueOnce(jsonResponse({ balance: 20 }));
      }
      if (failure === 'timeout') {
        fetchMock.mockRejectedValueOnce(
          new DOMException('Timed out', 'AbortError'),
        );
      } else {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({ private_raw: 'not mapped' }),
        );
      }
      const audit: HttpToolAudit[] = [];
      const result = await service.execute(
        'client',
        'agent',
        'lookup',
        { cpf: '123' },
        {},
        undefined,
        audit,
      );
      const count = failure === 'nested-empty' ? 3 : 2;
      const fallback =
        failure === 'nested-empty' ? 'Fallback neta' : 'Fallback filha';
      expect(result).toMatchObject({ ok: false, message: fallback });
      if (failure !== 'timeout')
        expect(result).toMatchObject({
          status: 200,
          error: 'extraction_empty',
        });
      expect(fetchMock).toHaveBeenCalledTimes(count);
      expect(mockedResolveChainedApiId).toHaveBeenCalledTimes(count - 1);
      expect(audit).toHaveLength(count);
      expect(audit[1].parent_id).toBe(audit[0].id);
      if (count === 3) expect(audit[2].parent_id).toBe(audit[1].id);
      const trail = (result as any)._chainTrail;
      expect(trail.map((step: any) => step.to)).toEqual(
        count === 3 ? ['Child', 'Grandchild'] : ['Child'],
      );
      for (const step of trail) {
        expect(step.response).toMatchObject({ ok: false, message: fallback });
        expect(step.response).not.toHaveProperty('_chainTrail');
        expect(step.arguments.cpf).toBe('123');
      }
      expect(result).not.toHaveProperty('tem_ofertas');
      expect(JSON.stringify(result)).not.toContain('private_raw');
      if (failure !== 'timeout')
        expect(audit[count - 1].response?.body).toEqual({
          private_raw: 'not mapped',
        });
    },
  );
});

describe('VoiceToolsService - encadeamento (tenant scope & cycle guard)', () => {
  const apiId = '11111111-1111-1111-1111-111111111111';
  const agentId = '22222222-2222-2222-2222-222222222222';

  it('filtra a API encadeada por client_id (sem execução cross-tenant)', async () => {
    mockedResolveChainedApiId.mockReturnValue('next-api');
    const { service, prisma } = buildPrisma({
      id: apiId,
      name: 'Consulta',
      method: 'GET',
      url: 'https://api.example.com/step1',
      extract_data: null,
    });
    prisma.painel_apis.findFirst.mockResolvedValue(null);
    captureFetch({ ok: true, body: { found: true } });

    await service.execute(
      'client-1',
      agentId,
      `consulta_${apiId.replace(/-/g, '_')}`,
      {},
      {},
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

  it('aborta cadeia em ciclo (next_api_id já visitado) sem consultar DB', async () => {
    mockedResolveChainedApiId.mockReturnValue(apiId);
    const { service, prisma } = buildPrisma({
      id: apiId,
      name: 'Consulta',
      method: 'GET',
      url: 'https://api.example.com/self',
      extract_data: null,
    });
    captureFetch({ ok: true, body: { found: true } });

    const result = await service.execute(
      'client-1',
      agentId,
      `consulta_${apiId.replace(/-/g, '_')}`,
      {},
      {},
    );

    expect(result.ok).toBe(true);
    expect(prisma.painel_apis.findFirst).not.toHaveBeenCalled();
  });

  it('permite encadeamento legítimo entre APIs distintas', async () => {
    mockedResolveChainedApiId.mockReturnValue('next-api');
    const nextRecord = {
      id: 'next-api',
      name: 'Passo 2',
      method: 'GET',
      url: 'https://api.example.com/step2',
      headers: null,
      body: null,
      parameters: null,
      extract_data: null,
    };
    const prisma = {
      painel_agents: {
        findFirst: jest.fn().mockResolvedValue({ allowed_tool_names: [] }),
      },
      painel_apis: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: apiId,
            name: 'Passo 1',
            method: 'GET',
            url: 'https://api.example.com/step1',
            extract_data: null,
          },
          nextRecord,
        ]),
        findFirst: jest.fn().mockResolvedValue(nextRecord),
      },
      painel_subagents: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new VoiceToolsService(
      prisma as any,
      {} as any,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    const requests = captureFetch({ ok: true, body: { step: 1 } });

    const result = await service.execute(
      'client-1',
      agentId,
      `passo_1_${apiId.replace(/-/g, '_')}`,
      {},
      {},
    );

    expect(prisma.painel_apis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ client_id: 'client-1' }),
      }),
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(true);
  });
});

describe('VoiceToolsService - resolução de payload (source system/sessão)', () => {
  const apiId = '11111111-1111-1111-1111-111111111111';
  const agentId = '22222222-2222-2222-2222-222222222222';

  const buildService = (apiRecord: Record<string, unknown>) =>
    buildPrisma(apiRecord).service;

  const captureFetch = (
    respond: { ok: boolean; status?: number; body?: unknown } = {
      ok: true,
      body: { accepted: true },
    },
  ) => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url: any, init: RequestInit = {}) => {
        requests.push({ url: String(url), init });
        return {
          ok: respond.ok,
          status: respond.status ?? 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => respond.body ?? {},
          text: async () => JSON.stringify(respond.body ?? {}),
        } as unknown as Response;
      });
    return requests;
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('deve resolver campo source=system a partir do estado da sessão', async () => {
    const service = buildService({
      id: apiId,
      name: 'Gerar Acordo',
      method: 'POST',
      url: 'https://api.example.com/acordos',
      body: {
        codigo_plano: {
          type: 'string',
          source: 'ai',
          value: 'Código do plano',
        },
        cpf: { type: 'string', source: 'system', value: 'cpf' },
      },
    });

    const requests = captureFetch();
    const result = await service.execute(
      'client-1',
      agentId,
      `gerar_acordo_${apiId.replace(/-/g, '_')}`,
      { codigo_plano: 'NEG-004' },
      { cpf: '08334993942', nome: 'João da Silva' },
    );

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      codigo_plano: 'NEG-004',
      cpf: '08334993942',
    });
  });

  it('não deve usar alias quando a variável configurada não existe', async () => {
    const service = buildService({
      id: apiId,
      name: 'Gerar Acordo',
      method: 'POST',
      url: 'https://api.example.com/acordos',
      body: {
        cpf: { type: 'string', source: 'system', value: 'cpf' },
      },
    });

    const requests = captureFetch();
    const result = await service.execute(
      'client-1',
      agentId,
      `gerar_acordo_${apiId.replace(/-/g, '_')}`,
      {},
      { cliente_cpf: '08334993942' },
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({});
  });

  it('NÃO deve enviar o nome da variável literal quando nada é resolvido', async () => {
    const service = buildService({
      id: apiId,
      name: 'Gerar Acordo',
      method: 'POST',
      url: 'https://api.example.com/acordos',
      body: {
        cpf: { type: 'string', source: 'system', value: 'cpf' },
      },
    });

    const requests = captureFetch();
    await service.execute(
      'client-1',
      agentId,
      `gerar_acordo_${apiId.replace(/-/g, '_')}`,
      { codigo_plano: 'NEG-004' },
      {},
    );

    const sentBody = JSON.parse(String(requests[0].init.body));
    expect(sentBody).not.toHaveProperty('cpf');
    expect(Object.values(sentBody)).not.toContain('cpf');
  });

  it('não deve usar argumentos da IA para campos da sessão', async () => {
    const service = buildService({
      id: apiId,
      name: 'Gerar Acordo',
      method: 'POST',
      url: 'https://api.example.com/acordos',
      body: {
        cpf: { type: 'string', source: 'system', value: 'cpf' },
      },
    });

    const requests = captureFetch();
    await service.execute(
      'client-1',
      agentId,
      `gerar_acordo_${apiId.replace(/-/g, '_')}`,
      { cpf: '08334993942' },
      { outro_dado: 'x' },
    );

    expect(JSON.parse(String(requests[0].init.body))).toEqual({});
  });

  it('deve resolver parâmetro de URL a partir da sessão quando ausente nos argumentos', async () => {
    const service = buildService({
      id: apiId,
      name: 'Consulta CPF',
      method: 'GET',
      url: 'https://api.example.com/clientes/{cpf}',
      body: {},
    });

    const requests = captureFetch({
      ok: true,
      body: { nome: 'João da Silva' },
    });
    const result = await service.execute(
      'client-1',
      agentId,
      `consulta_cpf_${apiId.replace(/-/g, '_')}`,
      {},
      { cpf: '08334993942' },
    );

    expect(result.ok).toBe(true);
    expect(requests[0].url).toBe(
      'https://api.example.com/clientes/08334993942',
    );
  });

  it('deve manter comportamento do campo source=ai preenchido pela IA', async () => {
    const service = buildService({
      id: apiId,
      name: 'Gerar Acordo',
      method: 'POST',
      url: 'https://api.example.com/acordos',
      body: {
        codigo_plano: {
          type: 'string',
          source: 'ai',
          value: 'Código do plano',
        },
      },
    });

    const requests = captureFetch();
    await service.execute(
      'client-1',
      agentId,
      `gerar_acordo_${apiId.replace(/-/g, '_')}`,
      { codigo_plano: 'NEG-004' },
    );

    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      codigo_plano: 'NEG-004',
    });
  });
});

describe('VoiceToolsService - cache Redis por (clientId, agentId)', () => {
  const agentId = '22222222-2222-2222-2222-222222222222';

  it('cacheia getAgentTools com TTL 30s e evita segunda consulta ao DB', async () => {
    const { service, prisma, redis } = buildPrisma({
      id: 'api-1',
      name: 'Consulta',
      method: 'GET',
      url: 'https://api.example.com/x',
      extract_data: null,
    });
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ id: 'api-1', name: 'consulta' }]);

    await service.getAgentTools('client-1', agentId);
    await service.getAgentTools('client-1', agentId);

    expect(prisma.painel_agents.findFirst).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      `voice:tools:client-1:${agentId}`,
      expect.any(Array),
      30,
    );
  });

  it('serve getAgentTools a partir do cache quando disponível', async () => {
    const { service, prisma } = buildPrisma({
      id: 'api-1',
      name: 'Consulta',
      method: 'GET',
      url: 'https://api.example.com/x',
      extract_data: null,
    });
    const cachedTool = {
      id: 'api-1',
      apiName: 'Consulta',
      name: 'consulta_cacheada',
      description: 'cached',
      parameters: {},
    };

    (service as any).redis.get.mockResolvedValueOnce([cachedTool]);

    const tools = await service.getAgentTools('client-1', agentId);

    expect(tools).toEqual([cachedTool]);
    expect(prisma.painel_agents.findFirst).not.toHaveBeenCalled();
  });

  it('rejeita ferramentas com URLs relativas ou esquema inválido', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    const { service } = buildPrisma({
      id,
      name: 'Relativa',
      method: 'GET',
      url: '/internal/endpoint',
      extract_data: null,
    });

    const result = await service.execute(
      'client-1',
      agentId,
      `relativa_${id.replace(/-/g, '_')}`,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('URL da ferramenta inválida');
  });

  it('rejeita ferramentas quando validateWebhookUrl bloqueia por SSRF', async () => {
    mockedValidateWebhookUrl.mockRejectedValueOnce(
      new Error('Access to private/internal IP is not allowed'),
    );
    const id = '44444444-4444-4444-4444-444444444444';
    const { service } = buildPrisma({
      id,
      name: 'Bloqueada',
      method: 'GET',
      url: 'http://169.254.169.254/latest/meta-data',
      extract_data: null,
    });

    const result = await service.execute(
      'client-1',
      agentId,
      `bloqueada_${id.replace(/-/g, '_')}`,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('URL bloqueada por segurança (SSRF)');
  });

  it('delega subagente enviando x-goog-api-key no header (sem chave na URL)', async () => {
    const { service, prisma } = buildPrisma({});
    prisma.painel_agents.findFirst.mockResolvedValue({
      transitions: { allowed_subagents: ['especialista'] },
    });
    prisma.painel_subagents.findMany.mockResolvedValue([
      {
        id: '55555555-5555-5555-5555-555555555555',
        name: 'especialista',
        model: 'gemini-2.5-flash-lite',
        system_prompt: 'Você é um assistente.',
        temperature: 0.5,
      },
    ]);
    (service as any).providerKeyResolver = {
      resolveApiKey: jest.fn().mockResolvedValue('secret-gemini-key'),
    };
    const requests = captureFetch({ ok: true, body: { candidates: [] } });

    await service.executeSubagent(
      'client-1',
      agentId,
      'subagent_especialista',
      { task: 'Resumir fatura' },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).not.toContain('key=');
    expect((requests[0].init.headers as any)['x-goog-api-key']).toBe(
      'secret-gemini-key',
    );
  });

  describe('applyExtractData com regras compostas e caminhos dinâmicos', () => {
    const { service } = buildPrisma({});
    const rawPayload = {
      cliente: { nome: 'Ana Lima', status: 'ativo' },
      contrato: { dias_atraso: 40, valor_devido: 1200, valor_original: 1000 },
    };

    it('avalia regras com logic AND/OR e retorno dinâmico de caminho', () => {
      const mapping = {
        valor_cobranca: {
          path: 'contrato.dias_atraso',
          rules: [
            {
              operator: '==',
              compare_value: '',
              return_value: 'contrato.valor_devido',
              return_type: 'path',
              logic: 'and',
              conditions: [
                {
                  path: 'contrato.dias_atraso',
                  operator: '>',
                  compare_value: '30',
                },
                {
                  path: 'cliente.status',
                  operator: '==',
                  compare_value: 'ativo',
                },
              ],
            },
          ],
          fallback: 'contrato.valor_original',
          fallback_type: 'path',
        },
      };

      const res = (service as any).applyExtractData(rawPayload, mapping);
      expect(res.valor_cobranca).toBe(1200);
    });

    it('retorna string "true" e não booleano true quando return_type é string', () => {
      const mapping = {
        status_string: {
          path: 'contrato.valor_devido',
          rules: [
            {
              operator: '>',
              compare_value: '0',
              return_value: 'true',
              return_type: 'string',
            },
          ],
        },
        fallback_string: {
          path: 'contrato.campo_nulo',
          fallback: 'false',
          fallback_type: 'string',
        },
      };

      const res = (service as any).applyExtractData(rawPayload, mapping);
      expect(typeof res.status_string).toBe('string');
      expect(res.status_string).toBe('true');
      expect(typeof res.fallback_string).toBe('string');
      expect(res.fallback_string).toBe('false');
    });
  });
});

describe('explicit extraction parity', () => {
  it('preserves casing, nested paths, array projection and modifiers', () => {
    const service = new VoiceToolsService({} as any, {} as any, {} as any);
    const result = (service as any).applyExtractData(
      {
        person: { name: ' Nome completo ' },
        items: [{ value: 10 }, { value: 20 }],
        confirmed: false,
      },
      {
        '{{Pessoa}}': {
          path: 'person.name',
          modifier: 'trim',
        },
        Valores: { path: 'items[*].value', max_items: 1 },
        Confirmou: { path: 'confirmed' },
      },
    );
    expect(result).toEqual({
      Pessoa: 'Nome completo',
      Valores: [10],
      Confirmou: false,
    });
  });
});
