import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { CommonModule } from './common/common.module';
import { AuthModule } from './common/auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { TablesModule } from './tables/tables.module';
import { ChatModule } from './chat/chat.module';
import { ClientsModule } from './clients/clients.module';
import { AgentsModule } from './agents/agents.module';
import { IntentionsModule } from './intentions/intentions.module';
import { ApisModule } from './apis/apis.module';
import { AuditModule } from './audit/audit.module';
import { ChannelsModule } from './channels/channels.module';
import { ObservabilityModule } from './observability/observability.module';
import { ConversationsModule } from './conversations/conversations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { QueueModule } from './queue/queue.module';
import { MediaModule } from './media/media.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { WebSearchModule } from './agents/web-search/web-search.module';
import { ImportsModule } from './imports/imports.module';
import { BillingModule } from './billing/billing.module';
import { SubagentsModule } from './subagents/subagents.module';
import { WorkflowVersionsModule } from './workflow-versions/workflow-versions.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.dev', '.env.prod'],
      validate: (config) => validateEnv(config, { forbidUnknown: false }),
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    CommonModule,
    AuthModule.forRoot(),
    AdminModule,
    TablesModule,
    ChatModule,
    ClientsModule,
    AgentsModule,
    SubagentsModule,
    WorkflowVersionsModule,
    IntentionsModule,
    ApisModule,
    AuditModule,
    ChannelsModule,
    ObservabilityModule,
    ConversationsModule,
    WebhooksModule,
    QueueModule,
    MediaModule,
    KnowledgeModule,
    OrchestratorModule,
    WebSearchModule,
    ImportsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
