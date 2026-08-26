import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

export interface SttConfig {
  enabled?: boolean;
  model?: string;
  language?: string;
  rmsThreshold?: number;
  minSpeechMs?: number;
  maxNoSpeech?: number;
  minLogprob?: number;
  timeoutMs?: number;
  apiKey?: string;
}

export interface SttResult {
  text: string;
  noSpeech?: number;
  avgLogprob?: number;
  speechMs?: number;
  isReliable: boolean;
  latencyMs: number;
}

const HALLUCINATION_REGEXES = [
  /obrigad[oa]\s+por\s+(assistir|ver|acompanhar)/i,
  /legendas?\s+(pela|feita|by|da\s+comunidade)/i,
  /amara\.org/i,
  /(se\s+)?inscreva(-se)?\s+no\s+canal/i,
  /at[eé]\s+.{0,8}pr[oó]ximo\s+v[ií]deo/i,
  /compartilh\w*\s+.{0,8}v[ií]deo/i,
];

@Injectable()
export class HybridSttService {
  private readonly logger = new Logger(HybridSttService.name);
  private groqClient: OpenAI | null = null;

  constructor(private readonly configService: ConfigService) {}

  public addWavHeader(pcmBuffer: Buffer, sampleRate = 16000): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // 16-bit mono byte rate
    header.writeUInt16LE(2, 32); // Block align
    header.writeUInt16LE(16, 34); // Bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
  }

  public frameRms(pcm: Buffer, start: number, end: number): number {
    let sum = 0;
    let n = 0;
    for (let i = start; i + 1 < end; i += 2) {
      const s = pcm.readInt16LE(i);
      sum += s * s;
      n++;
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  public trimSilence(
    pcmBuffer: Buffer,
    rmsThreshold = 500,
    sampleRate = 16000,
  ): { pcm: Buffer; speechMs: number } | null {
    const total = pcmBuffer.length;
    const frameMs = 20;
    const frameBytes = Math.round((sampleRate * 2 * frameMs) / 1000); // 640 bytes for 16kHz
    let firstSpeech = -1;
    let lastSpeech = -1;
    let speechFrames = 0;

    for (let offset = 0; offset < total; offset += frameBytes) {
      const end = Math.min(offset + frameBytes, total);
      if (this.frameRms(pcmBuffer, offset, end) >= rmsThreshold) {
        if (firstSpeech < 0) firstSpeech = offset;
        lastSpeech = end;
        speechFrames++;
      }
    }

    if (firstSpeech < 0) {
      return null;
    }

    const speechMs = speechFrames * frameMs;
    const pad = frameBytes * 6; // ~120ms padding
    const start = Math.max(0, firstSpeech - pad);
    const stop = Math.min(total, lastSpeech + pad);

    return {
      pcm: pcmBuffer.subarray(start, stop),
      speechMs,
    };
  }

  public isLikelyHallucination(text: string): boolean {
    const trimmed = (text || '').trim();
    if (!trimmed) return true;
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
    return HALLUCINATION_REGEXES.some((re) => re.test(trimmed));
  }

  public async transcribePcm(
    pcmBuffer: Buffer,
    config?: SttConfig,
  ): Promise<SttResult> {
    const startTime = Date.now();
    const rmsThreshold = config?.rmsThreshold ?? 500;
    const minSpeechMs = config?.minSpeechMs ?? 200;
    const maxNoSpeech = config?.maxNoSpeech ?? 0.6;
    const minLogprob = config?.minLogprob ?? -1.0;

    const trimmed = this.trimSilence(pcmBuffer, rmsThreshold);
    if (!trimmed || trimmed.speechMs < minSpeechMs) {
      return {
        text: '',
        isReliable: false,
        speechMs: trimmed?.speechMs ?? 0,
        latencyMs: Date.now() - startTime,
      };
    }

    const apiKey =
      config?.apiKey ||
      this.configService.get<string>('GROQ_API_KEY') ||
      process.env.GROQ_API_KEY;

    if (!apiKey) {
      this.logger.debug('GROQ_API_KEY não configurada — ignorando STT híbrido');
      return {
        text: '',
        isReliable: false,
        speechMs: trimmed.speechMs,
        latencyMs: Date.now() - startTime,
      };
    }

    if (!this.groqClient) {
      this.groqClient = new OpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
    }

    try {
      const wav = this.addWavHeader(trimmed.pcm, 16000);
      const file = await toFile(wav, 'audio.wav');
      const response: any = await this.groqClient.audio.transcriptions.create(
        {
          model: config?.model || 'whisper-large-v3-turbo',
          file,
          language: config?.language || 'pt',
          temperature: 0,
          response_format: 'verbose_json',
        },
        { timeout: config?.timeoutMs || 15000, maxRetries: 1 },
      );

      const text = (response?.text || '').trim();
      const segments = Array.isArray(response?.segments)
        ? response.segments
        : [];
      const noSpeech = segments.length
        ? Math.max(...segments.map((s: any) => s.no_speech_prob ?? 0))
        : undefined;
      const avgLogprob = segments.length
        ? Math.min(...segments.map((s: any) => s.avg_logprob ?? 0))
        : undefined;

      const isHallucination = this.isLikelyHallucination(text);
      const passesNoSpeech = noSpeech === undefined || noSpeech <= maxNoSpeech;
      const passesLogprob = avgLogprob === undefined || avgLogprob >= minLogprob;

      const isReliable =
        !isHallucination && passesNoSpeech && passesLogprob && text.length > 0;

      const latencyMs = Date.now() - startTime;
      this.logger.log(
        `📝 [HybridStt] (${latencyMs}ms) reliable=${isReliable} text="${text}"`,
      );

      return {
        text,
        noSpeech,
        avgLogprob,
        speechMs: trimmed.speechMs,
        isReliable,
        latencyMs,
      };
    } catch (error: any) {
      this.logger.warn(`❌ [HybridStt] Falha na transcrição Groq: ${error.message}`);
      return {
        text: '',
        isReliable: false,
        speechMs: trimmed.speechMs,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
