import { VoiceToolsService } from './voice-tools.service';

describe('VoiceToolsService - resolução de payload (source system/sessão)', () => {
  const apiId = '11111111-1111-1111-1111-111111111111';
  const agentId = '22222222-2222-2222-2222-222222222222';

  const buildService = (apiRecord: Record<string, unknown>) => {
    const prisma = {
      painel_agents: {
        findFirst: jest.fn().mockResolvedValue({ allowed_tool_names: [] }),
      },
      painel_apis: {
        findMany: jest.fn().mockResolvedValue([apiRecord]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new VoiceToolsService(prisma as any, {} as any);
    return service;
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
