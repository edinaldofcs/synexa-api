import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { OrchestrationService } from './orchestration.service';
import { CompatibilityService } from './compatibility.service';


@Module({
  imports: [CommonModule, ConversationsModule],
  controllers: [OrchestratorController],
  providers: [
    OrchestratorService,
    OrchestrationService,
    CompatibilityService,
  ],
  exports: [OrchestratorService, OrchestrationService, CompatibilityService],
})
export class OrchestratorModule {}
