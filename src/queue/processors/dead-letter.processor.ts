import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUE_DEAD_LETTER, JOB_DEAD_LETTER_STORE } from '../queue.constants';
import { sanitize } from '../../common/utils/sanitize-log.util';

export interface DeadLetterJobData {
  original_queue: string;
  original_job_id: string | number;
  job_name: string;
  data: Record<string, unknown>;
  failed_reason: string;
  failed_stacktrace: string[];
  attempts: number;
  failed_at: string;
}

@Processor(QUEUE_DEAD_LETTER)
export class DeadLetterProcessor {
  private readonly logger = new Logger(DeadLetterProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  @Process(JOB_DEAD_LETTER_STORE)
  async process(job: Job<DeadLetterJobData>) {
    this.logger.warn(
      {
        original_queue: job.data.original_queue,
        original_job_id: job.data.original_job_id,
        reason: job.data.failed_reason,
      },
      'Storing dead-letter job',
    );

    const sanitizedPayload = sanitize(job.data);

    await this.prisma.outbox_events.create({
      data: {
        company_id: '00000000-0000-0000-0000-000000000000',
        aggregate_type: 'dead_letter',
        aggregate_id: String(job.data.original_job_id),
        event_type: `${job.data.original_queue}.failed`,
        payload: sanitizedPayload as any,
        status: 'failed',
        error_message: job.data.failed_reason?.slice(0, 500),
      },
    });

    this.logger.log(
      { original_job_id: job.data.original_job_id },
      'Dead-letter stored',
    );
  }
}
