import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AudioGateConfig {
  enabled?: boolean;
  threshold?: number;
  hangoverMarginMs?: number;
  prerollMs?: number;
  sampleRate?: number;
}

export interface AudioGateStats {
  forwardedBytes: number;
  suppressedBytes: number;
  forwardedAiSpeakingBytes: number;
  forwardedClientTurnBytes: number;
  closes: number;
  forwardedSec: number;
  suppressedSec: number;
}

export class AudioGateSession {
  private readonly logger = new Logger(AudioGateSession.name);

  public enabled: boolean;
  public threshold: number;
  public hangoverMarginMs: number;
  public prerollMs: number;
  public sampleRate: number;

  private isOpen = true;
  private streamEndSent = false;
  private lastVoiceAt = 0;
  private preRollQueue: string[] = [];
  private preRollBytes = 0;

  private stats: AudioGateStats = {
    forwardedBytes: 0,
    suppressedBytes: 0,
    forwardedAiSpeakingBytes: 0,
    forwardedClientTurnBytes: 0,
    closes: 0,
    forwardedSec: 0,
    suppressedSec: 0,
  };

  constructor(config?: AudioGateConfig) {
    this.enabled = config?.enabled ?? true;
    this.threshold = config?.threshold ?? 500;
    this.hangoverMarginMs = config?.hangoverMarginMs ?? 500;
    this.prerollMs = config?.prerollMs ?? 300;
    this.sampleRate = config?.sampleRate ?? 16000;
    this.lastVoiceAt = Date.now();
  }

  public processChunk(
    dataBase64: string,
    isAiSpeaking: boolean,
  ): {
    forwardChunks: string[];
    shouldSendStreamEnd: boolean;
    hasVoice: boolean;
    isGateOpen: boolean;
  } {
    if (!this.enabled || !dataBase64) {
      const approxBytes = dataBase64
        ? Math.floor((dataBase64.length * 3) / 4)
        : 0;
      this.stats.forwardedBytes += approxBytes;
      if (isAiSpeaking) {
        this.stats.forwardedAiSpeakingBytes += approxBytes;
      } else {
        this.stats.forwardedClientTurnBytes += approxBytes;
      }
      return {
        forwardChunks: dataBase64 ? [dataBase64] : [],
        shouldSendStreamEnd: false,
        hasVoice: true,
        isGateOpen: true,
      };
    }

    const approxBytes = Math.floor((dataBase64.length * 3) / 4);
    const now = Date.now();

    // 1. Bypass durante a fala da IA (preserva barge-in nativo)
    if (isAiSpeaking) {
      this.lastVoiceAt = now;
      const chunksToForward: string[] = [];
      if (!this.isOpen) {
        chunksToForward.push(...this.reopen('fala da IA'));
      }
      chunksToForward.push(dataBase64);
      this.stats.forwardedBytes += approxBytes;
      this.stats.forwardedAiSpeakingBytes += approxBytes;

      return {
        forwardChunks: chunksToForward,
        shouldSendStreamEnd: false,
        hasVoice: false,
        isGateOpen: true,
      };
    }

    // 2. Análise de energia RMS sobre o PCM16
    let hasVoice = false;
    try {
      const pcm = Buffer.from(dataBase64, 'base64');
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        const abs = sample < 0 ? -sample : sample;
        if (abs >= this.threshold) {
          hasVoice = true;
          break;
        }
      }
    } catch {
      hasVoice = false;
    }

    // 3. Fala detectada na vez do cliente
    if (hasVoice) {
      this.lastVoiceAt = now;
      const chunksToForward: string[] = [];
      if (!this.isOpen) {
        chunksToForward.push(...this.reopen('fala do cliente'));
      }
      chunksToForward.push(dataBase64);
      this.stats.forwardedBytes += approxBytes;
      this.stats.forwardedClientTurnBytes += approxBytes;

      return {
        forwardChunks: chunksToForward,
        shouldSendStreamEnd: false,
        hasVoice: true,
        isGateOpen: true,
      };
    }

