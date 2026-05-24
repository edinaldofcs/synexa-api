import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { WebhooksService } from './services/webhooks.service';

@Module({
  imports: [CommonModule],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
