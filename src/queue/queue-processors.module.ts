import {
  Module,
  OnModuleInit,
  Logger,
  forwardRef,
  DynamicModule,
  Provider,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { CommonModule } from '../common/common.module';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { WebSearchModule } from '../agents/web-search/web-search.module';
import { MediaModule } from '../media/media.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { QueueInfrastructureModule } from './queue-infrastructure.module';
import { IngestionProcessor } from './processors/ingestion.processor';
import { DispatcherProcessor } from './processors/dispatcher.processor';
import { AgentProcessor } from './processors/agent.processor';
import { MediaProcessor } from './processors/media.processor';
import { KnowledgeProcessor } from './processors/knowledge.processor';
import { DeadLetterProcessor } from './processors/dead-letter.processor';
import {
  QUEUE_INGESTION,
  QUEUE_DISPATCHER,
  QUEUE_AGENT,
  QUEUE_MEDIA,
  QUEUE_KNOWLEDGE,
  QUEUE_DEAD_LETTER,
  JOB_DEAD_LETTER_STORE,
} from './queue.constants';
import { sanitize } from '../common/utils/sanitize-log.util';
import { getSourceQueuesForRole } from './queue-role.util';

@Module({})
export class QueueProcessorsModule implements OnModuleInit {
  private readonly logger = new Logger(QueueProcessorsModule.name);

  constructor(
    @InjectQueue(QUEUE_INGESTION) private readonly ingestionQueue: Queue,
    @InjectQueue(QUEUE_AGENT) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_DISPATCHER) private readonly dispatcherQueue: Queue,
    @InjectQueue(QUEUE_MEDIA) private readonly mediaQueue: Queue,
    @InjectQueue(QUEUE_KNOWLEDGE) private readonly knowledgeQueue: Queue,
    @InjectQueue(QUEUE_DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {}

  static register(serviceRole: string = 'worker'): DynamicModule {
    const providers: Provider[] = [];

    const role = serviceRole.toLowerCase();
    const sourceQueues = new Set(getSourceQueuesForRole(role));

    if (role === 'worker' || role === 'worker-all') {
      providers.push(
        IngestionProcessor,
        DispatcherProcessor,
        AgentProcessor,
        MediaProcessor,
        KnowledgeProcessor,
        DeadLetterProcessor,
      );
    } else {
      if (role === 'worker-ingestion') providers.push(IngestionProcessor);
      if (role === 'worker-agent') providers.push(AgentProcessor);
      if (role === 'worker-dispatcher') providers.push(DispatcherProcessor);
      if (role === 'worker-media') providers.push(MediaProcessor);
      if (role === 'worker-knowledge') providers.push(KnowledgeProcessor);
      if (role === 'worker-dlq') providers.push(DeadLetterProcessor);
    }

    const imports: DynamicModule['imports'] = [
      CommonModule,
      QueueInfrastructureModule,
    ];

    if (sourceQueues.has(QUEUE_INGESTION)) {
      imports.push(ConversationsModule);
    }
    if (sourceQueues.has(QUEUE_AGENT)) {
      imports.push(OrchestratorModule, WebSearchModule);
    }
    if (sourceQueues.has(QUEUE_DISPATCHER)) {
      imports.push(forwardRef(() => ChannelsModule));
    }
    if (sourceQueues.has(QUEUE_MEDIA)) {
      imports.push(MediaModule);
    }
    if (sourceQueues.has(QUEUE_KNOWLEDGE)) {
      imports.push(KnowledgeModule);
    }

    return {
      module: QueueProcessorsModule,
      imports,
      providers,
      exports: providers,
    };
  }

  async onModuleInit() {
    const queues = [
      { name: QUEUE_INGESTION, queue: this.ingestionQueue },
      { name: QUEUE_AGENT, queue: this.agentQueue },
      { name: QUEUE_DISPATCHER, queue: this.dispatcherQueue },
      { name: QUEUE_MEDIA, queue: this.mediaQueue },
      { name: QUEUE_KNOWLEDGE, queue: this.knowledgeQueue },
    ].filter(({ name }) =>
      getSourceQueuesForRole(process.env.SERVICE_ROLE || 'worker').includes(
        name,
      ),
    );

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
              data: sanitize(job.data),
              failed_reason: err.message,
              failed_stacktrace: (err.stack?.split('\n') || []).slice(0, 5),
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

    this.logger.log('Dead-letter listeners registered for active queues');
  }
}
