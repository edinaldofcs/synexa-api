import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { QueueInfrastructureModule } from '../queue/queue-infrastructure.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { MockEmbeddingProvider } from './providers/mock-embedding.provider';

@Module({
  imports: [CommonModule, QueueInfrastructureModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, MockEmbeddingProvider],
  exports: [KnowledgeService, MockEmbeddingProvider],
})
export class KnowledgeModule {}
