import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { OrchestrationService } from '../orchestrator/orchestration.service';
import { ChannelsService } from '../channels/services/channels.service';
import {
  QueueService,
  IngestJobData,
  AgentJobData,
  DispatchJobData,
} from './queue.service';

export type TextAiExecutionMode = 'queued' | 'inline';

export interface DispatchDecision {
  mode: TextAiExecutionMode;
  job_id?: string;
}

const INLINE_RETRY_DELAY_MS = 2_500;
const INLINE_LOCK_TTL_SECONDS = 30;
const LOCK_WAIT_INTERVAL_MS = 250;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const QUEUE_ENABLED_CACHE_TTL_SECONDS = 30;

/**
 * Roteia as três etapas da IA de texto (ingestão -> agente -> resposta)
 * entre a fila BullMQ (durável, padrão) e execução inline no processo da API,
 * conforme o toggle `queue_enabled` de painel_clients.
 *
 * A decisão é reavaliada em cada estágio, então alternar a flag funciona
 * inclusive no meio do fluxo (fila desligada durante ingestão enfileira
 * o agente normalmente).
 *
 * Dependências: ConversationsService e OrchestrationService são acíclicos e
 * injetados formalmente; ChannelsService participa do único ciclo real
 * (ChannelsService ⇄ TextAiExecutionService, via forwardRef no outro lado) e
 * é resolvido por ModuleRef em tempo de uso — mecanismo formal do NestJS,
 * sem require() dinâmico.
 */
