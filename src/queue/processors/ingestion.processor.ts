import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { ConversationsService } from '../../conversations/conversations.service';
import { QueueService, IngestJobData } from '../queue.service';
import { QUEUE_INGESTION, JOB_NORMALIZE_INBOUND } from '../queue.constants';

@Processor(QUEUE_INGESTION)
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly conversationsService: ConversationsService,
    private readonly queueService: QueueService,
  ) {}

  @Process(JOB_NORMALIZE_INBOUND)
  async process(job: Job<IngestJobData>) {
    const data = job.data;
    this.logger.log(
      { inbound_event_id: data.inbound_event_id },
      'Processing inbound event',
    );

    const lockKey = `lock:conversation:${data.client_id}:${data.origin_channel}:${data.external_user_id}`;
    const acquired = await this.redisService.acquireLock(lockKey, 30);
    if (!acquired) {
      this.logger.warn(
        { lockKey },
        'Conversation locked by another job, retrying later',
      );
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

      await this.prisma.inbound_events.update({
        where: { id: data.inbound_event_id },
        data: { status: 'normalized' },
      });

      await this.queueService.addAgentJob({
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

      this.logger.log(
        { conversation_id: conversation.id, message_id: message.id },
        'Ingestion complete, agent processing queued',
      );
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
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
