import { WebhooksService } from './services/webhooks.service';

jest.mock('../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
}));

describe('WebhooksService - processRetry claim atômico', () => {
  const build = (overrides: Partial<Record<string, unknown>> = {}) => {
    const prisma = {
      webhook_deliveries: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'delivery-new' }),
      },
      webhook_endpoints: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };
    const configService = {
      get: jest.fn().mockReturnValue('development'),
    };
    const queueService = { addWebhookJob: jest.fn() };
    const service = new WebhooksService(
      prisma as never,
      configService as never,
      queueService as never,
    );
    return { prisma, queueService, service };
  };

  const delivery = {
    id: 'delivery-1',
    webhook_endpoint_id: 'endpoint-1',
    attempt: 1,
    max_attempts: 3,
    status: 'pending',
    next_retry_at: null,
    payload: { event: 'message.completed', conversation_id: 'conv-1' },
    webhook_endpoints: {
      url: 'https://cliente.example.com/hook',
      secret_hash: 'secret',
    },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    global.fetch = jest.fn() as never;
  });

  it('reivindica o delivery com transição pending→processing antes de enviar', async () => {
    const { prisma, service } = build();
    prisma.webhook_deliveries.findUnique.mockResolvedValue(delivery);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    });

    await service.processRetry('delivery-1');

    expect(prisma.webhook_deliveries.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'pending' },
      data: { status: 'processing' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(prisma.webhook_deliveries.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-1' },
        data: expect.objectContaining({ status: 'delivered' }),
      }),
    );
  });

  it('ignora o envio quando outro worker já reivindicou o delivery', async () => {
    const { prisma, service } = build();
    prisma.webhook_deliveries.findUnique.mockResolvedValue(delivery);
    prisma.webhook_deliveries.updateMany.mockResolvedValue({ count: 0 });

    await service.processRetry('delivery-1');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.webhook_deliveries.update).not.toHaveBeenCalled();
  });

  it('não envia quando o delivery não está pendente', async () => {
    const { prisma, service } = build();
    prisma.webhook_deliveries.findUnique.mockResolvedValue({
      ...delivery,
      status: 'delivered',
    });

    await service.processRetry('delivery-1');

    expect(prisma.webhook_deliveries.updateMany).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('agenda próxima tentativa e marca failed quando o envio falha', async () => {
    const { prisma, queueService, service } = build();
    prisma.webhook_deliveries.findUnique.mockResolvedValue(delivery);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'err',
    });

    await service.processRetry('delivery-1');

    expect(prisma.webhook_deliveries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempt: 2, status: 'pending' }),
      }),
    );
    expect(queueService.addWebhookJob).toHaveBeenCalled();
    expect(prisma.webhook_deliveries.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
