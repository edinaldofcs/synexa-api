import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './common/config/env.validation';
import { CommonModule } from './common/common.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.dev', '.env.prod'],
      validate: (config) => validateEnv(config, { forbidUnknown: false }),
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    CommonModule,
    VoiceModule,
  ],
})
export class VoiceStandaloneModule {}
