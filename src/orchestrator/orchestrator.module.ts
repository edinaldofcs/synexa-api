import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { OrchestrationService } from './orchestration.service';
import { CompatibilityService } from './compatibility.service';
import { OrchestratorSessionService } from './services/session.service';
import { OrchestratorAgentService } from './services/agent.service';
import { OrchestratorChatService } from './services/chat.service';
import { OrchestratorToolService } from './services/tool.service';
import { OrchestratorToolExecutorService } from './services/tool-executor.service';

@Module({
  imports: [CommonModule, ConversationsModule],
  controllers: [OrchestratorController],
  providers: [
    OrchestratorService,
    OrchestrationService,
    CompatibilityService,
    OrchestratorSessionService,
    OrchestratorAgentService,
    OrchestratorChatService,
    OrchestratorToolService,
    OrchestratorToolExecutorService,
  ],
  exports: [OrchestratorService, OrchestrationService, CompatibilityService],
})
export class OrchestratorModule {}
