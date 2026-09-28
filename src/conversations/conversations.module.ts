import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ConversationsRepository } from './repositories/conversations.repository';

@Module({
  imports: [CommonModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationsRepository],
  exports: [ConversationsService],
})
export class ConversationsModule {}
