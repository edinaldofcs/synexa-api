import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChannelsService } from '../../channels/services/channels.service';
import { QueueService, DispatchJobData } from '../queue.service';
import { QUEUE_DISPATCHER, JOB_DISPATCH_RESPONSE } from '../queue.constants';

@Processor(QUEUE_DISPATCHER)
export class DispatcherProcessor {
  private readonly logger = new Logger(DispatcherProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Process(JOB_DISPATCH_RESPONSE)
  async process(job: Job<DispatchJobData>) {
    const data = job.data;
    this.logger.log(
      { conversation_id: data.conversation_id, origin_channel: data.origin_channel },
      'Dispatching response',
    );

    if (data.origin_channel === 'api') {
      await this.channelsService.sendOutbound(
        data.channel_connection_id,
        data.external_user_id,
        data.text,
        {
          ...data.metadata,
          conversation_id: data.conversation_id,
          message_id: data.message_id,
        },
      );
    }

    this.logger.log(
      { conversation_id: data.conversation_id },
      'Dispatch complete',
    );
  }
}
