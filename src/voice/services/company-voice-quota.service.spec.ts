import { CompanyVoiceQuotaService } from './company-voice-quota.service';

describe('CompanyVoiceQuotaService', () => {
  let service: CompanyVoiceQuotaService;
  let client: any;
  let prisma: any;
  beforeEach(() => {
    jest.useFakeTimers();
    client = {
      on: jest.fn(),
      eval: jest.fn().mockResolvedValue(0),
      disconnect: jest.fn(),
    };
    prisma = {
      companies: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'active', max_concurrent_calls: 5 }),
      },
    };
    service = new CompanyVoiceQuotaService(
      prisma,
      { getClient: () => ({ duplicate: () => client }) } as any,
      { get: () => 50 } as any,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it.each([undefined, 'suspended'])(
    'fails closed for an unknown or inactive company: %s',
    async (status) => {
      prisma.companies.findUnique.mockResolvedValue(status ? { status } : null);
      await expect(service.acquire('company', jest.fn())).rejects.toThrow(
        'indisponível',
      );
      expect(client.eval).not.toHaveBeenCalled();
    },
  );
  it('rejects calls without trusted company scope', async () => {
    await expect(service.acquire(undefined, jest.fn())).rejects.toThrow(
      'identificada',
    );
    expect(prisma.companies.findUnique).not.toHaveBeenCalled();
  });
  it.each([
    [1, 'servidor'],
    [2, 'empresa'],
  ])(
    'rejects capacity exhaustion without a live timer: %s',
    async (code, scope) => {
      client.eval.mockResolvedValue(code);
      await expect(service.acquire('company', jest.fn())).rejects.toThrow(
        String(scope),
      );
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it('fails closed when Redis is unavailable', async () => {
    client.eval.mockRejectedValue(new Error('offline'));
    await expect(service.acquire('company', jest.fn())).rejects.toThrow(
      'indisponível',
    );
  });
  it('releases both company and global capacity only once and clears timers', async () => {
    const lease = await service.acquire('company', jest.fn());
    await lease.release();
    await lease.release();
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('stops the call on renewal failure before the slot can expire', async () => {
    const stop = jest.fn();
    await service.acquire('company', stop);
    client.eval.mockRejectedValueOnce(new Error('offline'));
    await jest.advanceTimersByTimeAsync(10000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not renew a released call and keeps an active call reserved', async () => {
    const stop = jest.fn();
    const lease = await service.acquire('company', stop);
    client.eval.mockResolvedValue(1);
    await jest.advanceTimersByTimeAsync(70000);
    expect(stop).not.toHaveBeenCalled();
    await lease.release();
    const count = client.eval.mock.calls.length;
    await jest.advanceTimersByTimeAsync(70000);
    expect(client.eval).toHaveBeenCalledTimes(count);
  });
});
