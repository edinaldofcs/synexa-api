import { sealWebhookSecret } from './webhook-secret';
import { createServer, type Server } from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import { VoiceTelemetryService } from '../../voice/services/voice-telemetry.service';
import { VoiceClientSession } from '../../voice/sessions/voice-client-session';
import { PrismaClient } from '@prisma/client';
import { createVoiceConversation } from '../../voice/services/voice-heartbeat';
import { CallExportsService } from './call-exports.service';
import { postCallExport } from './call-export-transport';
import { randomUUID } from 'crypto';

jest.mock('./call-export-transport', () => ({ postCallExport: jest.fn() }));
const databaseUrl = process.env.CALL_EXPORT_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('call export on disposable PostgreSQL', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl || 'postgresql://unused' } },
  });
  const companyId = randomUUID();
  const clientId = randomUUID();
  const key = 'disposable-test-only-key-at-least-32-characters';
  const oldKey = process.env.ENCRYPTION_KEY;
  let receiver: Server;
  let receiverUrl: string;
  const received: Array<{ body: string; headers: Record<string, any> }> = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1')
      throw new Error(
        'Only explicitly configured loopback test databases allowed',
      );
    receiver = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ body, headers: req.headers });
        res.writeHead(204).end();
      });
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    process.env.ENCRYPTION_KEY = key;
    await prisma.companies.create({
      data: { id: companyId, name: 'Disposable export test' },
    });
    await prisma.painel_clients.create({
      data: { id: clientId, company_id: companyId },
    });
  });
  afterAll(async () => {
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
    await prisma.agent_runs.deleteMany({ where: { company_id: companyId } });
    await prisma.voice_session_telemetry.deleteMany({
      where: { company_id: companyId },
    });
    await prisma.companies.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
    if (receiver)
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
  });
  it('enrolls only new calls, delivers once, deletes content and keeps billable usage', async () => {
    const old = await createVoiceConversation(prisma as any, {
      data: {
        company_id: companyId,
        client_id: clientId,
        origin_channel: 'voice',
      },
    });
    expect(old.exportEnabled).toBe(false);
    const endpoint = await prisma.webhook_endpoints.create({
      data: {
        client_id: clientId,
        url: 'https://example.com/webhook',
        events: ['call.completed'],
        enabled: true,
        signing_secret_enc: sealWebhookSecret('test-only-secret'),
        retry_policy: { retention_hours: 24, include_transcript: true },
      },
    });
    await expect(
      prisma.webhook_endpoints.create({
        data: {
          client_id: clientId,
          url: 'https://example.com/other',
          events: ['call.completed'],
          enabled: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const call = await createVoiceConversation(prisma as any, {
      data: {
        company_id: companyId,
        client_id: clientId,
        origin_channel: 'voice',
      },
    });
    expect(call.exportEnabled).toBe(true);
    await prisma.messages.create({
      data: {
        company_id: companyId,
        conversation_id: call.id,
        sender_type: 'customer',
        channel: 'voice',
        content: 'private transcript',
      },
    });
    await prisma.conversation_state.create({
      data: {
        conversation_id: call.id,
        state: {
          Pessoa: 'Pessoa fictícia',
          cpf: '00123',
          cpc: false,
          acordo: 0,
          promessa: null,
          Lista: [0, false, null],
          Objeto: { codigo: '001' },
          current_agent_id: 'internal',
          api_key: 'must-not-leave',
        },
      },
    });
    const voice = new VoiceClientSession({} as any);
    voice.companyId = companyId;
    voice.clientId = clientId;
    voice.conversationId = call.id;
    voice.startTime = Date.now() - 60000;
    voice.totalTokens = 100;
    const telemetry = new VoiceTelemetryService(
      prisma as any,
      {
        calculateVoiceLiveCost: () => 0.25,
        getExchangeRate: () => 5.8,
        calculateHybridVoiceCost: () => 0.25,
      } as any,
    );
    await telemetry.persistSessionTelemetry(voice, 'controlled_test');
    expect(
      await prisma.voice_session_telemetry.findUnique({
        where: { conversation_id: call.id },
      }),
    ).toMatchObject({
      duration_sec: 60,
      total_tokens: 100,
      audio_gate_enabled: false,
      hangup_cause: 'controlled_test',
    });
    // Enrollment must survive disabling/deleting the endpoint.
    await prisma.webhook_endpoints.delete({ where: { id: endpoint.id } });
    // Loopback is injected only in this test; production SSRF protections remain enabled.
    (postCallExport as jest.Mock).mockImplementation(
      async (_url, body, headers) => {
        const response = await fetch(receiverUrl, {
          method: 'POST',
          body,
          headers,
        });
        return response.status;
      },
    );
    const service = new CallExportsService(
      prisma as any,
      { get: () => key } as any,
      {} as any,
      { purgeConversationAssets: jest.fn() } as any,
    );
    await service.sweep();
    const receipt = await prisma.call_exports.findUniqueOrThrow({
      where: { conversation_id: call.id },
    });
    expect(receipt).toMatchObject({
      status: 'delivered',
      payload_enc: null,
      destination_enc: null,
    });
    expect(receipt.purged_at).toBeInstanceOf(Date);
    expect(
      await prisma.messages.count({ where: { conversation_id: call.id } }),
    ).toBe(0);
    expect(
      await prisma.conversation_state.count({
        where: { conversation_id: call.id },
      }),
    ).toBe(0);
    expect(
      await prisma.conversations.findUnique({ where: { id: call.id } }),
    ).toBeNull();
    expect(
      await prisma.conversations.findUnique({ where: { id: old.id } }),
    ).not.toBeNull();
    const usage = await prisma.voice_session_telemetry.findFirstOrThrow({
      where: { company_id: companyId },
    });
    expect(usage).toMatchObject({
      duration_sec: 60,
      cost_usd: 0.25,
      caller_number: null,
      conversation_id: null,
    });
    const payload = JSON.parse((postCallExport as jest.Mock).mock.calls[0][1]);
    expect(payload.call.turns[0].messages[0].text).toBe('private transcript');
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].body)).toEqual(payload);
    expect(received[0].headers['x-synexa-signature']).toBe(
      `sha256=${createHmac('sha256', 'test-only-secret').update(`${received[0].headers['x-synexa-timestamp']}.${received[0].body}`).digest('hex')}`,
    );
    expect(payload.schema_version).toBe(3);
    expect(payload.call.variables).toEqual({
      Pessoa: 'Pessoa fictícia',
      cpf: '00123',
      cpc: false,
      acordo: 0,
      promessa: null,
      Lista: [0, false, null],
      Objeto: { codigo: '001' },
    });
    expect(payload.call).not.toHaveProperty('summary');
    await service.sweep();
    expect(postCallExport).toHaveBeenCalledTimes(1);
  });
});
