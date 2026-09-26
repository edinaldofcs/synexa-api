import { AuthModule } from './common/auth/auth.module';
import { MailModule } from './common/mail/mail.module';
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
    MailModule,
    AuthModule.forRoot(),
    VoiceModule,
  ],
})
export class VoiceStandaloneModule {}
