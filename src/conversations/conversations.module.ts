import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ConversationsRepository } from './repositories/conversations.repository';
import { OperatorPresenceService } from './operator-presence.service';
import { HandoffDistributorService } from './handoff-distributor.service';

import { TabulationService } from './services/tabulation.service';
import { TabulationSchedulerService } from './services/tabulation-scheduler.service';

@Module({
  imports: [CommonModule],
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    ConversationsRepository,
    OperatorPresenceService,
    HandoffDistributorService,
    TabulationService,
    TabulationSchedulerService,
  ],
  exports: [
    ConversationsService,
    OperatorPresenceService,
    HandoffDistributorService,
    TabulationService,
  ],
})
export class ConversationsModule {}
