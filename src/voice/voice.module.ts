import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { VoiceAuthService } from './voice-auth.service';
import { MockVoiceProvider } from './providers/mock-voice.provider';
import { AudioGateService } from './services/audio-gate.service';
import { HybridSttService } from './services/hybrid-stt.service';
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

@Module({
  imports: [CommonModule, AnalyticsModule],
  controllers: [VoiceController],
  providers: [
    VoiceGateway,
    VoiceService,
    VoiceAuthService,
    SessionService,
    MockVoiceProvider,
    AudioGateService,
    HybridSttService,
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
  ],
  exports: [
    VoiceService,
    VoiceGateway,
    VoiceAuthService,
    MockVoiceProvider,
    AudioGateService,
    HybridSttService,
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