@Injectable()
export class TextAiExecutionService {
  private readonly logger = new Logger(TextAiExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly queueService: QueueService,
    private readonly conversationsService: ConversationsService,
    private readonly orchestrationService: OrchestrationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get channelsService(): ChannelsService {
    return this.moduleRef.get(ChannelsService, { strict: false });
  }

  // ── Pontos de roteamento (usados pelo ingress e pelos estágios internos) ──

  async dispatchIngestion(data: IngestJobData): Promise<DispatchDecision> {
    if (!(await this.isQueueEnabled(data.client_id))) {
      this.runInline(() => this.normalizeInbound(data), {
        stage: 'ingestion',
        client_id: data.client_id,
      });
      return { mode: 'inline' };
    }
    const job_id = await this.queueService.addIngestionJob(data);
    return { mode: 'queued', job_id };
  }

  async dispatchAgent(data: AgentJobData): Promise<DispatchDecision> {
    if (!(await this.isQueueEnabled(data.client_id))) {
      this.runInline(() => this.processWithAgent(data), {
        stage: 'agent',
        client_id: data.client_id,
      });
      return { mode: 'inline' };
    }
    const job_id = await this.queueService.addAgentJob(data);
    return { mode: 'queued', job_id };
  }

  async dispatchResponse(data: DispatchJobData): Promise<DispatchDecision> {
    if (!(await this.isQueueEnabled(data.client_id))) {
      this.runInline(() => this.dispatchResponseCore(data), {
        stage: 'dispatcher',
        client_id: data.client_id,
      });
      return { mode: 'inline' };
    }
    const job_id = await this.queueService.addDispatchJob(data);
    return { mode: 'queued', job_id };
  }

  async isQueueEnabled(clientId?: string): Promise<boolean> {
    if (!clientId) return true;
    const cacheKey = `queue_enabled:${clientId}`;
    try {
      const cached = await this.redisService.get<boolean>(cacheKey);
      if (typeof cached === 'boolean') return cached;
    } catch {}
    try {
      const client = (await (this.prisma.painel_clients as any).findUnique({
        where: { id: clientId },
        select: { queue_enabled: true },
      })) as { queue_enabled?: boolean } | null;
      const enabled = client ? client.queue_enabled !== false : true;
      await this.redisService
        .set(cacheKey, enabled, QUEUE_ENABLED_CACHE_TTL_SECONDS)
        .catch(() => undefined);
      return enabled;
    } catch (err) {
      const error = err as Error;
      this.logger.warn(
        `Falha ao ler queue_enabled do cliente ${clientId}; usando fila (${error.message})`,
      );
      return true; // Fail-safe: fila é o caminho durável.
    }
  }

  // ── Estágios puros (compartilhados por processor Bull e modo inline) ──────

  /** Portado 1:1 de IngestionProcessor.process — normaliza evento + enfileira/encadeia agente. */
  async normalizeInbound(data: IngestJobData): Promise<void> {
    const lockKey = `lock:conversation:${data.client_id}:${data.origin_channel}:${data.external_user_id}`;
    const acquired = await this.waitForConversationLock(
      lockKey,
      INLINE_LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      throw new ConflictException('Conversation is locked, will retry');
    }

    try {
      const endUserId = await this.resolveEndUser(data);

      const conversation = await this.conversationsService.findOrCreate({
        company_id: data.company_id,
        client_id: data.client_id,
        channel_connection_id: data.channel_connection_id,
        origin_channel: data.origin_channel,
        external_user_id: data.external_user_id,
        conversation_key: data.conversation_key,
        end_user_id: endUserId,
        metadata: data.metadata,
      });

      const message = await this.conversationsService.addMessage({
        conversation_id: conversation.id,
        company_id: data.company_id,
        client_id: data.client_id,
        sender_type: 'customer',
        channel: data.origin_channel,
        direction: 'inbound',
        message_type: data.message_type || 'text',
        content: data.text,
        idempotency_key: data.idempotency_key,
        request_id: data.request_id,
        raw_payload: data.raw_payload,
        parts: data.parts,
        metadata: data.metadata,
      });

      const mediaAssets = await this.prisma.media_assets.findMany({
        where: { message_id: message.id },
        select: { id: true, mime_type: true },
      });

      for (const asset of mediaAssets) {
        if (
          asset.mime_type.startsWith('audio/') ||
          asset.mime_type.startsWith('image/')
        ) {
          await this.queueService.addMediaJob({ media_asset_id: asset.id });
        }
      }

      await this.prisma.inbound_events.update({
        where: { id: data.inbound_event_id },
        data: {
          normalized: true,
          status: 'normalized',
          processed_at: new Date(),
        },
      });

      await this.dispatchAgent({
        conversation_id: conversation.id,
        message_id: message.id,
        inbound_event_id: data.inbound_event_id,
        company_id: data.company_id,
        client_id: data.client_id,
        channel_connection_id: data.channel_connection_id,
        origin_channel: data.origin_channel,
        external_user_id: data.external_user_id,
        text: data.text || '',
        request_id: data.request_id,
        metadata: data.metadata,
      });
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  /** Portado 1:1 de AgentProcessor.process — orquestra LLM e encadeia resposta. */
  async processWithAgent(data: AgentJobData): Promise<void> {
    // Se a conversa estiver em modo manual (operador humano), a IA não responde.
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: data.conversation_id },
      select: { mode: true, assigned_to: true },
    });

    if (conversation?.mode === 'manual') {
      this.logger.log(
        {
          conversation_id: data.conversation_id,
          assigned_to: conversation.assigned_to,
        },
        'Conversa em modo manual. IA ignorada.',
      );
      return;
    }

    const lockKey = `lock:agent:${data.conversation_id}`;
    const acquired = await this.redisService.acquireLock(lockKey, 60);
    if (!acquired) {
      throw new ConflictException('Agent processing is locked, will retry');
    }

    // Watchdog: renova o lock durante o processamento — LLM + tools podem
    // exceder o TTL de 60s e sem renovação outro worker processaria a mesma
    // conversa em paralelo (resposta duplicada ao usuário)
    const renewTimer = setInterval(() => {
      void this.redisService.renewLock(lockKey, 60).catch(() => undefined);
    }, 30_000);

    try {
      const result = await this.orchestrationService.processMessage(
        data.conversation_id,
        data.message_id,
        data.company_id,
        data.client_id,
        data.text,
        data.request_id,
      );

      await this.dispatchResponse({
        conversation_id: data.conversation_id,
        message_id: data.message_id,
        company_id: data.company_id,
        client_id: data.client_id,
        channel_connection_id: data.channel_connection_id,
        origin_channel: data.origin_channel,
        external_user_id: data.external_user_id,
        text: result.responseText,
        request_id: data.request_id,
        metadata: {
          ...data.metadata,
          response_message_id: result.responseMessageId,
          inbound_message_id: data.message_id,
        },
      });
    } finally {
      clearInterval(renewTimer);
      await this.redisService.releaseLock(lockKey);
    }
  }

