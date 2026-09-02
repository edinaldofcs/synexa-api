import { OperatorPresenceService } from './operator-presence.service';

describe('OperatorPresenceService - SCAN de presença e TTL do last_seen', () => {
  const build = () => {
    const client = {
      keys: jest.fn(),
      scan: jest
        .fn()
        .mockResolvedValue(['0', ['operator:presence:company-1:op-1']]),
      mget: jest
        .fn()
        .mockResolvedValue([
          '{"status":"available"}',
          '{"status":"available"}',
        ]),
      get: jest.fn().mockResolvedValue('1700000000000'),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn(() => {
        const pipe: Record<string, jest.Mock> = {} as never;
        pipe.set = jest.fn().mockReturnValue(pipe);
        pipe.exec = jest.fn().mockResolvedValue([]);
        return pipe;
      }),
    };
    const redisService = { getClient: jest.fn(() => client) };
    const service = new OperatorPresenceService(redisService as never);
    return { client, service };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('listAvailable usa SCAN (cursor) em vez de KEYS', async () => {
    const { client, service } = build();
    client.scan
      .mockResolvedValueOnce(['5', ['operator:presence:company-1:op-1']])
      .mockResolvedValueOnce(['0', ['operator:presence:company-1:op-2']]);

    const available = await service.listAvailable('company-1');

    expect(client.keys).not.toHaveBeenCalled();
    expect(client.scan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'operator:presence:company-1:*',
      'COUNT',
      100,
    );
    expect(client.scan).toHaveBeenNthCalledWith(
      2,
      '5',
      'MATCH',
      'operator:presence:company-1:*',
      'COUNT',
      100,
    );
    expect(available).toEqual(['op-1', 'op-2']);
  });

  it('listOnline e listOnlineWithStatus também usam SCAN', async () => {
    const { client, service } = build();

    await service.listOnline('company-1');
    await service.listOnlineWithStatus('company-1');

    expect(client.keys).not.toHaveBeenCalled();
    expect(client.scan).toHaveBeenCalledTimes(2);
  });

  it('heartbeat grava last_seen com TTL de 7 dias', async () => {
    const { client, service } = build();

    await service.heartbeat('op-1', 'company-1');

    const pipe = client.pipeline.mock.results[0].value;
    expect(pipe.set).toHaveBeenCalledWith(
      'operator:last_seen:op-1',
      expect.any(String),
      'EX',
      604800,
    );
    expect(pipe.set).toHaveBeenCalledWith(
      'operator:presence:company-1:op-1',
      expect.any(String),
      'EX',
      35,
    );
  });
});
