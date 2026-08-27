import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { IngestJobData } from '../queue.service';
import { QUEUE_INGESTION, JOB_NORMALIZE_INBOUND } from '../queue.constants';
import { TextAiExecutionService } from '../text-ai-execution.service';

@Processor(QUEUE_INGESTION)
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly textAiExecutionService: TextAiExecutionService,
  ) {}

  @Process(JOB_NORMALIZE_INBOUND)
  async process(job: Job<IngestJobData>) {
    const data = job.data;
    this.logger.log(
      { inbound_event_id: data.inbound_event_id },
      'Processing inbound event',
    );

    await this.textAiExecutionService.normalizeInbound(data);
  }
}
