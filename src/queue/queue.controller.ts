import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import {
  QUEUE_DEAD_LETTER,
  QUEUE_INGESTION,
  QUEUE_AGENT,
  QUEUE_DISPATCHER,
  QUEUE_MEDIA,
  QUEUE_KNOWLEDGE,
} from './queue.constants';
import { Roles } from '../common/auth/roles.decorator';
import { RolesGuard } from '../common/auth/roles.guard';
import { ROLES } from '../common/auth/roles.constants';
import { sanitize } from '../common/utils/sanitize-log.util';

@UseGuards(RolesGuard)
@Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
@Controller('admin/queue')
export class QueueController {
  private readonly logger = new Logger(QueueController.name);
  private readonly queues: Map<string, Queue> = new Map();

  constructor(
    @InjectQueue(QUEUE_DEAD_LETTER) private readonly deadLetterQueue: Queue,
    @InjectQueue(QUEUE_INGESTION) ingestionQueue: Queue,
    @InjectQueue(QUEUE_AGENT) agentQueue: Queue,
    @InjectQueue(QUEUE_DISPATCHER) dispatcherQueue: Queue,
    @InjectQueue(QUEUE_MEDIA) mediaQueue: Queue,
    @InjectQueue(QUEUE_KNOWLEDGE) knowledgeQueue: Queue,
  ) {
    this.queues.set(QUEUE_INGESTION, ingestionQueue);
    this.queues.set(QUEUE_AGENT, agentQueue);
    this.queues.set(QUEUE_DISPATCHER, dispatcherQueue);
    this.queues.set(QUEUE_MEDIA, mediaQueue);
    this.queues.set(QUEUE_KNOWLEDGE, knowledgeQueue);
  }

  @Get('dead-letter')
  async listDeadLetter(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    // O wrapper da DLQ (JOB_DEAD_LETTER_STORE) termina no estado 'completed'
    // após o processor persistir em outbox_events — 'failed' quase nunca existe
    const jobs = await this.deadLetterQueue.getJobs(
      ['completed', 'failed'],
      offset || 0,
      (offset || 0) + (limit || 20) - 1,
    );
    const waiting = await this.deadLetterQueue.getWaitingCount();
    const completed = await this.deadLetterQueue.getCompletedCount();
    const failed = await this.deadLetterQueue.getFailedCount();

    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: sanitize(j.data),
        failed_reason: j.failedReason?.slice(0, 200),
        stacktrace: (j.stacktrace || []).slice(0, 3),
        attempts: j.attemptsMade,
        timestamp: j.timestamp,
        finished_on: j.finishedOn,
      })),
      counts: { waiting, failed, completed },
    };
  }

  @Post('dead-letter/:id/retry')
  async retryDeadLetter(@Param('id') id: string) {
    // IDs da Bull são numéricos ("1", "2"...) — ParseUUIDPipe rejeitava todo retry
    const job = await this.deadLetterQueue.getJob(id);
    if (!job) return { error: 'Job not found' };

    const data = job.data as {
      original_queue?: string;
      data?: Record<string, unknown>;
      job_name?: string;
    };
    const originalQueueName = data.original_queue;
    if (!originalQueueName) return { error: 'No original queue info' };

    const originalQueue = this.queues.get(originalQueueName);
    if (!originalQueue)
      return { error: `Original queue '${originalQueueName}' not found` };

    const jobName = data.job_name || 'retry';
    const jobData = data.data || {};

    await originalQueue.add(jobName, jobData);
    await job.remove();

    this.logger.log(
      { dead_letter_id: id, original_queue: originalQueueName },
      'Job retried from DLQ',
    );
    return { retried: true, original_queue: originalQueueName };
  }

  @Post('dead-letter/retry-all')
  async retryAllDeadLetter() {
    const jobs = await this.deadLetterQueue.getJobs(['completed', 'failed']);
    let retried = 0;
    let skipped = 0;

    for (const job of jobs) {
      const data = job.data as {
        original_queue?: string;
        data?: Record<string, unknown>;
        job_name?: string;
      };
      const originalQueueName = data.original_queue;
      if (!originalQueueName) {
        skipped++;
        continue;
      }

      const originalQueue = this.queues.get(originalQueueName);
      if (!originalQueue) {
        skipped++;
        continue;
      }

      const jobName = data.job_name || 'retry';
      const jobData = data.data || {};

      await originalQueue.add(jobName, jobData);
      await job.remove();
      retried++;
    }

    this.logger.log({ retried, skipped }, 'Bulk DLQ retry completed');
    return { retried, skipped };
  }
}
