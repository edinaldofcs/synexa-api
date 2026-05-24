import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { QueueModule } from '../queue/queue.module';
import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';

@Module({
  imports: [CommonModule, QueueModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
