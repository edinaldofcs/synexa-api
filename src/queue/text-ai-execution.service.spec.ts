import { ConflictException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TextAiExecutionService } from './text-ai-execution.service';
import { ChannelsService } from '../channels/services/channels.service';
import {
  QueueService,
  IngestJobData,
  AgentJobData,
  DispatchJobData,
} from './queue.service';

function baseIngest(): IngestJobData {
  return {
    inbound_event_id: 'evt-1',
    client_id: 'client-1',
    company_id: 'company-1',
    channel_connection_id: 'conn-1',
    origin_channel: 'api',
    external_user_id: '+550001',
    message_type: 'text',
    text: 'Olá',
    idempotency_key: 'idem-1',
  };
}

const AGENT_DATA: AgentJobData = {
  conversation_id: 'conv-1',
  message_id: 'msg-1',
  inbound_event_id: 'evt-1',
  company_id: 'company-1',
  client_id: 'client-1',
  channel_connection_id: 'conn-1',
  origin_channel: 'api',
  external_user_id: '+550001',
  text: 'resposta',
};

const DISPATCH_DATA: DispatchJobData = {
  ...AGENT_DATA,
};

describe('TextAiExecutionService', () => {
  let prisma: Record<string, any>;

  let redis: Record<string, any>;

  let conversations: Record<string, any>;

  let orchestration: Record<string, any>;

  let channels: Record<string, any>;

  let queue: Record<string, any>;
  let service: TextAiExecutionService;

  beforeEach(() => {
    prisma = {
      painel_clients: {
        findUnique: jest.fn().mockResolvedValue({ queue_enabled: true }),
      },
      media_assets: { findMany: jest.fn().mockResolvedValue([]) },
      inbound_events: { update: jest.fn().mockResolvedValue({}) },
      channel_identities: {
        findFirst: jest.fn().mockResolvedValue({
          end_user_id: 'end-user-1',
        }),
        create: jest.fn(),
      },
      end_users: { create: jest.fn() },
      conversations: {
        findUnique: jest.fn().mockResolvedValue({ mode: 'bot' }),
      },
    };
    redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    conversations = {
      findOrCreate: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      addMessage: jest.fn().mockResolvedValue({ id: 'msg-1' }),
    };
    orchestration = {
      processMessage: jest.fn().mockResolvedValue({
        responseText: 'oi!',
        responseMessageId: 'resp-1',
      }),
    };
    channels = { sendOutbound: jest.fn().mockResolvedValue({}) };
    queue = {
      addIngestionJob: jest.fn().mockResolvedValue('job-ingest'),
      addAgentJob: jest.fn().mockResolvedValue('job-agent'),
      addDispatchJob: jest.fn().mockResolvedValue('job-dispatch'),
      addMediaJob: jest.fn().mockResolvedValue('job-media'),
    };

    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === ChannelsService) return channels;
        throw new Error(`Provider inesperado no ModuleRef: ${String(token)}`);
      }),
    };

    service = new TextAiExecutionService(
      prisma as never,
      redis as never,
      queue as never,
      conversations as never,
      orchestration as never,
      moduleRef as never,
    );
  });

  afterEach(async () => {
    // descarta microtasks pendentes de execuções inline de outros testes
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  });

  it('fila habilitada: ingestion vai para o BullMQ', async () => {
    const res = await service.dispatchIngestion(baseIngest());
    expect(res.mode).toBe('queued');
    expect(res.job_id).toBe('job-ingest');
    expect(queue.addIngestionJob).toHaveBeenCalledWith(
      expect.objectContaining({ inbound_event_id: 'evt-1' }),
    );
  });

  it('fila desabilitada: cadeia completa roda inline sem tocar no Bull', async () => {
    prisma.painel_clients.findUnique.mockResolvedValue({
      queue_enabled: false,
    });
    prisma.channel_identities.findFirst.mockResolvedValue(null);
    prisma.end_users.create.mockResolvedValue({ id: 'end-user-2' });
    prisma.channel_identities.create.mockResolvedValue({});
    conversations.addMessage.mockResolvedValue({ id: 'msg-x' });

    const decision = await service.dispatchIngestion(baseIngest());
    expect(decision.mode).toBe('inline');
    expect(queue.addIngestionJob).not.toHaveBeenCalled();

    // aguarda a execução em background completar toda a cadeia
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
      if (channels.sendOutbound.mock.calls.length > 0) break;
    }

    expect(conversations.findOrCreate).toHaveBeenCalled();
    expect(orchestration.processMessage).toHaveBeenCalled();
    expect(channels.sendOutbound).toHaveBeenCalledTimes(1);
    expect(channels.sendOutbound.mock.calls[0][2]).toBe('oi!');
    expect(redis.set).not.toHaveBeenCalled(); // nenhum erro → sem dead-letter
  });

  it('falha ao consultar o cliente faz fallback para a fila (fail-safe)', async () => {
    prisma.painel_clients.findUnique.mockRejectedValue(new Error('db down'));
    const res = await service.dispatchIngestion(baseIngest());
    expect(res.mode).toBe('queued');
  });

  it('lock ocupado no inline é retentado uma vez e depois vai para dead-letter', async () => {
    jest.useFakeTimers();
    try {
      prisma.painel_clients.findUnique.mockResolvedValue({
        queue_enabled: false,
      });
      redis.acquireLock
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await service.dispatchAgent(AGENT_DATA);

      await jest.advanceTimersByTimeAsync(3_000);
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(0);
      }

      expect(redis.acquireLock).toHaveBeenCalledTimes(2);
      expect(redis.set).toHaveBeenCalledTimes(1);
      const payload = redis.set.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.stage).toBe('agent');
    } finally {
      jest.useRealTimers();
    }
  });

  it('conversa em modo manual interrompe agente antes da LLM', async () => {
    prisma.conversations.findUnique.mockResolvedValue({
      mode: 'manual',
      assigned_to: 'op-1',
    });

    await service.dispatchAgent(AGENT_DATA);
    await new Promise((r) => setImmediate(r));

    expect(orchestration.processMessage).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('dispatch respeita o mesmo toggle para envio externo', async () => {
    prisma.painel_clients.findUnique.mockResolvedValue({
      queue_enabled: false,
    });

    const res = await service.dispatchResponse(DISPATCH_DATA);
    expect(res.mode).toBe('inline');

    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

    expect(queue.addDispatchJob).not.toHaveBeenCalled();
    expect(channels.sendOutbound).toHaveBeenCalledTimes(1);
  });
});
