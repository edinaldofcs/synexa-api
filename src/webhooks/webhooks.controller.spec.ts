import { WebhooksController } from './webhooks.controller';
import { UnauthorizedException } from '@nestjs/common';

it('returns tenant-scoped receipts without encrypted payloads or secrets', async () => {
  const prisma = {
    call_exports: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const controller = new WebhooksController(prisma as any);
  await controller.listCallExports(
    { id: 'user', company_id: 'company' },
    'client',
  );
  const query = prisma.call_exports.findMany.mock.calls[0][0];
  expect(query.where).toEqual({ company_id: 'company', client_id: 'client' });
  expect(query.take).toBe(100);
  expect(query.select).not.toHaveProperty('payload_enc');
  expect(query.select).not.toHaveProperty('destination_enc');
});
it('refuses listing without a company scope', async () => {
  const prisma = { call_exports: { findMany: jest.fn() } };
  await expect(
    new WebhooksController(prisma as any).listCallExports({ id: 'user' }),
  ).rejects.toBeInstanceOf(UnauthorizedException);
  expect(prisma.call_exports.findMany).not.toHaveBeenCalled();
});
it('preserves the export policy on a partial enabled update', async () => {
  const policy = {
    retention_hours: 12,
    include_transcript: true,
    max_retries: 5,
  };
  const prisma = {
    webhook_endpoints: {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          id: 'endpoint',
          client_id: 'client',
          events: ['message.sent'],
          url: 'https://example.com',
          enabled: true,
          retry_policy: policy,
        }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  await new WebhooksController(prisma as any).updateEndpoint(
    { id: 'user', company_id: 'company' },
    'endpoint',
    { enabled: false },
  );
  expect(
    prisma.webhook_endpoints.update.mock.calls[0][0].data.retry_policy,
  ).toEqual(policy);
});
