import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { IntentionsController } from './intentions.controller';
import { IntentionsRepository } from './repositories/intentions.repository';
import { IntentionsService } from './intentions.service';

@Module({
  imports: [CommonModule],
  controllers: [IntentionsController],
  providers: [IntentionsService, IntentionsRepository],
  exports: [IntentionsService, IntentionsRepository],
})
export class IntentionsModule {}
