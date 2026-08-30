import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { QUEUE_WEBHOOK, JOB_DELIVER_WEBHOOK } from '../queue.constants';
import type { WebhookJobData } from '../queue.service';
import { WebhooksService } from '../../webhooks/services/webhooks.service';

@Processor(QUEUE_WEBHOOK)
@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  @Process({
    name: JOB_DELIVER_WEBHOOK,
    concurrency: Number(process.env.WORKER_WEBHOOK_CONCURRENCY) || 4,
  })
  async process(job: Job<WebhookJobData>): Promise<void> {
    const { delivery_id: deliveryId } = job.data;
    this.logger.log({ delivery_id: deliveryId }, 'Delivering webhook');
    await this.webhooksService.processRetry(deliveryId);
  }
}
