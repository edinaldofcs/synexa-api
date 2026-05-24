import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { QueueModule } from '../queue/queue.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './services/channels.service';
import { WhatsappAdapter } from './adapters/whatsapp.adapter';
import { ApiAdapter } from './adapters/api.adapter';

@Module({
  imports: [CommonModule, ConversationsModule, WebhooksModule, forwardRef(() => QueueModule)],
  controllers: [ChannelsController],
  providers: [ChannelsService, WhatsappAdapter, ApiAdapter],
  exports: [ChannelsService],
})
export class ChannelsModule {}
