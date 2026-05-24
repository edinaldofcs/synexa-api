import { Module, Global, OnModuleInit, Logger, forwardRef } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { CommonModule } from '../common/common.module';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { IngestionProcessor } from './processors/ingestion.processor';
import { DispatcherProcessor } from './processors/dispatcher.processor';
import { AgentProcessor } from './processors/agent.processor';
import { MediaProcessor } from './processors/media.processor';
import { DeadLetterProcessor } from './processors/dead-letter.processor';
import { QUEUE_INGESTION, QUEUE_DISPATCHER, QUEUE_AGENT, QUEUE_MEDIA, QUEUE_KNOWLEDGE, QUEUE_DEAD_LETTER, JOB_DEAD_LETTER_STORE } from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        redis: {
          host: process.env.REDIS_HOST || 'localhost',
          port: Number(process.env.REDIS_PORT) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_INGESTION },
      { name: QUEUE_AGENT },
      { name: QUEUE_DISPATCHER },
      { name: QUEUE_MEDIA },
      { name: QUEUE_KNOWLEDGE },
      { name: QUEUE_DEAD_LETTER },
    ),
    CommonModule,
    forwardRef(() => ChannelsModule),
    ConversationsModule,
    WebhooksModule,
    OrchestratorModule,
  ],
  controllers: [QueueController],
  providers: [
    QueueService,
    IngestionProcessor,
    DispatcherProcessor,
    AgentProcessor,
    MediaProcessor,
    DeadLetterProcessor,
  ],
  exports: [QueueService, BullModule],
})
export class QueueModule implements OnModuleInit {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    @InjectQueue(QUEUE_INGESTION) private readonly ingestionQueue: Queue,
    @InjectQueue(QUEUE_AGENT) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_DISPATCHER) private readonly dispatcherQueue: Queue,
    @InjectQueue(QUEUE_MEDIA) private readonly mediaQueue: Queue,
    @InjectQueue(QUEUE_KNOWLEDGE) private readonly knowledgeQueue: Queue,
    @InjectQueue(QUEUE_DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {}

  async onModuleInit() {
    const queues = [
      { name: QUEUE_INGESTION, queue: this.ingestionQueue },
      { name: QUEUE_AGENT, queue: this.agentQueue },
      { name: QUEUE_DISPATCHER, queue: this.dispatcherQueue },
      { name: QUEUE_MEDIA, queue: this.mediaQueue },
      { name: QUEUE_KNOWLEDGE, queue: this.knowledgeQueue },
    ];

    for (const { name, queue } of queues) {
      queue.on('failed', async (job, err) => {
        const attemptsMade = job.attemptsMade;
        const maxAttempts = job.opts?.attempts || 3;

        if (attemptsMade >= maxAttempts && job.id != null) {
          this.logger.warn(
            { queue: name, job_id: job.id, reason: err.message },
            'Moving job to dead-letter queue',
          );

          try {
            await this.deadLetterQueue.add(JOB_DEAD_LETTER_STORE, {
              original_queue: name,
              original_job_id: job.id,
              job_name: job.name,
              data: job.data,
              failed_reason: err.message,
              failed_stacktrace: err.stack?.split('\n') || [],
              attempts: attemptsMade,
              failed_at: new Date().toISOString(),
            });
          } catch (dlqError) {
            this.logger.error(
              { queue: name, job_id: job.id, error: dlqError },
              'Failed to store dead-letter job',
            );
          }
        }
      });
    }

    this.logger.log('Dead-letter listeners registered for all queues');
  }
}
