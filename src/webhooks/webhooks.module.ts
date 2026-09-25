import { CallExportsService } from './services/call-exports.service';
import { MediaModule } from '../media/media.module';
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { WebhooksService } from './services/webhooks.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [CommonModule, MediaModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, CallExportsService],
  exports: [WebhooksService, CallExportsService],
})
export class WebhooksModule {}
