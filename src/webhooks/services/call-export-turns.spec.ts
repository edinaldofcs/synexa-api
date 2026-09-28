import { sealWebhookSecret } from './webhook-secret';
import { buildCallTurns } from './call-export-turns';
import { buildCallExportPayload } from './call-export-payload';
import { createVoiceConversation } from '../../voice/services/voice-heartbeat';
import { decrypt } from '../../common/utils/crypto.util';

it('v3 exports each conversation item once and leaves original model results and raw responses untouched', () => {
  const modelResult = {
    balance: 10,
    _chainTrail: [{ response: { balance: 10 } }],
  };
  const rawBody = { balance: 10, _chainTrail: 'business-field-in-raw-body' };
  const input = {
    eventId: 'event',
    companyId: 'company',
    clientId: 'client',
    conversation: {
      id: 'call',
      started_at: new Date(),
      current_agent_id: null,
      metadata: {},
    },
    endedAt: new Date(),
    messages: [
      {
        sender_type: 'customer',
        content: 'Saldo?',
        metadata: { turn_id: 't' },
      },
    ],
    tools: [
      {
        tool_name: 'lookup',
        status: 'success',
        result: modelResult,
        audit: {
          turn_id: 't',
          agent_id: 'a',
          http_exchanges: [{ response: { body: rawBody } }] as any,
        },
      },
    ],
  };
  const payload = JSON.parse(
    JSON.stringify(buildCallExportPayload({ ...input, payloadVersion: 3 })),
  );
  expect(payload.call).not.toHaveProperty('transcript');
  expect(payload.call).not.toHaveProperty('tools');
  expect(payload.call.turns).toHaveLength(1);
  expect(payload.call.turns[0].messages).toHaveLength(1);
  expect(payload.call.turns[0].tools[0].model_result).toEqual({ balance: 10 });
  expect(
    payload.call.turns[0].tools[0].http_exchanges[0].response.body,
  ).toEqual(rawBody);
  expect(modelResult._chainTrail).toHaveLength(1);
  expect(buildCallExportPayload(input).schema_version).toBe(3);
});

it.each([undefined, 3])(
  'freezes the selected payload version at enrollment (%s)',
  async (version) => {
    const oldKey = process.env.ENCRYPTION_KEY;
    const key = 'unit-test-encryption-material-for-webhook';
    process.env.ENCRYPTION_KEY = key;
    try {
      const tx = {
        conversations: {
          create: jest.fn().mockResolvedValue({
            id: 'call',
            company_id: 'company',
            client_id: 'client',
          }),
        },
        webhook_endpoints: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'endpoint',
            url: 'https://example.com',
            signing_secret_enc: sealWebhookSecret('test'),
            retry_policy: {
              payload_version: version,
              include_transcript: true,
            },
          }),
        },
        call_exports: { create: jest.fn() },
      };
      await createVoiceConversation(
        { $transaction: (fn: any) => fn(tx) } as any,
        { data: { company_id: 'company' } },
      );
      const destination = JSON.parse(
        decrypt(
          tx.call_exports.create.mock.calls[0][0].data.destination_enc,
          key,
        ),
      );
      expect(destination).toMatchObject({
        payload_version: 3,
        include_transcript: true,
      });
    } finally {
      if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = oldKey;
    }
  },
);

it('correlates concurrent tools by their captured turn, even when completion order differs', () => {
  const turns = buildCallTurns(
    [
      {
        id: 'm1',
        sender_type: 'customer',
        content: 'Consultar',
        created_at: '2026-09-27T12:00:00Z',
        metadata: { turn_id: 't1' },
      },
      {
        id: 'm2',
        sender_type: 'ai',
        content: 'Saldo disponível',
        created_at: '2026-09-27T12:00:04Z',
        metadata: { turn_id: 't1' },
      },
      {
        id: 'm3',
        sender_type: 'customer',
        content: 'Pagar',
        created_at: '2026-09-27T12:00:05Z',
        metadata: { turn_id: 't2' },
      },
    ],
    [
      {
        id: 'tool2',
        tool_name: 'pay',
        arguments: { amount: 10 },
        result: { ok: true },
        status: 'success',
        created_at: '2026-09-27T12:00:06Z',
        audit: { turn_id: 't2', agent_id: 'a2', http_exchanges: [] },
      },
      {
        id: 'tool1',
        tool_name: 'lookup',
        arguments: { cpf: '123' },
        result: { balance: 10 },
        status: 'success',
        created_at: '2026-09-27T12:00:01Z',
        completed_at: '2026-09-27T12:00:07Z',
        audit: { turn_id: 't1', agent_id: 'a1', http_exchanges: [] },
      },
    ],
  );
  expect(turns.map((turn) => turn.id)).toEqual(['t1', 't2']);
  expect(turns[0].messages.map((message) => message.id)).toEqual(['m1', 'm2']);
  expect(turns[0].tools[0]).toMatchObject({
    id: 'tool1',
    agent_id: 'a1',
    arguments: { cpf: '123' },
    model_result: { balance: 10 },
  });
});

it('does not invent associations for historical data or reveal a disabled transcript', () => {
  const tools = [{ id: 'old', tool_name: 'lookup', status: 'success' }];
  const turns = buildCallTurns(undefined, tools);
  expect(turns[0]).toMatchObject({
    correlation: 'unavailable',
    messages: [],
    tools: [{ audit_available: false, http_exchanges: [] }],
  });
  expect(buildCallTurns([], [])).toEqual([]);
});
