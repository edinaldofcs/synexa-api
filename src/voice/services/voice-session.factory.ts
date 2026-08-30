import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import { GeminiLiveVoiceProvider } from '../providers/gemini-live-voice.provider';
import {
  VoiceCallSession,
  VoiceCallSessionConfig,
} from '../sessions/voice-call-session';
import { ResolvedTelephonyRoute } from './telephony-endpoint-resolver.service';
import { AudioGateService } from './audio-gate.service';
import { VoiceToolsService } from '../voice-tools.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';
import { ProviderKeyResolverService } from '../../orchestrator/services/provider-key-resolver.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveAudioGateConfig } from './voice-runtime.util';

export type VoiceSessionFactoryDeps = VoiceCallSessionConfig;

/**
 * Cria `VoiceCallSession` preenchendo toda a configuração derivada do banco
 * (agente, gate, chave da IA por tenant). É o único ponto de instanciação
 * da sessão de IA — os ingressos (FastAGI, AudioSocket, WS de discador)
 * apenas entregam um `ITelephonyAdapter`.
 */
@Injectable()
export class VoiceSessionFactory {
  private activeSessions = 0;
  private readonly maxSessions: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly audioGateService: AudioGateService,
    private readonly pricingService: ModelPricingService,
    private readonly keyResolver: ProviderKeyResolverService,
    private readonly voiceToolsService: VoiceToolsService,
  ) {
    this.maxSessions = this.configService.get<number>('VOICE_MAX_SESSIONS', 50);
  }

  /** Semáforo global de sessões de voz (web + telefonia) — env VOICE_MAX_SESSIONS. */
  public tryAcquireSession(): boolean {
    if (this.activeSessions >= this.maxSessions) return false;
    this.activeSessions++;
    return true;
  }

  public releaseSession(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  public async create(
    adapter: ITelephonyAdapter,
    route?: Partial<ResolvedTelephonyRoute> | null,
    overrides?: VoiceSessionFactoryDeps,
  ): Promise<{
    session: VoiceCallSession;
    liveProvider: GeminiLiveVoiceProvider;
  }> {
    const client = (route?.client || {}) as Record<string, any>;
    const agent = (route?.agent || {}) as Record<string, any>;
    const clientId = route?.client_id;
    const companyId = route?.company_id;

    // Chave da IA por tenant (provider_credentials criptografada), caindo
    // para a env apenas como último recurso.
    const tenantKey = clientId
      ? await this.keyResolver.resolveApiKey(clientId, 'gemini')
      : '';
    const apiKey =
      overrides?.apiKey ||
      tenantKey ||
      this.configService.get<string>('GEMINI_API_KEY') ||
      '';

    const config: VoiceCallSessionConfig = {
      ...(overrides || {}),
      companyId,
      clientId,
      agentId: (agent.id as string) || undefined,
      selectedAgent: Object.keys(agent).length ? agent : undefined,
      model:
        overrides?.model ||
        (agent.model as string) ||
        this.configService.get<string>('GEMINI_LIVE_VOICE_MODEL') ||
        undefined,
      voiceName:
        overrides?.voiceName ||
        (agent.voice_name as string) ||
        (client.voice_name as string) ||
        this.configService.get<string>('GEMINI_LIVE_DEFAULT_VOICE') ||
        'Aoede',
      gateConfig: resolveAudioGateConfig(client),
      channel: overrides?.channel || 'voice_sip',
    };

    if (!this.tryAcquireSession()) {
      throw new Error(
        `Limite de sessões de voz simultâneas atingido (VOICE_MAX_SESSIONS=${this.maxSessions})`,
      );
    }

    const liveProvider = new GeminiLiveVoiceProvider();
    const session = new VoiceCallSession({
      telephonyAdapter: adapter,
      liveProvider,
      audioGateService: this.audioGateService,
      pricingService: this.pricingService,
      prisma: this.prisma,
      voiceToolsService: this.voiceToolsService,
      config: {
        ...config,
        onSessionEnd: () => this.releaseSession(),
      },
    });

    return { session, liveProvider };
  }
}
