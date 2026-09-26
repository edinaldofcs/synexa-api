import { CompanyVoiceQuotaService } from './company-voice-quota.service';
import { InworldVoiceService } from './inworld-voice.service';
import { resolveVoiceFlowSettings } from './voice-flow-settings';
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import {
  GeminiLiveVoiceProvider,
  resolveGeminiLiveSettings,
} from '../providers/gemini-live-voice.provider';
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
import { CustomHttpTtsService } from './custom-http-tts.service';
import { CustomHttpSttService } from './custom-http-stt.service';
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
  private readonly logger = new Logger(VoiceSessionFactory.name);
  @Inject(CompanyVoiceQuotaService)
  private readonly companyQuota: CompanyVoiceQuotaService;
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
    private readonly customHttpTtsService: CustomHttpTtsService,
    private readonly customHttpSttService: CustomHttpSttService,
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
    const defaultEngine =
      (agent?.hybrid_audio_enabled ? 'hybrid' : null) ||
      (this.configService.get<string>('VOICE_PROVIDER') === 'gemini'
        ? 'live_api'
        : null) ||
      'live_api';

    const rawVoiceEngine =
      overrides?.voiceEngine ||
      ((resolveGeminiLiveSettings(clientMeta.gemini_live) ||
        clientMeta.voice_settings ||
        clientMeta.voice_behavior) &&
      (clientMeta.voice_engine === 'hybrid' ||
        clientMeta.voice_engine === 'live_api')
        ? clientMeta.voice_engine
        : undefined) ||
      (agent?.voice_engine as string) ||
      (clientMeta.voice_engine as string) ||
      defaultEngine;

    const voiceEngine =
      rawVoiceEngine === 'gemini' ? 'live_api' : rawVoiceEngine;

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

    // BYO Voice: provedores TTS/STT customizados do cliente (por agente)
    const ttsProviderChoice =
      (clientMeta.tts_provider as string) ||
      (agent.tts_provider as string) ||
      '';
    const sttProviderChoice =
      (clientMeta.stt_provider as string) ||
      (agent.stt_provider as string) ||
      '';
    const ttsProvider: 'cartesia' | 'inworld' | 'custom' =
      ttsProviderChoice === 'inworld'
        ? 'inworld'
        : ttsProviderChoice === 'custom'
          ? 'custom'
          : 'cartesia';
    const sttProvider: 'groq' | 'inworld' | 'custom' =
      sttProviderChoice === 'inworld'
        ? 'inworld'
        : sttProviderChoice === 'custom'
          ? 'custom'
          : 'groq';
    const inworldApiKey =
      ttsProvider === 'inworld' || sttProvider === 'inworld'
        ? await this.keyResolver.resolveApiKey(clientId || '', 'inworld')
        : '';
    if (
      voiceEngine === 'hybrid' &&
      (ttsProvider === 'inworld' || sttProvider === 'inworld') &&
      !inworldApiKey
    )
      throw new Error('Configure a chave Inworld em Provedores.');
    let customTts:
      | {
          baseUrl: string;
          apiKey: string;
          voice?: string;
          sampleRate?: number;
          timeoutMs?: number;
        }
      | undefined;
    let customStt:
      | { baseUrl: string; apiKey: string; timeoutMs?: number }
      | undefined;

    const isUuidVoice =
      resolvedVoiceName &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        resolvedVoiceName.trim(),
      );

    if (voiceEngine === 'hybrid') {
      if (ttsProvider === 'custom' && clientId) {
        const settings = await this.resolveCustomSettings(
          clientId,
          'tts-custom',
        );
        customTts = settings
          ? {
              baseUrl: settings.baseUrl,
              apiKey: settings.apiKey,
              voice: settings.voice,
              sampleRate: settings.sampleRate,
              timeoutMs: settings.timeoutMs,
            }
          : undefined;
        if (!customTts) {
          this.logger.warn(
            `[VoiceSessionFactory] tts_provider=custom mas config 'tts-custom' ausente (clientId=${clientId}). Usando Cartesia.`,
          );
        }
      } else if (ttsProvider === 'cartesia' && !cartesiaApiKey && clientId) {
        cartesiaApiKey = await this.keyResolver.resolveApiKey(
          clientId,
          'cartesia',
        );
      }
      if (sttProvider === 'custom' && clientId) {
        const settings = await this.resolveCustomSettings(
          clientId,
          'stt-custom',
        );
        customStt = settings
          ? {
              baseUrl: settings.baseUrl,
              apiKey: settings.apiKey,
              timeoutMs: settings.timeoutMs,
            }
          : undefined;
      } else if (sttProvider === 'groq' && !groqApiKey && clientId) {
        groqApiKey = await this.keyResolver.resolveApiKey(clientId, 'groq');
      }
      if (ttsProvider !== 'inworld' && !isUuidVoice) {
        resolvedVoiceName = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
      }
      liveProvider = new CascadeVoiceProvider(
        ttsProvider === 'inworld'
          ? new InworldVoiceService()
          : ttsProvider === 'custom' && customTts
            ? this.customHttpTtsService
            : this.cartesiaTtsService,
        sttProvider === 'inworld'
          ? new InworldVoiceService()
          : sttProvider === 'custom' && customStt
            ? this.customHttpSttService
            : this.groqWhisperSttService,
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

    const liveSettings =
      voiceEngine === 'live_api'
        ? resolveGeminiLiveSettings(clientMeta.gemini_live)
        : undefined;
    if (liveSettings) resolvedVoiceName = liveSettings.voiceName;
    const flowVoice = resolveVoiceFlowSettings(clientMeta.voice_settings);
    if (
      voiceEngine === 'hybrid' &&
      ttsProvider === 'cartesia' &&
      flowVoice.cartesiaVoice
    )
      resolvedVoiceName = flowVoice.cartesiaVoice;
    if (customTts && flowVoice.customTtsVoice)
      customTts.voice = flowVoice.customTtsVoice;
    if (voiceEngine === 'hybrid' && ttsProvider === 'inworld')
      resolvedVoiceName =
        clientMeta.tts_provider === 'inworld' ||
        (clientMeta.voice_settings as any)?.inworldVoice
          ? flowVoice.inworldVoice
          : agent.tts_provider === 'inworld' &&
              resolvedVoiceName &&
              !isUuidVoice
            ? resolvedVoiceName
            : 'Mariana';
    const config: VoiceCallSessionConfig = {
      inworldApiKey,
      voiceBehavior:
        clientMeta.voice_behavior as VoiceCallSessionConfig['voiceBehavior'],
      voiceSettings: clientMeta.voice_settings,
      geminiLive:
        voiceEngine === 'live_api' ? clientMeta.gemini_live : undefined,
      ...(overrides || {}),
      companyId,
      clientId,
      agentId: (agent.id as string) || undefined,
      selectedAgent: Object.keys(agent).length ? agent : undefined,
      model:
        liveSettings?.model ||
        overrides?.model ||
        (agent.model as string) ||
        this.configService.get<string>('GEMINI_LIVE_VOICE_MODEL') ||
        undefined,
      voiceName: resolvedVoiceName,
      voiceEngine: voiceEngine as 'hybrid' | 'live_api',
      // Provider efetivo: só é 'custom' quando a config BYO existe
      ttsProvider:
        voiceEngine === 'hybrid' && ttsProvider === 'inworld'
          ? 'inworld'
          : voiceEngine === 'hybrid' && ttsProvider === 'custom' && customTts
            ? 'custom'
            : voiceEngine === 'hybrid'
              ? 'cartesia'
              : 'google',
      sttProvider:
        voiceEngine === 'hybrid' && sttProvider === 'inworld'
          ? 'inworld'
          : voiceEngine === 'hybrid' && sttProvider === 'custom' && customStt
            ? 'custom'
            : 'groq',
      customTts: ttsProvider === 'custom' ? customTts : undefined,
      customStt: sttProvider === 'custom' ? customStt : undefined,
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

    let session: VoiceCallSession | undefined;
    const lease = await this.companyQuota.acquire(companyId, () => {
      void session
        ?.end('capacity_lease_lost')
        .catch(() => this.logger.error('Voice capacity cleanup failed'));
    });
    if (!this.tryAcquireSession(clientId, maxConcurrentCalls)) {
      await lease.release();
      throw new Error('Limite de chamadas simultâneas atingido.');
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseSession(clientId);
      void lease.release();
    };
    try {
      session = new VoiceCallSession({
        telephonyAdapter: adapter,
        liveProvider,
        audioGateService: this.audioGateService,
        pricingService: this.pricingService,
        prisma: this.prisma,
        voiceToolsService: this.voiceToolsService,
        greetingCacheService: this.greetingCacheService,
        config: {
          ...config,
          // Compõe em vez de sobrescrever: o ingresso (AudioSocket/FastAGI) usa
          // onSessionEnd para transmitir o fim visual da chamada ao Flow Studio;
          // o factory precisa também liberar o slot global de sessões.
          onSessionEnd: () => {
            try {
              overrides?.onSessionEnd?.();
            } finally {
              release();
            }
          },
        },
      });

      return { session, liveProvider };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Resolve a config BYO de um provider custom: chave via BYOK/env e
   * não-secretos (baseUrl, voice, sampleRate, timeout) via metadata do cliente.
   */
  private async resolveCustomSettings(
    clientId: string,
    provider: 'tts-custom' | 'stt-custom',
  ): Promise<{
    baseUrl: string;
    apiKey: string;
    voice?: string;
    sampleRate?: number;
    timeoutMs?: number;
  } | null> {
    const apiKey = await this.keyResolver.resolveApiKey(clientId, provider);
    const settings = await this.keyResolver.resolveProviderSettings(
      clientId,
      provider,
    );
    const cfg = (settings || {}) as Record<string, any>;
    const baseUrl = cfg.baseUrl || cfg.base_url;
    if (!baseUrl) return null;
    const sampleRateRaw = cfg.output_sample_rate || cfg.sampleRate;
    const timeoutRaw = cfg.timeout_ms || cfg.timeoutMs;
    return {
      baseUrl: `${baseUrl}`.trim(),
      apiKey,
      voice: cfg.voice ? `${cfg.voice}`.trim() : undefined,
      sampleRate: sampleRateRaw ? Number(sampleRateRaw) : undefined,
      timeoutMs: timeoutRaw ? Number(timeoutRaw) : undefined,
    };
  }
}
