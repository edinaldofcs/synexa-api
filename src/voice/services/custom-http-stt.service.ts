import { Injectable, Logger } from '@nestjs/common';
import {
  assertPublicHttpUrl,
  customHttpTimeout,
  MAX_CUSTOM_RESPONSE_BYTES,
} from '../../common/utils/url-guard.util';
import { pcmToWav } from '../../common/utils/pcm-wav.util';

export interface CustomSttCallOptions {
  apiKey: string;
  sampleRate?: number;
  language?: string;
  prompt?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * STT BYO (Bring Your Own): envia o turno completo de fala (PCM 16-bit mono
 * 16kHz fechado pelo VAD) ao endpoint HTTP do cliente em um WAV e espera
 * texto de volta. Satisfaz o mesmo contrato do GroqWhisperSttService
 * (transcribePcm), de modo que o CascadeVoiceProvider funciona com qualquer
 * um dos dois sem saber a diferença.
 *
 * Contrato do endpoint do cliente:
 *   POST {baseUrl}
 *   Headers: Authorization: Bearer {apiKey}, Content-Type: audio/wav
 *   Body: WAV (PCM 16-bit mono 16kHz, turno completo <= ~60s)
 *   Resposta 200: {"text": "..."} (aceita {transcript}|{result}|texto puro)
 */
@Injectable()
export class CustomHttpSttService {
  private readonly logger = new Logger(CustomHttpSttService.name);

  public async transcribePcm(
    pcmBuffer: Buffer,
    options: CustomSttCallOptions,
  ): Promise<string> {
    if (!pcmBuffer || pcmBuffer.length === 0) return '';
    const baseUrl = options.baseUrl || '';
    if (!baseUrl) {
      throw new Error(
        '[CustomHttpSTT] baseUrl obrigatório para provider custom',
      );
    }
    assertPublicHttpUrl(baseUrl, 'STT customizado');

    const sampleRate = options.sampleRate || 16000;
    const wavBuffer = pcmToWav(pcmBuffer, sampleRate, 1, 16);

    const startMs = Date.now();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: new Uint8Array(wavBuffer),
      signal: AbortSignal.timeout(customHttpTimeout(options.timeoutMs)),
    });

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      throw new Error(`STT customizado respondeu ${res.status}: ${errText}`);
    }

    const contentType = res.headers.get('content-type') || '';
    let text = '';
    if (contentType.includes('application/json')) {
      const raw = await res.text();
      if (raw.length > MAX_CUSTOM_RESPONSE_BYTES / 10) {
        throw new Error('STT customizado excedeu o limite de resposta');
      }
      const json = JSON.parse(raw) as {
        text?: string;
        transcript?: string;
        result?: string;
      };
      text = (json.text || json.transcript || json.result || '').trim();
    } else {
      text = (await res.text()).trim();
    }

    this.logger.debug(
      `📝 [CustomHttpSTT] Transcrito em ${Date.now() - startMs}ms: "${text}"`,
    );
    return text;
  }
}
