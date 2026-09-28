jest.mock('../common/utils/public-http', () => ({
  publicFetch: (...args: any[]) => (global.fetch as any)(...args),
}));
jest.mock('../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn(),
}));
import { createHmac } from 'crypto';
import { WebhooksService } from './services/webhooks.service';
import { sealWebhookSecret } from './services/webhook-secret';

describe('Durable message webhook delivery', () => {
  const build = (overrides: Record<string, any> = {}) => {
    process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-not-a-real-secret';
    const row: any = {
      id: 'event',
      status: 'pending',
      attempt: 1,
      max_attempts: 3,
      payload: {
        event: 'message.completed',
        variables: { CPF: '0012', flag: false, count: 0 },
      },
      webhook_endpoints: {
        url: 'https://example.test/webhook',
        signing_secret_enc: sealWebhookSecret('test-signature'),
      },
      ...overrides,
    };
    const prisma: any = {
      webhook_deliveries: {
        findUnique: jest.fn(async () => ({ ...row })),
        findMany: jest.fn(async () => [{ id: row.id }]),
        updateMany: jest.fn(async ({ where, data }) => {
          if (where.lease_token && where.lease_token !== row.lease_token)
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const queue = { addWebhookJob: jest.fn() };
    const service = new WebhooksService(
      prisma,
      { get: () => 'development' } as any,
      queue as any,
    );
    return { service, prisma, row, queue };
  };
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel: jest.fn() },
    });
  });
  it('signs the exact payload and uses a stable event ID', async () => {
    const { service, row } = build();
    await service.processRetry(row.id);
    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.headers['X-Synexa-Signature']).toBe(
      'sha256=' +
        createHmac('sha256', 'test-signature')
          .update(init.headers['X-Synexa-Timestamp'] + '.' + init.body)
          .digest('hex'),
    );
    expect(init.headers['X-Synexa-Event-Id']).toBe('event');
    expect(row.status).toBe('delivered');
    expect(row.lease_token).toBeNull();
  });
  it('does not send while another worker owns a valid lease', async () => {
    const { service } = build({
      status: 'processing',
      lease_until: new Date(Date.now() + 60000),
    });
    await service.processRetry('event');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('recovers abandoned processing, keeping the same event', async () => {
    const { service, row } = build({
      status: 'processing',
      lease_token: 'old',
      lease_until: new Date(0),
    });
    await service.processRetry(row.id);
    expect(row.status).toBe('delivered');
  });
  it('retains a failed delivery and schedules retry without duplicating the row', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
    const { service, row, queue } = build();
    await service.processRetry(row.id);
    expect(row).toMatchObject({
      status: 'pending',
      attempt: 2,
      error_message: 'http_503',
    });
    expect(queue.addWebhookJob).toHaveBeenCalledWith(
      { delivery_id: 'event' },
      expect.any(Number),
    );
  });
  it('ignores a lost claim', async () => {
    const { service, prisma } = build();
    prisma.webhook_deliveries.updateMany.mockResolvedValue({ count: 0 });
    await service.processRetry('event');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('reconciles pending records even when the queue lost its job', async () => {
    const { service, queue } = build();
    await service.sweep();
    expect(queue.addWebhookJob).toHaveBeenCalledWith({ delivery_id: 'event' });
  });
});
