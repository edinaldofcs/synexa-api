import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import { GeminiLiveVoiceProvider } from '../providers/gemini-live-voice.provider';
import { CascadeVoiceProvider } from '../providers/cascade-voice.provider';
import { IVoiceProvider } from '../providers/voice-provider.interface';
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
import { CartesiaTtsService } from './cartesia-tts.service';
import { GroqWhisperSttService } from './groq-whisper-stt.service';
import { SileroVadService } from './silero-vad.service';
import { VoiceGreetingCacheService } from './voice-greeting-cache.service';

export type VoiceSessionFactoryDeps = VoiceCallSessionConfig;

export interface SessionSlotCheck {
  allowed: boolean;
  reason?: 'GLOBAL_LIMIT_EXCEEDED' | 'BOT_LIMIT_EXCEEDED';
  currentGlobal: number;
  maxGlobal: number;
  currentBot?: number;
  maxBot?: number | null;
}

/**
 * Cria `VoiceCallSession` preenchendo toda a configuração derivada do banco
 * (agente, gate, chave da IA por tenant). É o único ponto de instanciação
 * da sessão de IA — os ingressos (FastAGI, AudioSocket, WS de discador)
 * apenas entregam um `ITelephonyAdapter`.
 */
@Injectable()
export class VoiceSessionFactory {
  private activeSessions = 0;
  private readonly botActiveSessions = new Map<string, number>();
  private readonly maxSessions: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly audioGateService: AudioGateService,
    private readonly pricingService: ModelPricingService,
    private readonly keyResolver: ProviderKeyResolverService,
    private readonly voiceToolsService: VoiceToolsService,
    private readonly cartesiaTtsService: CartesiaTtsService,
    private readonly groqWhisperSttService: GroqWhisperSttService,
    private readonly sileroVadService: SileroVadService,
    private readonly greetingCacheService?: VoiceGreetingCacheService,
  ) {
    this.maxSessions = this.configService.get<number>('VOICE_MAX_SESSIONS', 50);
  }

  /**
   * Avalia se uma nova sessão pode ser aceita sem incrementar contadores.
   * Suporta teto global (`VOICE_MAX_SESSIONS`) e teto individual por bot (`maxConcurrentCalls`).
   */
  public checkAcquireSession(
    clientId?: string,
    maxConcurrentCalls?: number | null,
  ): SessionSlotCheck {
    if (this.activeSessions >= this.maxSessions) {
      return {
        allowed: false,
        reason: 'GLOBAL_LIMIT_EXCEEDED',
        currentGlobal: this.activeSessions,
        maxGlobal: this.maxSessions,
      };
    }

    if (
      clientId &&
      typeof maxConcurrentCalls === 'number' &&
      maxConcurrentCalls > 0
    ) {
      const currentBot = this.botActiveSessions.get(clientId) || 0;
      if (currentBot >= maxConcurrentCalls) {
        return {
          allowed: false,
          reason: 'BOT_LIMIT_EXCEEDED',
          currentGlobal: this.activeSessions,
          maxGlobal: this.maxSessions,
          currentBot,
          maxBot: maxConcurrentCalls,
        };
      }
    }

    return {
      allowed: true,
      currentGlobal: this.activeSessions,
      maxGlobal: this.maxSessions,
      currentBot: clientId
        ? this.botActiveSessions.get(clientId) || 0
        : undefined,
      maxBot: maxConcurrentCalls,
    };
  }

  /**
   * Tenta adquirir slot de sessão global e por bot (se clientId e maxConcurrentCalls fornecidos).
   * Incrementa contadores atomicamente em caso de sucesso.
   */
  public tryAcquireSession(
    clientId?: string,
    maxConcurrentCalls?: number | null,
  ): boolean {
    const check = this.checkAcquireSession(clientId, maxConcurrentCalls);
    if (!check.allowed) return false;

    this.activeSessions++;
    if (clientId) {
      const currentBot = this.botActiveSessions.get(clientId) || 0;
      this.botActiveSessions.set(clientId, currentBot + 1);
    }
    return true;
  }

  /** Libera o slot da sessão global e decrementa o contador do bot, se aplicável. */
  public releaseSession(clientId?: string): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
    if (clientId) {
      const current = this.botActiveSessions.get(clientId) || 0;
      const next = Math.max(0, current - 1);
      if (next === 0) {
        this.botActiveSessions.delete(clientId);
      } else {
        this.botActiveSessions.set(clientId, next);
      }
    }
  }

  /** Retorna quantidade de sessões ativas (global ou por bot). */
  public getActiveSessionsCount(clientId?: string): number {
    if (clientId) {
      return this.botActiveSessions.get(clientId) || 0;
    }
    return this.activeSessions;
  }

  public async create(
    adapter: ITelephonyAdapter,
    route?: Partial<ResolvedTelephonyRoute> | null,
    overrides?: VoiceSessionFactoryDeps,
  ): Promise<{
    session: VoiceCallSession;
    liveProvider: IVoiceProvider;
  }> {
    const client = (route?.client || {}) as Record<string, any>;
    const agent = (route?.agent || {}) as Record<string, any>;
    const clientId = route?.client_id;
    const companyId = route?.company_id;

    const clientMeta = (client?.metadata as Record<string, unknown>) || {};
    const voiceEngine =
      overrides?.voiceEngine ||
      (agent?.voice_engine as string) ||
      (clientMeta.voice_engine as string) ||
      'hybrid';

    // Chave da IA por tenant (provider_credentials criptografada)
    const tenantGeminiKey = clientId
      ? await this.keyResolver.resolveApiKey(clientId, 'gemini')
      : '';
    const apiKey =
      overrides?.apiKey ||
      tenantGeminiKey ||
      this.configService.get<string>('GEMINI_API_KEY') ||
      '';

    let liveProvider: IVoiceProvider;
    let resolvedVoiceName =
      overrides?.voiceName ||
      (agent.voice_name as string) ||
      (client.voice_name as string) ||
      '';

    let cartesiaApiKey = overrides?.cartesiaApiKey || '';
    let groqApiKey = overrides?.groqApiKey || '';

    const isUuidVoice =
      resolvedVoiceName &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        resolvedVoiceName.trim(),
      );

    if (voiceEngine === 'hybrid') {
      if (!cartesiaApiKey && clientId) {
        cartesiaApiKey = await this.keyResolver.resolveApiKey(
          clientId,
          'cartesia',
        );
      }
      if (!groqApiKey && clientId) {
        groqApiKey = await this.keyResolver.resolveApiKey(clientId, 'groq');
      }
      if (!isUuidVoice) {
        resolvedVoiceName = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
      }
      liveProvider = new CascadeVoiceProvider(
        this.cartesiaTtsService,
        this.groqWhisperSttService,
        this.sileroVadService,
      );
    } else {
      if (!resolvedVoiceName || isUuidVoice) {
        resolvedVoiceName =
          this.configService.get<string>('GEMINI_LIVE_DEFAULT_VOICE') ||
          'Aoede';
      }
      liveProvider = new GeminiLiveVoiceProvider();
    }

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
      voiceName: resolvedVoiceName,
      voiceEngine: voiceEngine as 'hybrid' | 'live_api',
      cartesiaApiKey,
      groqApiKey,
      gateConfig: resolveAudioGateConfig(client),
      channel: overrides?.channel || 'voice_sip',
    };

    const maxConcurrentCalls = (client as any)?.max_concurrent_calls;
    const check = this.checkAcquireSession(clientId, maxConcurrentCalls);
    if (!check.allowed) {
      if (check.reason === 'BOT_LIMIT_EXCEEDED') {
        throw new Error(
          `Limite de chamadas simultâneas atingido para este bot (máximo: ${maxConcurrentCalls})`,
        );
      }
      throw new Error(
        `Limite de sessões de voz simultâneas atingido (VOICE_MAX_SESSIONS=${this.maxSessions})`,
      );
    }

    this.tryAcquireSession(clientId, maxConcurrentCalls);

    const session = new VoiceCallSession({
      telephonyAdapter: adapter,
      liveProvider,
      audioGateService: this.audioGateService,
      pricingService: this.pricingService,
      prisma: this.prisma,
      voiceToolsService: this.voiceToolsService,
      greetingCacheService: this.greetingCacheService,
      config: {
        ...config,
        onSessionEnd: () => this.releaseSession(clientId),
      },
    });

    return { session, liveProvider };
  }
}
