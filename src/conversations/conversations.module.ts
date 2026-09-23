import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ConversationsRepository } from './repositories/conversations.repository';

import { TabulationService } from './services/tabulation.service';
import { TabulationSchedulerService } from './services/tabulation-scheduler.service';

@Module({
  imports: [CommonModule],
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    ConversationsRepository,
    TabulationService,
    TabulationSchedulerService,
  ],
  exports: [ConversationsService, TabulationService],
})
export class ConversationsModule {}
