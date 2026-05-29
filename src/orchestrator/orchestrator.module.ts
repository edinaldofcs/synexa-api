import { Module } from '@nestjs/common';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { TestChatService } from './test-chat.service';
import { CompatibilityService } from './compatibility.service';
import { OrchestrationService } from './orchestration.service';
import { DevOnlyGuard } from '../common/auth/dev-only.guard';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentConfigResolver } from './services/agent-config-resolver.service';
import { RagSearchService } from './services/rag-search.service';
import { ToolCallDispatcher } from './services/tool-call-dispatcher.service';

@Module({
  imports: [ConversationsModule],
  controllers: [OrchestratorController],
  providers: [
    OrchestratorService,
    OrchestrationService,
    TestChatService,
    CompatibilityService,
    DevOnlyGuard,
    AgentConfigResolver,
    RagSearchService,
    ToolCallDispatcher,
  ],
  exports: [OrchestratorService, OrchestrationService, TestChatService],
})
export class OrchestratorModule {}
