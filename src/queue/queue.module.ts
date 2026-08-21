import { Module } from '@nestjs/common';
import { QueueInfrastructureModule } from './queue-infrastructure.module';
import { QueueController } from './queue.controller';

@Module({
  imports: [QueueInfrastructureModule],
  controllers: [QueueController],
  exports: [QueueInfrastructureModule],
})
export class QueueModule {}
