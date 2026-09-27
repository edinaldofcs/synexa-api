import { buildCallTurns } from './call-export-turns';

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
