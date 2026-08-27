import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { AgentJobData } from '../queue.service';
import { QUEUE_AGENT, JOB_PROCESS_WITH_AGENT } from '../queue.constants';
import { TextAiExecutionService } from '../text-ai-execution.service';

@Processor(QUEUE_AGENT)
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly textAiExecutionService: TextAiExecutionService,
  ) {}

  @Process(JOB_PROCESS_WITH_AGENT)
  async process(job: Job<AgentJobData>) {
    const data = job.data;
    this.logger.log(
      { conversation_id: data.conversation_id, message_id: data.message_id },
      'Processing message with agent',
    );

    await this.textAiExecutionService.processWithAgent(data);
  }
}
