import { Module } from '@nestjs/common';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { TestChatService } from './test-chat.service';
import { CompatibilityService } from './compatibility.service';
import { OrchestrationService } from './orchestration.service';
import { DevOnlyGuard } from '../common/auth/dev-only.guard';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  imports: [ConversationsModule],
  controllers: [OrchestratorController],
  providers: [
    OrchestratorService,
    OrchestrationService,
    TestChatService,
    CompatibilityService,
    DevOnlyGuard,
  ],
  exports: [OrchestratorService, OrchestrationService, TestChatService],
})
export class OrchestratorModule {}
