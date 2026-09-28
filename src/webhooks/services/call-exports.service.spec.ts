import { CallExportsService } from './call-exports.service';
import { postCallExport } from './call-export-transport';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { createHmac } from 'crypto';

jest.mock('./call-export-transport', () => ({ postCallExport: jest.fn() }));
const key = 'test-only-encryption-material-32-characters';
const sender = postCallExport as jest.Mock;
function setup(status = 'pending') {
  const row: any = {
    id: 'event',
    conversation_id: 'call',
    company_id: 'company',
    client_id: 'client',
    endpoint_id: 'endpoint',
    status,
    attempt: 0,
    expires_at: new Date(Date.now() + 3600000),
    next_attempt_at: new Date(),
    lease_token: null,
    lease_until: null,
    purged_at: null,
    payload_enc: encrypt(
      JSON.stringify({
        event_id: 'event',
        call: { variables: { customer: 'private' } },
      }),
      key,
    ),
    destination_enc: encrypt(
      JSON.stringify({
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        retention_hours: 24,
        include_transcript: false,
      }),
      key,
    ),
  };
  const mutate = jest.fn(async ({ where, data }: any) => {
    if (where.lease_token && where.lease_token !== row.lease_token)
      return { count: 0 };
    if (where.OR && row.lease_until && row.lease_until > new Date())
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const conversations: any = {
    findFirst: jest.fn().mockResolvedValue({
      id: 'call',
      voice_finalized_at: new Date(),
      closed_at: new Date(),
      started_at: new Date(Date.now() - 60000),
      metadata: {},
    }),
    findUniqueOrThrow: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn(),
  };
  const prisma: any = {
    call_exports: {
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      findMany: jest.fn(async () => [row]),
      updateMany: mutate,
      count: jest.fn(async () => 1),
    },
    conversations,
    conversation_state: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ state: { customer: 'private' } }),
    },
    messages: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { sender_type: 'customer', content: 'private transcript' },
        ]),
    },
    tool_calls: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    agent_runs: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    webhook_deliveries: { deleteMany: jest.fn() },
    outbox_events: { deleteMany: jest.fn() },
    voice_session_telemetry: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const media = { purgeConversationAssets: jest.fn() };
  const service = new CallExportsService(
    prisma,
    { get: () => key } as any,
    { scheduleCallExports: jest.fn() } as any,
    media as any,
  );
  return { row, prisma, media, service };
}

beforeEach(() => sender.mockReset());

