import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CommonModule } from '../common/common.module';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { VoiceAuthService } from './voice-auth.service';
import { MockVoiceProvider } from './providers/mock-voice.provider';
import { AudioGateService } from './services/audio-gate.service';
import { RtpGatewayService } from './telephony/rtp-gateway.service';
import { AsteriskAmiService } from './telephony/asterisk-ami.service';
import { FastAgiServerService } from './telephony/fastagi-server.service';
import { AudioSocketServerService } from './telephony/audiosocket-server.service';
import { DialerWsIngress } from './telephony/dialer-ws.gateway';
import { TelephonyAdapterFactory } from './adapters/telephony-adapter.factory';
import { TelephonyEndpointResolverService } from './services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from './services/voice-session.factory';
import { VoiceTelemetryService } from './services/voice-telemetry.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';
import { VoiceToolsService } from './voice-tools.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { SessionService } from '../common/auth/session.service';

// No standalone (SERVICE_ROLE=voice) o VoiceModule nao passa pelo AppModule,
// que registra o ThrottlerGuard global — aqui registramos o Throttler apenas
// quando standalone para nao duplicar o guard na API principal
const voiceStandalone = process.env.SERVICE_ROLE === 'voice';

@Module({
  imports: [
    CommonModule,
    AnalyticsModule,
    ...(voiceStandalone
      ? [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])]
      : []),
  ],
  controllers: [VoiceController],
  providers: [
    VoiceGateway,
    VoiceService,
    VoiceAuthService,
    SessionService,
    MockVoiceProvider,
    AudioGateService,
    RtpGatewayService,
    AsteriskAmiService,
    FastAgiServerService,
    AudioSocketServerService,
    DialerWsIngress,
    TelephonyAdapterFactory,
    TelephonyEndpointResolverService,
    VoiceSessionFactory,
    VoiceTelemetryService,
    ModelPricingService,
    ProviderKeyResolverService,
    VoiceToolsService,
    ...(voiceStandalone
      ? [
          {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
          },
        ]
      : []),
  ],
  exports: [
    VoiceService,
    VoiceGateway,
    VoiceAuthService,
    MockVoiceProvider,
    AudioGateService,
    RtpGatewayService,
    AsteriskAmiService,
    FastAgiServerService,
    AudioSocketServerService,
    TelephonyAdapterFactory,
    TelephonyEndpointResolverService,
    VoiceSessionFactory,
  ],
})
export class VoiceModule {}