    // 4. Silêncio dentro do hangover timer (mantém envio para fechar turno no Gemini)
    if (now - this.lastVoiceAt <= this.hangoverMarginMs) {
      this.stats.forwardedBytes += approxBytes;
      this.stats.forwardedClientTurnBytes += approxBytes;

      return {
        forwardChunks: [dataBase64],
        shouldSendStreamEnd: false,
        hasVoice: false,
        isGateOpen: true,
      };
    }

    // 5. Hangover vencido: fecha o gate e retém no buffer de pre-roll
    let shouldSendStreamEnd = false;
    if (this.isOpen) {
      this.isOpen = false;
      this.stats.closes++;
      if (!this.streamEndSent) {
        shouldSendStreamEnd = true;
        this.streamEndSent = true;
      }
    }

    this.preRollQueue.push(dataBase64);
    this.preRollBytes += approxBytes;
    this.stats.suppressedBytes += approxBytes;

    // Bytes por ms para PCM16 mono (16kHz = 32 bytes/ms; 24kHz = 48 bytes/ms)
    const bytesPerMs = Math.round((this.sampleRate * 2) / 1000);
    const maxPreRollBytes = bytesPerMs * this.prerollMs;

    while (
      this.preRollBytes > maxPreRollBytes &&
      this.preRollQueue.length > 0
    ) {
      const removed = this.preRollQueue.shift();
      if (removed) {
        this.preRollBytes -= Math.floor((removed.length * 3) / 4);
      }
    }

    return {
      forwardChunks: [],
      shouldSendStreamEnd,
      hasVoice: false,
      isGateOpen: false,
    };
  }

  private reopen(reason: string): string[] {
    this.isOpen = true;
    this.streamEndSent = false;
    const drained: string[] = [];

    if (this.preRollQueue.length > 0) {
      for (const chunk of this.preRollQueue) {
        drained.push(chunk);
      }
      this.stats.suppressedBytes -= this.preRollBytes;
      this.stats.forwardedBytes += this.preRollBytes;
      this.stats.forwardedClientTurnBytes += this.preRollBytes;
      this.preRollQueue = [];
      this.preRollBytes = 0;
    }

    this.logger.debug(`🔊 [AudioGate] Gate reaberto (${reason})`);
    return drained;
  }

  public notifyAiSpeakingChanged(isAiSpeaking: boolean) {
    if (isAiSpeaking) {
      this.lastVoiceAt = Date.now();
      this.isOpen = true;
      this.streamEndSent = false;
    }
  }

  public getStats(): AudioGateStats {
    const bytesPerSec = this.sampleRate * 2; // PCM16 mono = sampleRate * 2 bytes/sec
    const forwardedSec =
      bytesPerSec > 0
        ? Number((this.stats.forwardedBytes / bytesPerSec).toFixed(2))
        : 0;
    const suppressedSec =
      bytesPerSec > 0
        ? Number((this.stats.suppressedBytes / bytesPerSec).toFixed(2))
        : 0;

    return {
      ...this.stats,
      forwardedSec,
      suppressedSec,
    };
  }
}

@Injectable()
export class AudioGateService {
  private readonly logger = new Logger(AudioGateService.name);

  constructor(private readonly configService: ConfigService) {}

  public createSession(customConfig?: AudioGateConfig): AudioGateSession {
    const defaultConfig: AudioGateConfig = {
      enabled:
        customConfig?.enabled ??
        this.configService.get<boolean>('AUDIO_GATE_ENABLED', true),
      threshold:
        customConfig?.threshold ??
        this.configService.get<number>('AUDIO_GATE_THRESHOLD', 500),
      hangoverMarginMs:
        customConfig?.hangoverMarginMs ??
        this.configService.get<number>('AUDIO_GATE_HANGOVER_MARGIN_MS', 500),
      prerollMs:
        customConfig?.prerollMs ??
        this.configService.get<number>('AUDIO_GATE_PREROLL_MS', 300),
      sampleRate: customConfig?.sampleRate ?? 16000,
    };

    return new AudioGateSession(defaultConfig);
  }
}
