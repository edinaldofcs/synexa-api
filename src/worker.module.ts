import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './common/config/env.validation';
import { CommonModule } from './common/common.module';
import { QueueInfrastructureModule } from './queue/queue-infrastructure.module';
import { QueueProcessorsModule } from './queue/queue-processors.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.dev', '.env.prod'],
      validate: (config) => validateEnv(config, { forbidUnknown: false }),
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    CommonModule,
    QueueInfrastructureModule,
    QueueProcessorsModule.register(process.env.SERVICE_ROLE || 'worker'),
  ],
})
export class WorkerModule {}
