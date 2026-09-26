import { PromptTemplatesModule } from './prompt-templates/prompt-templates.module';
import { LandingModule } from './landing/landing.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { CommonModule } from './common/common.module';
import { AuthModule } from './common/auth/auth.module';
import { MailModule } from './common/mail/mail.module';
import { AdminModule } from './admin/admin.module';
import { ChatModule } from './chat/chat.module';
import { ClientsModule } from './clients/clients.module';
import { AgentsModule } from './agents/agents.module';
import { TracksModule } from './tracks/tracks.module';
import { ApisModule } from './apis/apis.module';
import { ChannelsModule } from './channels/channels.module';
import { ConversationsModule } from './conversations/conversations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { QueueModule } from './queue/queue.module';
import { MediaModule } from './media/media.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { BillingModule } from './billing/billing.module';
import { SubagentsModule } from './subagents/subagents.module';
import { TelephonyModule } from './telephony/telephony.module';
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
        // Configuravel p/ testes de carga (THROTTLE_LIMIT=10000); prod usa o
        // default 100 req/min por IP.
        ttl: Number(process.env.THROTTLE_TTL_MS || 60000),
        limit: Number(process.env.THROTTLE_LIMIT || 100),
      },
    ]),
    CommonModule,
    MailModule,
    AuthModule.forRoot(),
    AdminModule,
    ChatModule,
    ClientsModule,
    PromptTemplatesModule,
    LandingModule,
    AgentsModule,
    SubagentsModule,
    TracksModule,
    ApisModule,
    ChannelsModule,
    ConversationsModule,
    WebhooksModule,
    QueueModule,
    MediaModule,
    KnowledgeModule,
    OrchestratorModule,
    BillingModule,
    TelephonyModule,
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
