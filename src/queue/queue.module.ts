import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller';

/**
 * Controllers de administração das filas. Os providers (QueueService,
 * TextAiExecutionService) vivem em QueueInfrastructureModule, que é @Global
 * e portanto visível aqui sem import — evitando o ciclo de módulos
 * ChannelsModule → QueueModule → QueueInfrastructureModule → ChannelsModule.
 */
@Module({
  controllers: [QueueController],
})
export class QueueModule {}
