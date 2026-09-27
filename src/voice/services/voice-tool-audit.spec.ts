import { decrypt } from '../../common/utils/crypto.util';
import {
  startHttpAudit,
  sealToolAudit,
  VoiceAuditTurn,
} from './voice-tool-audit';

it('redacts credentials and echoed secrets while preserving business data without mutation', () => {
  const body = { amount: 12, credentials: { password: 'private-password' } };
  const capture = startHttpAudit({
    apiId: 'api',
    name: 'lookup',
    url: 'https://user:private-password@example.com/test?api_key=query-secret&cpf=123',
    method: 'POST',
    headers: {
      Authorization: 'Bearer header-secret',
      'Content-Type': 'application/json',
    },
    body,
  });
  capture.response(
    200,
    new Headers({ 'set-cookie': 'session=cookie-secret' }),
    {
      balance: 12,
      nested: { access_token: 'response-secret' },
      echo: 'header-secret private-password query-secret response-secret',
    },
  );
  const serialized = JSON.stringify(capture.entry);
  for (const value of [
    'header-secret',
    'private-password',
    'query-secret',
    'response-secret',
    'cookie-secret',
  ])
    expect(serialized).not.toContain(value);
  expect(capture.entry.response?.body).toMatchObject({ balance: 12 });
  expect(body.credentials.password).toBe('private-password');
  expect(capture.entry.request.url).toContain('cpf=123');
});

it('marks oversized evidence explicitly and keeps errors observable without stack traces', () => {
  const capture = startHttpAudit({
    apiId: 'api',
    name: 'lookup',
    url: 'https://example.com',
    method: 'GET',
    headers: {},
  });
  capture.response(500, new Headers(), 'x'.repeat(1024 * 1024 + 1));
  capture.failed(new Error('Contains private details'));
  expect(capture.entry.response?.body).toMatchObject({
    omitted: true,
    reason: 'audit_size_limit',
  });
  expect(capture.entry.error).toBe('request_failed');
  expect(JSON.stringify(capture.entry)).not.toContain('private details');
});

it('redacts credentials in malformed JSON and HTML/plain-text error bodies', () => {
  const capture = startHttpAudit({
    apiId: 'a',
    name: 'a',
    url: 'https://example.com',
    method: 'GET',
    headers: {},
  });
  capture.response(
    500,
    new Headers(),
    '{"password":"private-error-value", broken json; token=private-token',
  );
  expect(JSON.stringify(capture.entry)).not.toContain('private-error-value');
  expect(JSON.stringify(capture.entry)).not.toContain('private-token');
});

it('seals evidence only for enrolled calls and resets correlation at the next user turn', () => {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'test-only-audit-key-at-least-32-characters';
  try {
    const turn = new VoiceAuditTurn();
    const first = turn.user();
    expect(turn.user()).toBe(first);
    expect(turn.assistant()).toBe(first);
    const frozenToolTurn = turn.id;
    turn.complete();
    expect(turn.user()).not.toBe(first);
    const encrypted = sealToolAudit(frozenToolTurn, 'agent', [])!;
    expect(encrypted).not.toContain('http_exchanges');
    expect(
      JSON.parse(decrypt(encrypted, process.env.ENCRYPTION_KEY)),
    ).toMatchObject({ turn_id: first, agent_id: 'agent', http_exchanges: [] });
    expect(sealToolAudit(first, 'agent', undefined)).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
});
