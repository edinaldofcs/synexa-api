import { RedisService } from './redis.service';

const client = {
  set: jest.fn(),
  eval: jest.fn(),
  ping: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
};

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => client),
  };
});

describe('RedisService distributed locks', () => {
  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    const { ConfigService } =
      require('@nestjs/config') as typeof import('@nestjs/config');
    service = new RedisService(new ConfigService());
  });

  it('stores an owner token when acquiring the lock', async () => {
    client.set.mockResolvedValueOnce('OK');

    await expect(service.acquireLock('lock:x', 30)).resolves.toBe(true);

    expect(client.set).toHaveBeenCalledWith(
      'lock:x',
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
  });

  it('does not store a token when the lock is taken', async () => {
    client.set.mockResolvedValueOnce(null);

    await expect(service.acquireLock('lock:y', 30)).resolves.toBe(false);
    await expect(service.releaseLock('lock:y')).resolves.toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('releases only if the stored token still owns the lock', async () => {
    client.set.mockResolvedValueOnce('OK');
    await service.acquireLock('lock:z', 15);
    const token = client.set.mock.calls[0][1];

    client.eval.mockResolvedValueOnce(1);
    await expect(service.releaseLock('lock:z')).resolves.toBe(true);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:z',
      token,
    );

    // Second release must be a no-op without touching Redis again.
    client.eval.mockClear();
    await expect(service.releaseLock('lock:z')).resolves.toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('keeps the lock when another owner holds it during release', async () => {
    client.set.mockResolvedValueOnce('OK');
    await service.acquireLock('lock:w', 5);

    client.eval.mockResolvedValueOnce(0);
    await expect(service.releaseLock('lock:w')).resolves.toBe(false);
  });

  it('renews the TTL only for the current owner', async () => {
    client.set.mockResolvedValueOnce('OK');
    await service.acquireLock('lock:r', 30);
    const token = client.set.mock.calls[0][1];

    client.eval.mockResolvedValueOnce(1);
    await expect(service.renewLock('lock:r', 30)).resolves.toBe(true);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:r',
      token,
      30_000,
    );

    client.eval.mockClear();
    await expect(service.renewLock('lock:unknown', 30)).resolves.toBe(false);
    expect(client.eval).not.toHaveBeenCalled();
  });
});
