import { VoiceToolsService } from './voice-tools.service';

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
    captureFetch({ ok: true, body: {} });

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
    captureFetch({ ok: true, body: {} });

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

  it('deve resolver cpf da sessão mesmo quando salva como cliente_cpf (alias)', async () => {
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
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      cpf: '08334993942',
    });
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

  it('deve usar fallback dos argumentos da IA quando a sessão não tem a variável', async () => {
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

    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      cpf: '08334993942',
    });
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
  });
});