it.each([3])(
  'decrypts private HTTP evidence only for the webhook and joins it to the recorded transcript turn (v%s)',
  async (payloadVersion) => {
    sender.mockResolvedValue(503);
    const { row, service, prisma } = setup('collecting');
    const destination = JSON.parse(decrypt(row.destination_enc, key));
    row.destination_enc = encrypt(
      JSON.stringify({
        ...destination,
        include_transcript: true,
        payload_version: payloadVersion,
      }),
      key,
    );
    prisma.messages.findMany.mockResolvedValue([
      {
        id: 'm',
        sender_type: 'customer',
        content: 'Consultar saldo',
        metadata: { turn_id: 't' },
        created_at: new Date(),
      },
    ]);
    prisma.tool_calls.findMany.mockResolvedValue([
      {
        id: 'tool',
        tool_name: 'lookup',
        arguments: { customer: '123' },
        result: { balance: 10 },
        status: 'success',
        audit_enc: encrypt(
          JSON.stringify({
            turn_id: 't',
            agent_id: 'agent',
            http_exchanges: [
              {
                request: { body: { customer: '123' } },
                response: { body: { balance: 10, extra: 'only-webhook' } },
              },
            ],
          }),
          key,
        ),
      },
    ]);
    await service.process(row.id);
    const payload = JSON.parse(decrypt(row.payload_enc, key));
    expect(payload.call.turns[0]).toMatchObject({
      id: 't',
      messages: [{ text: 'Consultar saldo' }],
      tools: [
        {
          arguments: { customer: '123' },
          model_result: { balance: 10 },
          http_exchanges: [{ response: { body: { extra: 'only-webhook' } } }],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('audit_enc');
    expect(payload.schema_version).toBe(payloadVersion);
    {
      expect(payload.call).not.toHaveProperty('tools');
      expect(payload.call).not.toHaveProperty('transcript');
    }
    expect(prisma.tool_calls.findMany.mock.calls[0][0].where).toEqual({
      conversation_id: 'call',
      company_id: 'company',
      client_id: 'client',
    });
  },
);

it('retries corrupted audit evidence rather than silently dropping it from delivery', async () => {
  const { row, service, prisma } = setup('collecting');
  prisma.tool_calls.findMany.mockResolvedValue([
    { tool_name: 'lookup', audit_enc: 'invalid' },
  ]);
  await service.process(row.id);
  expect(sender).not.toHaveBeenCalled();
  expect(row.error_code).toBe('processing_failed');
});
it('signs the exact payload, accepts 2xx and scrubs content while preserving billing', async () => {
  sender.mockResolvedValue(204);
  const { row, service, prisma } = setup();
  await service.process(row.id);
  const [, body, headers] = sender.mock.calls[0];
  expect(headers['X-Synexa-Signature']).toBe(
    'sha256=' +
      createHmac('sha256', 'test-secret')
        .update(`${headers['X-Synexa-Timestamp']}.${body}`)
        .digest('hex'),
  );
  expect(headers['X-Synexa-Event-Id']).toBe('event');
  expect(row).toMatchObject({
    status: 'delivered',
    attempt: 1,
    payload_enc: null,
    destination_enc: null,
  });
  expect(row.purged_at).toBeInstanceOf(Date);
  expect(prisma.conversations.deleteMany).toHaveBeenCalledWith({
    where: { id: 'call', company_id: 'company' },
  });

  expect(
    prisma.voice_session_telemetry.updateMany.mock.calls[0][0].data,
  ).toMatchObject({ caller_number: null, did_number: null });
});
it('keeps encrypted data on failure and retries with the same event and body', async () => {
  sender.mockResolvedValueOnce(503).mockResolvedValueOnce(200);
  const { row, service, prisma } = setup();
  await service.process(row.id);
  expect(row.status).toBe('pending');
  expect(row.attempt).toBe(1);
  expect(row.payload_enc).not.toContain('private');
  expect(prisma.conversations.deleteMany).not.toHaveBeenCalled();
  expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  await service.process(row.id);
  expect(sender.mock.calls[0][1]).toBe(sender.mock.calls[1][1]);
  expect(row.status).toBe('delivered');
});
it('expires without sending, erases content and preserves an observable failed receipt', async () => {
  const { row, service } = setup();
  row.expires_at = new Date(0);
  await service.process(row.id);
  expect(sender).not.toHaveBeenCalled();
  expect(row).toMatchObject({
    status: 'expired',
    error_code: 'retention_expired',
    payload_enc: null,
  });
  expect(row.purged_at).toBeInstanceOf(Date);
});
it('does not send concurrently when another worker holds the lease', async () => {
  const { row, service } = setup();
  row.lease_until = new Date(Date.now() + 60000);
  await service.process(row.id);
  expect(sender).not.toHaveBeenCalled();
});
it('recovers a crashed worker lease', async () => {
  sender.mockResolvedValue(200);
  const { row, service } = setup();
  row.lease_until = new Date(0);
  row.lease_token = 'dead-worker';
  await service.process(row.id);
  expect(row.status).toBe('delivered');
});
it('retries failed cleanup without sending the acknowledged event again', async () => {
  sender.mockResolvedValue(200);
  const { row, service, media } = setup();
  media.purgeConversationAssets.mockRejectedValueOnce(
    new Error('storage unavailable'),
  );
  await service.process(row.id);
  expect(row.status).toBe('delivered');
  expect(row.purged_at).toBeNull();
  expect(row.error_code).toBe('processing_failed');
  await service.process(row.id);
  expect(sender).toHaveBeenCalledTimes(1);
  expect(row.purged_at).toBeInstanceOf(Date);
});
it('does not export or erase an active call with a fresh heartbeat', async () => {
  const { row, service, prisma } = setup('collecting');
  prisma.conversations.findFirst.mockResolvedValue({
    id: 'call',
    voice_finalized_at: null,
  });
  await service.process(row.id);
  expect(row.status).toBe('collecting');
  expect(sender).not.toHaveBeenCalled();
  expect(prisma.conversations.deleteMany).not.toHaveBeenCalled();
});
it('omits transcript unless opted in, and freezes the snapshot after finalization', async () => {
  sender.mockResolvedValue(503);
  const { row, service, prisma } = setup('collecting');
  await service.process(row.id);
  const payload = JSON.parse(decrypt(row.payload_enc, key));
  expect(payload.call.variables).toEqual({ customer: 'private' });
  expect(payload.call).not.toHaveProperty('transcript');
  expect(prisma.messages.findMany).not.toHaveBeenCalled();
  await service.process(row.id);
  expect(prisma.conversation_state.findUnique).toHaveBeenCalledTimes(1);
});
it('exports the transcript when enabled', async () => {
  sender.mockResolvedValue(503);
  const { row, service } = setup('collecting');
  const destination = JSON.parse(decrypt(row.destination_enc, key));
  row.destination_enc = encrypt(
    JSON.stringify({ ...destination, include_transcript: true }),
    key,
  );
  await service.process(row.id);
  expect(
    JSON.parse(decrypt(row.payload_enc, key)).call.turns[0].messages[0].text,
  ).toBe('private transcript');
});
it('recovers a disconnected call without touching unrelated calls', async () => {
  sender.mockResolvedValue(503);
  const { row, service, prisma } = setup('collecting');
  prisma.conversations.findFirst.mockResolvedValue({
    id: 'call',
    voice_finalized_at: null,
    voice_heartbeat_at: new Date(Date.now() - 180000),
  });
  prisma.conversations.updateMany.mockResolvedValue({ count: 1 });
  prisma.conversations.findUniqueOrThrow.mockResolvedValue({
    id: 'call',
    closed_at: new Date(),
    voice_finalized_at: new Date(),
    metadata: {},
  });
  await service.process(row.id);
  expect(prisma.conversations.updateMany.mock.calls[0][0].where).toMatchObject({
    id: 'call',
    voice_finalized_at: null,
  });
  expect(JSON.parse(decrypt(row.payload_enc, key)).call.end_reason).toBe(
    'connection_lost',
  );
});

it('cleans remaining copies and reports failure if the original conversation was manually removed', async () => {
  const { row, prisma, service } = setup('collecting');
  prisma.conversations.findFirst.mockResolvedValue(null);
  await service.process(row.id);
  expect(row).toMatchObject({
    status: 'expired',
    error_code: 'source_missing',
    payload_enc: null,
    destination_enc: null,
  });
  expect(row.purged_at).toBeInstanceOf(Date);
  expect(sender).not.toHaveBeenCalled();
});