  /** Portado 1:1 de DispatcherProcessor.process. */
  async dispatchResponseCore(data: DispatchJobData): Promise<void> {
    if (data.origin_channel === 'api') {
      await this.channelsService.sendOutbound(
        data.channel_connection_id,
        data.external_user_id,
        data.text,
        {
          ...data.metadata,
          conversation_id: data.conversation_id,
          message_id: data.message_id,
        },
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async waitForConversationLock(
    lockKey: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
      if (await this.redisService.acquireLock(lockKey, ttlSeconds)) {
        return true;
      }
      if (Date.now() + LOCK_WAIT_INTERVAL_MS > deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_INTERVAL_MS));
    }
  }

  /**
   * Execução em background dentro do processo da API. Sem Bull não há retry
   * automático: conflito de lock ganha UMA nova tentativa com atraso e demais
   * erros são registrados como dead-letter no Redis para inspeção.
   */
  private runInline(
    stage: () => Promise<void>,
    meta: InlineMeta & { attempt?: number },
  ): void {
    void (async () => {
      const attempt = meta.attempt ?? 1;
      try {
        await stage();
      } catch (err) {
        if (err instanceof ConflictException && attempt < 2) {
          this.logger.warn(
            { ...meta, attempt },
            'Lock ocupado no modo inline; reagendando tentativa',
          );
          setTimeout(() => {
            this.runInline(stage, { ...meta, attempt: attempt + 1 });
          }, INLINE_RETRY_DELAY_MS);
          return;
        }
        this.logger.error(
          { ...meta, error_message: (err as Error)?.message },
          'Execução inline falhou — registrado em dead-letter inline',
        );
        await this.recordInlineDeadLetter(meta, err).catch(() => undefined);
      }
    })();
  }

  private async recordInlineDeadLetter(
    meta: InlineMeta,
    err: unknown,
  ): Promise<void> {
    const key = `inline-dead-letter:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await this.redisService.set(key, {
      stage: meta.stage,
      client_id: meta.client_id,
      error_message: (err as Error)?.message ?? String(err),
      recorded_at: new Date().toISOString(),
    });
  }

  private async resolveEndUser(data: IngestJobData): Promise<string> {
    const identity = await this.prisma.channel_identities.findFirst({
      where: {
        client_id: data.client_id,
        channel_type: data.origin_channel,
        external_user_id: data.external_user_id,
      },
      include: { end_users: true },
    });

    if (identity) return identity.end_user_id;

    const endUser = await this.prisma.end_users.create({
      data: {
        company_id: data.company_id,
        client_id: data.client_id,
        metadata: (data.metadata || {}) as any,
      },
    });

    await this.prisma.channel_identities.create({
      data: {
        company_id: data.company_id,
        client_id: data.client_id,
        end_user_id: endUser.id,
        channel_type: data.origin_channel,
        external_user_id: data.external_user_id,
        normalized_phone:
          data.origin_channel === 'whatsapp' ? data.external_user_id : null,
      },
    });

    return endUser.id;
  }
}

interface InlineMeta {
  stage: 'ingestion' | 'agent' | 'dispatcher';
  client_id?: string;
}
