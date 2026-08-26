import { WorkerHealthService } from './worker-health.service';

describe('WorkerHealthService', () => {
  it('publishes a per-process heartbeat with a short TTL', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const configService = {
      get: jest.fn().mockReturnValue('worker-agent'),
    };
    const redisService = { set };
    const service = new WorkerHealthService(
      configService as any,
      redisService as any,
    );

    service.onModuleInit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.onModuleDestroy();

    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^runtime:worker:worker-agent:\d+:heartbeat$/),
      expect.objectContaining({ role: 'worker-agent', pid: process.pid }),
      30,
    );
  });
});
