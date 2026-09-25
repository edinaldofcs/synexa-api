import { PrismaClient } from '@prisma/client';
import {
  createVoiceConversation,
  finalizeVoiceConversation,
} from '../../voice/services/voice-heartbeat';
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
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1')
      throw new Error(
        'Only explicitly configured loopback test databases allowed',
      );
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
    await prisma.companies.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
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
        secret_hash: 'test-only-secret',
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
      data: { conversation_id: call.id, state: { name: 'private customer' } },
    });
    await prisma.voice_session_telemetry.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: call.id,
        duration_sec: 60,
        cost_usd: 0.25,
        caller_number: 'private phone',
      },
    });
    await prisma.painel_interactions.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        session_id: call.id,
        client_name: 'private customer',
        duration_seconds: 60,
        total_tokens: 100,
        messages: ['private transcript'],
        context_variables: { name: 'private customer' },
      },
    });
    await finalizeVoiceConversation(prisma as any, call.id);
    // Enrollment must survive disabling/deleting the endpoint.
    await prisma.webhook_endpoints.delete({ where: { id: endpoint.id } });
    (postCallExport as jest.Mock).mockResolvedValue(204);
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
    const interaction = await prisma.painel_interactions.findUniqueOrThrow({
      where: { session_id: call.id },
    });
    expect(interaction).toMatchObject({
      total_tokens: 100,
      client_name: null,
      messages: [],
      context_variables: {},
    });
    const payload = JSON.parse((postCallExport as jest.Mock).mock.calls[0][1]);
    expect(payload.call.transcript[0].content).toBe('private transcript');
    await service.sweep();
    expect(postCallExport).toHaveBeenCalledTimes(1);
  });
});
