import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import {
  JOB_INGEST_KNOWLEDGE_DOCUMENT,
  QUEUE_KNOWLEDGE,
} from '../queue.constants';
import type { KnowledgeJobData } from '../queue.service';

@Processor(QUEUE_KNOWLEDGE)
export class KnowledgeProcessor {
  private readonly logger = new Logger(KnowledgeProcessor.name);

  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Process(JOB_INGEST_KNOWLEDGE_DOCUMENT)
  async process(job: Job<KnowledgeJobData>) {
    this.logger.log(
      { document_id: job.data.document_id },
      'Ingesting knowledge document',
    );
    await this.knowledgeService.ingestDocument(job.data.document_id);
    this.logger.log(
      { document_id: job.data.document_id },
      'Knowledge document ingested',
    );
  }
}
