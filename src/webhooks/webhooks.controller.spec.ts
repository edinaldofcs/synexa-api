import { WebhooksController } from './webhooks.controller';
import { UnauthorizedException } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CallPreviewDto } from './dto/call-preview.dto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import request from 'supertest';

const previewBody = {
  duration_seconds: 15,
  variables: { agreement_id: 'example' },
  transcript: [{ role: 'user' as const, text: 'Teste' }],
  tools: [{ tool_name: 'consulta', status: 'success', result: { ok: true } }],
};

describe('read-only call preview', () => {
  it('accepts persisted seed agent IDs at the root and inside MicroSIP events', async () => {
    const agentId = '00000000-0000-0000-0000-000000000011';
    const input = {
      ...previewBody,
      agent_id: agentId,
      transcript: [{ ...previewBody.transcript[0], agent_id: agentId }],
      tools: [{ ...previewBody.tools[0], agent_id: agentId }],
    };
    const dto = plainToInstance(CallPreviewDto, input);
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);
    const { controller } = setup(true, true);
    const result = await controller.previewCall(
      { id: 'user', company_id: 'company' },
      'client',
      dto,
    );
    expect(result.payload.call.agent_id).toBe(agentId);
    expect(result.payload.call.variables).toEqual(previewBody.variables);
    expect(
      result.payload.call.turns.flatMap((turn) => turn.messages),
    ).toHaveLength(1);
  });

  it('returns HTTP 200 for a MicroSIP preview with existing local IDs', async () => {
    const { prisma } = setup(true, true);
    const module = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    const app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { id: 'user', company_id: 'company' };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    try {
      const agentId = '00000000-0000-0000-0000-000000000011';
      const response = await request(app.getHttpServer())
        .post(
          '/webhooks/clients/00000000-0000-0000-0000-000000000002/call-preview',
        )
        .send({
          ...previewBody,
          agent_id: agentId,
          transcript: [{ ...previewBody.transcript[0], agent_id: agentId }],
          tools: [{ ...previewBody.tools[0], agent_id: agentId }],
        })
        .expect(200);
      expect(response.body.payload.schema_version).toBe(3);
      expect(response.body.payload.call.variables).toEqual(
        previewBody.variables,
      );
    } finally {
      await app.close();
    }
  });

  it('still rejects malformed agent IDs at every nesting level', async () => {
    const dto = plainToInstance(CallPreviewDto, {
      ...previewBody,
      agent_id: 'invalid',
      transcript: [{ ...previewBody.transcript[0], agent_id: 'invalid' }],
      tools: [{ ...previewBody.tools[0], agent_id: 'invalid' }],
    });
    expect((await validate(dto)).map((error) => error.property)).toEqual(
      expect.arrayContaining(['agent_id', 'transcript', 'tools']),
    );
  });

  it('joins messages and repeated/chained API calls by source IDs without requiring private HTTP audit', async () => {
    const { controller } = setup(true, true);
    const first = '10000000-0000-4000-8000-000000000001';
    const second = '10000000-0000-4000-8000-000000000002';
    const body: CallPreviewDto = {
      ...previewBody,
      payload_version: 3,
      transcript: [
        { role: 'user', text: 'Consultar', turn_id: first },
        { role: 'ai', text: 'Localizei', turn_id: first },
        { role: 'user', text: 'Repetir', turn_id: second },
      ],
      tools: [
        {
          id: 'lookup-2',
          tool_name: 'debts',
          status: 'success',
          turn_id: second,
          result: { balance: 20 },
        },
        {
          id: 'lookup-1',
          tool_name: 'debts',
          status: 'success',
          turn_id: first,
          result: { balance: 10 },
        },
        {
          id: 'chain-1',
          tool_name: 'offers',
          status: 'success',
          turn_id: first,
          result: { plans: [1] },
        },
      ],
    };
    expect(
      await validate(plainToInstance(CallPreviewDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(0);
    const result = await controller.previewCall(
      { id: 'user', company_id: 'company' },
      'client',
      body,
    );
    expect(result.payload.call.turns).toHaveLength(2);
    expect(result.payload.call.turns[0]).toMatchObject({
      id: first,
      correlation: 'recorded',
      messages: [{ text: 'Consultar' }, { text: 'Localizei' }],
      tools: [
        { id: 'lookup-1', audit_available: false },
        { id: 'chain-1', audit_available: false },
      ],
    });
    expect(result.payload.call.turns[1]).toMatchObject({
      id: second,
      tools: [{ id: 'lookup-2' }],
    });
  });
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
        schema_version: 3,
        event: 'call.completed',
        company_id: 'company',
        client_id: 'client',
        call: {
          duration_seconds: 15,
          variables: previewBody.variables,
        },
      });
      expect(
        result.payload.call.turns.flatMap((turn) => turn.messages),
      ).toEqual(
        includeTranscript
          ? [expect.objectContaining({ role: 'customer', text: 'Teste' })]
          : [],
      );
      expect(result.payload.call.turns.flatMap((turn) => turn.tools)).toEqual([
        expect.objectContaining({
          tool_name: 'consulta',
          status: 'completed',
          model_result: { ok: true },
        }),
      ]);
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
      payload_version: 3,
      payload: {
        schema_version: 3,
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

  it('can simulate messages and v3 without changing a saved destination', async () => {
    const { controller, prisma } = setup(true, false);
    const result = await controller.previewCall(
      { id: 'user', company_id: 'company' },
      'client',
      { ...previewBody, include_transcript: true, payload_version: 3 },
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
      payload_version: 3,
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
      payload_version: 2,
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
    payload_version: 3,
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
