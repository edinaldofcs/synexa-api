import { Injectable, Logger } from '@nestjs/common';
import {
  assertPublicHttpUrl,
  customHttpTimeout,
  MAX_CUSTOM_RESPONSE_BYTES,
} from '../../common/utils/url-guard.util';
import {
  stripWavHeader,
  readWavSampleRate,
} from '../../common/utils/pcm-wav.util';
import { AudioResampler } from '../audio/audio-resampler.util';
import {
  StreamingTtsSession,
  StreamingTtsSessionCallbacks,
  StreamingTtsSessionFactory,
  StreamingTtsSessionOptions,
} from '../providers/custom-voice.types';

interface QueuedPhrase {
  text: string;
  callbacks: StreamingTtsSessionCallbacks;
}

interface CustomContextState {
  queue: QueuedPhrase[];
  processing: boolean;
  controller: AbortController | null;
}

const CANONICAL_SAMPLE_RATE = 24000; // padrão interno do pipeline (48 bytes/ms)

/**
 * TTS BYO (Bring Your Own): chama um endpoint HTTP do cliente, uma request
 * por frase do LLM. Satisfaz o mesmo contrato de sessão da Cartesia
 * (pushText/finalizeContext/cancelContext/close), de modo que o
 * CascadeVoiceProvider funciona com qualquer um dos dois sem saber a diferença.
 *
 * Contrato do endpoint do cliente:
 *   POST {baseUrl}
 *   Headers: Authorization: Bearer {apiKey}
 *   Body JSON: { text, voice?, language?, format: 'pcm_s16le', sample_rate }
 *   Resposta 200: PCM s16le mono bruto (ou WAV — header é removido),
 *                 ou JSON { audio_base64: '...' }
 *
 * Barge-in: cancelContext aborta requests em voo do contexto.
 */
@Injectable()
export class CustomHttpTtsService implements StreamingTtsSessionFactory {
  private readonly logger = new Logger(CustomHttpTtsService.name);

  public createSession(
    options: StreamingTtsSessionOptions,
  ): StreamingTtsSession {
    const baseUrl = options.baseUrl || '';
    if (!baseUrl) {
      throw new Error(
        '[CustomHttpTTS] baseUrl obrigatório para provider custom',
      );
    }
    // Valida SSRF na criação da sessão (falha rápido antes da chamada iniciar)
    assertPublicHttpUrl(baseUrl, 'TTS customizado');

    const apiKey = options.apiKey || '';
    const voice = options.voiceId || '';
    const language = options.language || 'pt';
    const timeoutMs = customHttpTimeout(options.timeoutMs || 10_000);
    const declaredSampleRate =
      options.outputSampleRate || CANONICAL_SAMPLE_RATE;

    const activeContexts = new Map<string, CustomContextState>();

    const processQueue = async (contextId: string) => {
      const state = activeContexts.get(contextId);
      if (!state || state.processing) return;
      state.processing = true;

      while (state.queue.length > 0) {
        const phrase = state.queue.shift()!;
        if (phrase.callbacks == null) continue;

        const controller = new AbortController();
        state.controller = controller;

        try {
          const startMs = Date.now();
          const res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              text: phrase.text,
              voice: voice || undefined,
              language,
              format: 'pcm_s16le',
              sample_rate: declaredSampleRate,
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = (await res.text()).slice(0, 300);
            throw new Error(
              `TTS customizado respondeu ${res.status}: ${errText}`,
            );
          }

          const contentType = res.headers.get('content-type') || '';
          let audioBuffer: Buffer;
          if (contentType.includes('application/json')) {
            const json = (await res.json()) as { audio_base64?: string };
            if (!json.audio_base64) {
              throw new Error('TTS customizado retornou JSON sem audio_base64');
            }
            audioBuffer = Buffer.from(json.audio_base64, 'base64');
          } else {
            const arrayBuffer = await res.arrayBuffer();
            if (arrayBuffer.byteLength > MAX_CUSTOM_RESPONSE_BYTES) {
              throw new Error('TTS customizado excedeu o limite de resposta');
            }
            audioBuffer = Buffer.from(arrayBuffer);
          }

          if (audioBuffer.length === 0) {
            throw new Error('TTS customizado retornou áudio vazio');
          }

          // Normaliza para o pipeline: strip de header WAV + resample p/ 24kHz
          const wavRate = readWavSampleRate(audioBuffer);
          let pcm = stripWavHeader(audioBuffer);
          const sourceRate = wavRate || declaredSampleRate;
          if (sourceRate !== CANONICAL_SAMPLE_RATE) {
            pcm = AudioResampler.resample(
              pcm,
              sourceRate,
              CANONICAL_SAMPLE_RATE,
            );
          }

          this.logger.debug(
            `🎙️ [CustomHttpTTS] Frase sintetizada em ${Date.now() - startMs}ms (${pcm.length} bytes @24kHz)`,
          );
          phrase.callbacks.onAudioChunk(pcm);
          phrase.callbacks.onDone?.();
        } catch (err: any) {
          if (err.name === 'AbortError') {
            this.logger.debug(
              `[CustomHttpTTS] Request abortada por barge-in (contexto ${contextId})`,
            );
          } else {
            this.logger.error(
              `❌ [CustomHttpTTS] Falha na síntese: ${err.message}`,
            );
            phrase.callbacks.onError?.(err);
          }
        } finally {
          state.controller = null;
        }
      }

      state.processing = false;
    };

    return {
      pushText: (
        contextId: string,
        text: string,
        _continueStream: boolean,
        callbacks: StreamingTtsSessionCallbacks,
      ) => {
        if (!text.trim()) return;
        let state = activeContexts.get(contextId);
        if (!state) {
          state = { queue: [], processing: false, controller: null };
          activeContexts.set(contextId, state);
        }
        state.queue.push({ text, callbacks });
        void processQueue(contextId);
      },

      finalizeContext: (contextId: string) => {
        // HTTP batch: cada pushText já despacha sua própria síntese.
        const state = activeContexts.get(contextId);
        if (state && state.queue.length === 0 && !state.processing) {
          activeContexts.delete(contextId);
        }
      },

      cancelContext: (contextId: string) => {
        const state = activeContexts.get(contextId);
        if (!state) return;
        state.queue.length = 0;
        state.controller?.abort();
      },

      close: () => {
        for (const state of activeContexts.values()) {
          state.queue.length = 0;
          state.controller?.abort();
        }
        activeContexts.clear();
      },
    };
  }
}
