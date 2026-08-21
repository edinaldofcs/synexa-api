import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { MockVoiceProvider } from './providers/mock-voice.provider';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';
import { VoiceAuthService } from './voice-auth.service';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { issuer: 'synexa-local', algorithm: 'HS256' as const },
      }),
    }),
  ],
  controllers: [VoiceController],
  providers: [
    VoiceGateway,
    VoiceService,
    MockVoiceProvider,
    ModelPricingService,
    VoiceAuthService,
  ],
  exports: [VoiceService, VoiceGateway, MockVoiceProvider, VoiceAuthService],
})
export class VoiceModule {}
