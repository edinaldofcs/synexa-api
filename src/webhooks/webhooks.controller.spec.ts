import { WebhooksController } from './webhooks.controller';
import { UnauthorizedException } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CallPreviewDto } from './dto/call-preview.dto';

const previewBody = {
  duration_seconds: 15,
  variables: { agreement_id: 'example' },
  transcript: [{ role: 'user' as const, text: 'Teste' }],
  tools: [{ tool_name: 'consulta', status: 'success', result: { ok: true } }],
};

describe('read-only call preview', () => {
  function setup(owned = true, includeTranscript = false) {
    const prisma = {
      painel_clients: {
        findFirst: jest.fn().mockResolvedValue(owned ? { id: 'client' } : null),
      },
      webhook_endpoints: {
        findFirst: jest.fn().mockResolvedValue({
          retry_policy: { include_transcript: includeTranscript },
        }),
      },
    };
    return { prisma, controller: new WebhooksController(prisma as any) };
  }

  it('rejects missing tenant and foreign clients before accessing the destination', async () => {
    const { prisma, controller } = setup(false);
    await expect(
      controller.previewCall({ id: 'user' }, 'client', previewBody),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.painel_clients.findFirst).not.toHaveBeenCalled();
    await expect(
      controller.previewCall(
        { id: 'user', company_id: 'company' },
        'client',
        previewBody,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.painel_clients.findFirst).toHaveBeenCalledWith({
      where: { id: 'client', company_id: 'company' },
      select: { id: true },
    });
    expect(prisma.webhook_endpoints.findFirst).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the saved transcription policy (%s) without reading secrets or sending requests',
    async (includeTranscript) => {
      const { prisma, controller } = setup(true, includeTranscript);
      const result = await controller.previewCall(
        { id: 'user', company_id: 'company' },
        'client',
        previewBody,
      );
      expect(result.payload).toMatchObject({
        schema_version: 1,
        event: 'call.completed',
        company_id: 'company',
        client_id: 'client',
        call: {
          duration_seconds: 15,
          variables: previewBody.variables,
          tools: [
            {
              tool_name: 'consulta',
              status: 'completed',
              result: { ok: true },
            },
          ],
        },
      });
      expect(result.payload.call.transcript).toEqual(
        includeTranscript
          ? [{ sender_type: 'customer', content: 'Teste', created_at: null }]
          : undefined,
      );
      expect(
        prisma.webhook_endpoints.findFirst.mock.calls[0][0].select,
      ).toEqual({ retry_policy: true });
    },
  );

  it('still provides a clearly unconfigured preview when no active destination exists', async () => {
    const { prisma, controller } = setup();
    prisma.webhook_endpoints.findFirst.mockResolvedValue(null);
    expect(
      await controller.previewCall(
        { id: 'user', company_id: 'company' },
        'client',
        previewBody,
      ),
    ).toMatchObject({
      configured: false,
      include_transcript: true,
      payload_version: 2,
      payload: {
        schema_version: 2,
        call: {
          turns: expect.arrayContaining([
            expect.objectContaining({
              messages: [expect.objectContaining({ text: 'Teste' })],
            }),
          ]),
        },
      },
    });
  });

  it('can simulate messages and v2 without changing a saved destination', async () => {
    const { controller, prisma } = setup(true, false);
    const result = await controller.previewCall(
      { id: 'user', company_id: 'company' },
      'client',
      { ...previewBody, include_transcript: true, payload_version: 2 },
    );
    expect(result).toMatchObject({
      configured: true,
      settings_overridden: true,
      include_transcript: true,
    });
    const call = JSON.parse(JSON.stringify(result.payload)).call;
    expect(call).not.toHaveProperty('tools');
    expect(call).not.toHaveProperty('transcript');
    expect(call.turns.flatMap((turn: any) => turn.messages)).toEqual([
      expect.objectContaining({ text: 'Teste', role: 'customer' }),
    ]);
    expect(prisma.webhook_endpoints.findFirst).toHaveBeenCalledTimes(1);
    const saved = await controller.previewCall(
      { id: 'user', company_id: 'company' },
      'client',
      previewBody,
    );
    expect(saved).toMatchObject({
      include_transcript: false,
      payload_version: 1,
      settings_overridden: false,
    });
  });

  it('validates nested inputs and rejects extra tenant fields', async () => {
    expect(
      await validate(plainToInstance(CallPreviewDto, previewBody), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(0);
    const invalid = plainToInstance(CallPreviewDto, {
      ...previewBody,
      company_id: 'foreign',
      duration_seconds: -1,
      payload_version: 3,
      include_transcript: 'true',
      transcript: [{ role: 'system', text: 123 }],
      tools: [{ status: 'bogus' }],
    });
    const errors = await validate(invalid, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining([
        'company_id',
        'duration_seconds',
        'payload_version',
        'include_transcript',
        'transcript',
        'tools',
      ]),
    );
  });
});

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
    payload_version: 2,
    retention_hours: 12,
    include_transcript: true,
    max_retries: 5,
  };
  const prisma = {
    webhook_endpoints: {
      findFirst: jest.fn().mockResolvedValue({
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
