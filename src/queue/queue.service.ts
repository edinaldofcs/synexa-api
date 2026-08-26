import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import {
  QUEUE_INGESTION,
  QUEUE_AGENT,
  QUEUE_DISPATCHER,
  QUEUE_MEDIA,
  QUEUE_KNOWLEDGE,
  QUEUE_WEBHOOK,
  JOB_NORMALIZE_INBOUND,
  JOB_PROCESS_WITH_AGENT,
  JOB_DISPATCH_RESPONSE,
  JOB_PROCESS_MEDIA,
  JOB_INGEST_KNOWLEDGE_DOCUMENT,
  JOB_DELIVER_WEBHOOK,
} from './queue.constants';

export interface IngestJobData {
  inbound_event_id: string;
  client_id: string;
  company_id: string;
  channel_connection_id: string;
  origin_channel: string;
  external_user_id: string;
  conversation_key?: string;
  message_type: string;
  text?: string;
  parts?: IngestMessagePart[];
  idempotency_key?: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown>;
}

export interface IngestMessagePart {
  type: string;
  text?: string;
  url?: string;
  mime_type?: string;
  file_size?: number;
  checksum?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentJobData {
  conversation_id: string;
  message_id: string;
  inbound_event_id: string;
  company_id: string;
  client_id: string;
  channel_connection_id: string;
  origin_channel: string;
  external_user_id: string;
  text: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
}

export interface DispatchJobData {
  conversation_id: string;
  message_id: string;
  company_id: string;
  client_id: string;
  channel_connection_id: string;
  origin_channel: string;
  external_user_id: string;
  text: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaJobData {
  media_asset_id: string;
}

export interface KnowledgeJobData {
  document_id: string;
}

export interface WebhookJobData {
  delivery_id: string;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUE_INGESTION) private readonly ingestionQueue: Queue,
    @InjectQueue(QUEUE_AGENT) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_DISPATCHER) private readonly dispatcherQueue: Queue,
    @InjectQueue(QUEUE_MEDIA) private readonly mediaQueue: Queue,
    @InjectQueue(QUEUE_KNOWLEDGE) private readonly knowledgeQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOK) private readonly webhookQueue: Queue,
  ) {}

  async addIngestionJob(data: IngestJobData): Promise<string> {
    const job = await this.ingestionQueue.add(JOB_NORMALIZE_INBOUND, data, {
      jobId: data.idempotency_key || undefined,
    });
    this.logger.log(
      { job_id: job.id, inbound_event_id: data.inbound_event_id },
      'Ingestion job queued',
    );
    return String(job.id ?? '');
  }

  async addAgentJob(data: AgentJobData, delayMs?: number): Promise<string> {
    const job = await this.agentQueue.add(JOB_PROCESS_WITH_AGENT, data, {
      delay: delayMs || 0,
    });
    this.logger.log(
      { job_id: job.id, conversation_id: data.conversation_id },
      'Agent job queued',
    );
    return String(job.id ?? '');
  }

  async addDispatchJob(
    data: DispatchJobData,
    delayMs?: number,
  ): Promise<string> {
    const job = await this.dispatcherQueue.add(JOB_DISPATCH_RESPONSE, data, {
      delay: delayMs || 0,
    });
    this.logger.log(
      { job_id: job.id, conversation_id: data.conversation_id },
      'Dispatch job queued',
    );
    return String(job.id ?? '');
  }

  async addMediaJob(data: MediaJobData, delayMs?: number): Promise<string> {
    const job = await this.mediaQueue.add(JOB_PROCESS_MEDIA, data, {
      delay: delayMs || 0,
      jobId: data.media_asset_id,
    });
    this.logger.log(
      { job_id: job.id, media_asset_id: data.media_asset_id },
      'Media job queued',
    );
    return String(job.id ?? '');
  }

  async addKnowledgeJob(
    data: KnowledgeJobData,
    delayMs?: number,
  ): Promise<string> {
    const job = await this.knowledgeQueue.add(
      JOB_INGEST_KNOWLEDGE_DOCUMENT,
      data,
      {
        delay: delayMs || 0,
        jobId: data.document_id,
      },
    );
    this.logger.log(
      { job_id: job.id, document_id: data.document_id },
      'Knowledge job queued',
    );
    return String(job.id ?? '');
  }

  async addWebhookJob(data: WebhookJobData, delayMs = 0): Promise<string> {
    // Single-shot job: retry bookkeeping lives in webhook_deliveries, so a new
    // row (and therefore a new job) is enqueued for every attempt.
    const job = await this.webhookQueue.add(JOB_DELIVER_WEBHOOK, data, {
      delay: Math.max(0, Math.min(delayMs, 60_000)),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    this.logger.log(
      { job_id: job.id, delivery_id: data.delivery_id, delay_ms: delayMs },
      'Webhook delivery queued',
    );
    return String(job.id ?? '');
  }
}
