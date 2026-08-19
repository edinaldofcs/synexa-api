import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger, ConflictException } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrchestrationService } from '../../orchestrator/orchestration.service';
import { QueueService, DispatchJobData } from '../queue.service';
import { QUEUE_AGENT, JOB_PROCESS_WITH_AGENT } from '../queue.constants';

interface AgentJobData {
  conversation_id: string;
  message_id: string;
  inbound_event_id: string;
  company_id: string;
  client_id: string;
  channel_connection_id: string;
  origin_channel: string;
  external_user_id: string;
  text: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
}

@Processor(QUEUE_AGENT)
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly orchestrationService: OrchestrationService,
    private readonly queueService: QueueService,
  ) {}

  @Process(JOB_PROCESS_WITH_AGENT)
  async process(job: Job<AgentJobData>) {
    const data = job.data;
    this.logger.log(
      { conversation_id: data.conversation_id, message_id: data.message_id },
      'Processing message with agent',
    );

    // Se a conversa está em modo manual (com operador humano), a IA não deve responder
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
        'Conversa está em modo manual (atendimento humano). Ignorando processamento automático da IA.',
      );
      return;
    }

    const lockKey = `lock:agent:${data.conversation_id}`;
    const acquired = await this.redisService.acquireLock(lockKey, 60);
    if (!acquired) {
      this.logger.warn(
        { conversation_id: data.conversation_id },
        'Agent processing locked by another job, retrying later',
      );
      throw new ConflictException('Agent processing is locked, will retry');
    }

    try {
      const result = await this.orchestrationService.processMessage(
        data.conversation_id,
        data.message_id,
        data.company_id,
        data.client_id,
        data.text,
        data.request_id,
      );

      this.logger.log(
        {
          conversation_id: data.conversation_id,
          response_length: result.responseText.length,
        },
        'Agent processing complete',
      );

      const dispatchData: DispatchJobData = {
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
      };

      await this.queueService.addDispatchJob(dispatchData);
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }
}
