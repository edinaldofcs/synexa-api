import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { WebhooksService } from './services/webhooks.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [CommonModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}

