import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { QueueModule } from '../queue/queue.module';
import { KnowledgeProcessor } from '../queue/processors/knowledge.processor';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [CommonModule, QueueModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeProcessor],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
