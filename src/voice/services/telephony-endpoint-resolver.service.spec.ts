import { TelephonyEndpointResolverService } from './telephony-endpoint-resolver.service';

const endpointRow = {
  id: 'ep-1',
  company_id: 'company-1',
  client_id: 'client-1',
  provider: 'asterisk_fastagi',
  did_number: '08001234567',
  audio_format: 'g711_ulaw',
  agent_step: null,
  enabled: true,
};

const clientRow = {
  id: 'client-1',
  company_id: 'company-1',
  voice_name: 'Kore',
};

const agentRow = { id: 'agent-1', client_id: 'client-1' };

function makeService(overrides?: {
  endpoints?: any[];
  clients?: Record<string, any>;
}) {
  const db = {
    telephony_endpoints: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides?.endpoints?.length ? overrides.endpoints[0] : endpointRow,
        ),
      findMany: jest
        .fn()
        .mockResolvedValue(overrides?.endpoints ?? [endpointRow]),
    },
    painel_clients: {
      findUnique: jest.fn(
        async ({ where }: any) => overrides?.clients?.[where.id] ?? clientRow,
      ),
      findFirst: jest.fn().mockResolvedValue(clientRow),
    },
    painel_agents: {
      findFirst: jest.fn().mockResolvedValue(agentRow),
    },
  };
  const cache = new Map<string, string>();
  const redis = {
    // Espelha o contrato real do RedisService (JSON serializado)
    get: jest.fn(async (k: string) =>
      cache.has(k) ? JSON.parse(cache.get(k)!) : null,
    ),
    set: jest.fn(
      async (k: string, v: unknown) => void cache.set(k, JSON.stringify(v)),
    ),
    del: jest.fn(async () => {}),
  };

  const service = new TelephonyEndpointResolverService(db as any, redis as any);
  return { service, db, redis, cache };
}

describe('TelephonyEndpointResolverService', () => {
  it('rotaciona DID -> empresa/cliente/agente via telephony_endpoints', async () => {
    const { service, db } = makeService();

    const route = await service.resolve({
      didNumber: '08001234567',
      providerName: 'asterisk_fastagi',
    });

    expect(db.telephony_endpoints.findFirst).toHaveBeenCalled();
    expect(route).not.toBeNull();
    expect(route!.company_id).toBe('company-1');
    expect(route!.client_id).toBe('client-1');
    expect(route!.agent?.id).toBe('agent-1');
  });

  it('recusa chamada sem rota e sem hint (anti cross-tenant)', async () => {
    const { service, db } = makeService({
      endpoints: [{ ...endpointRow, enabled: true }],
    });
    // DID que não bate com nenhum endpoint:
    (db.telephony_endpoints.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const route = await service.resolve({ didNumber: '11999900000' });

    expect(route).toBeNull();
    expect(db.painel_clients.findUnique).not.toHaveBeenCalled();
  });

  it('hint legado SYNEXA_CLIENT_ID tem precedência', async () => {
    const legacyClient = { ...clientRow, id: 'client-legacy' };
    const { service, db } = makeService();
    (db.telephony_endpoints.findFirst as jest.Mock).mockResolvedValue(null); // sem match por DID
    (db.painel_clients.findUnique as jest.Mock).mockResolvedValue(legacyClient);

    const route = await service.resolve({
      clientIdHint: 'client-legacy',
    });

    expect(route!.client_id).toBe('client-legacy');
    expect(route!.provider).toBe('legacy_variables');
  });

  it('usa cache Redis entre chamadas repetidas', async () => {
    const { service, db, redis } = makeService();

    await service.resolve({ didNumber: '08001234567' });
    await service.resolve({ didNumber: '08001234567' });

    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(db.telephony_endpoints.findFirst).toHaveBeenCalledTimes(1);
  });

  it('resolve rota pelo hash do segredo (ingresso WS de discador)', async () => {
    const { service, db } = makeService();

    const route = await service.resolveBySecretHash('hash-token');

    expect(db.telephony_endpoints.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inbound_secret_hash: 'hash-token', enabled: true },
      }),
    );
    expect(route!.client_id).toBe('client-1');
  });
});
