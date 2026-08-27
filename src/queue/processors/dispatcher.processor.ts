import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { DispatchJobData } from '../queue.service';
import { QUEUE_DISPATCHER, JOB_DISPATCH_RESPONSE } from '../queue.constants';
import { TextAiExecutionService } from '../text-ai-execution.service';

@Processor(QUEUE_DISPATCHER)
export class DispatcherProcessor {
  private readonly logger = new Logger(DispatcherProcessor.name);

  constructor(
    private readonly textAiExecutionService: TextAiExecutionService,
  ) {}

  @Process(JOB_DISPATCH_RESPONSE)
  async process(job: Job<DispatchJobData>) {
    const data = job.data;
    this.logger.log(
      {
        conversation_id: data.conversation_id,
        origin_channel: data.origin_channel,
      },
      'Dispatching response',
    );

    await this.textAiExecutionService.dispatchResponseCore(data);
  }
}
