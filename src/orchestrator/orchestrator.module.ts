import { Module } from '@nestjs/common';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { TestChatService } from './test-chat.service';
import { CompatibilityService } from './compatibility.service';
import { OrchestrationService } from './orchestration.service';
import { DevOnlyGuard } from '../common/auth/dev-only.guard';
import { ConversationsModule } from '../conversations/conversations.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MediaModule } from '../media/media.module';
import { AgentConfigResolver } from './services/agent-config-resolver.service';
import { RagSearchService } from './services/rag-search.service';
import { ToolCallDispatcher } from './services/tool-call-dispatcher.service';
import { ProviderKeyResolverService } from './services/provider-key-resolver.service';

import { ModelPricingService } from './services/model-pricing.service';
import { ProviderCircuitBreakerService } from './services/circuit-breaker.service';
import { FallbackProviderService } from './services/fallback-provider.service';

@Module({
  imports: [ConversationsModule, MediaModule, AnalyticsModule],
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
    ProviderKeyResolverService,
    ModelPricingService,
    ProviderCircuitBreakerService,
    FallbackProviderService,
  ],
  exports: [
    OrchestratorService,
    OrchestrationService,
    TestChatService,
    ModelPricingService,
    ProviderCircuitBreakerService,
    FallbackProviderService,
  ],
})
export class OrchestratorModule {}
