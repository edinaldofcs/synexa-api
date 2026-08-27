import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { QueueService } from './queue.service';
import { TextAiExecutionService } from './text-ai-execution.service';
import {
  QUEUE_INGESTION,
  QUEUE_DISPATCHER,
  QUEUE_AGENT,
  QUEUE_MEDIA,
  QUEUE_KNOWLEDGE,
  QUEUE_WEBHOOK,
  QUEUE_DEAD_LETTER,
} from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );
        return {
          redis: redisUrl,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_INGESTION },
      { name: QUEUE_AGENT },
      { name: QUEUE_DISPATCHER },
      { name: QUEUE_MEDIA },
      { name: QUEUE_KNOWLEDGE },
      { name: QUEUE_WEBHOOK },
      { name: QUEUE_DEAD_LETTER },
    ),
  ],
  providers: [QueueService, TextAiExecutionService],
  exports: [QueueService, TextAiExecutionService, BullModule],
})
export class QueueInfrastructureModule {}
