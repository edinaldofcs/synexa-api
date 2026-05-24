import { Controller, Get, Post, Param, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { QUEUE_DEAD_LETTER } from './queue.constants';

@Controller('admin/queue')
export class QueueController {
  constructor(
    @InjectQueue(QUEUE_DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {}

  @Get('dead-letter')
  async listDeadLetter(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    const jobs = await this.deadLetterQueue.getJobs(['failed'], offset || 0, (offset || 0) + (limit || 20) - 1);
    const waiting = await this.deadLetterQueue.getWaitingCount();
    const failed = await this.deadLetterQueue.getFailedCount();

    return {
      jobs: jobs.map(j => ({
        id: j.id,
        name: j.name,
        data: j.data,
        failed_reason: j.failedReason,
        stacktrace: j.stacktrace,
        attempts: j.attemptsMade,
        timestamp: j.timestamp,
        finished_on: j.finishedOn,
      })),
      counts: { waiting, failed },
    };
  }

  @Post('dead-letter/:id/retry')
  async retryDeadLetter(@Param('id') id: string) {
    const job = await this.deadLetterQueue.getJob(id);
    if (!job) return { error: 'Job not found' };

    const data = job.data as { original_queue?: string; data?: Record<string, unknown> };
    if (!data.original_queue) return { error: 'No original queue info' };

    await job.remove();
    return { retried: true, original_queue: data.original_queue };
  }

  @Post('dead-letter/retry-all')
  async retryAllDeadLetter() {
    const jobs = await this.deadLetterQueue.getJobs(['failed']);
    let retried = 0;

    for (const job of jobs) {
      const data = job.data as { original_queue?: string };
      if (data.original_queue) {
        await job.remove();
        retried++;
      }
    }

    return { retried };
  }
}
