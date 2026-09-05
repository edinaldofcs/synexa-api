import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

export interface CartesiaStreamOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  sampleRate?: number;
  language?: string;
}

export interface CartesiaContextCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

const DEFAULT_CARTESIA_VOICE = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
const DEFAULT_CARTESIA_MODEL = 'sonic-3.6';
const CARTESIA_VERSION = '2024-11-13';

/**
 * Serviço de TTS em Tempo Real com Cartesia Sonic via WebSocket bidirecional.
 * Entrega áudio bruto em PCM linear 16-bit com latência de primeiro byte (TTFA) de ~40-80ms.
 */
@Injectable()
export class CartesiaTtsService {
  private readonly logger = new Logger(CartesiaTtsService.name);

  /**
   * Cria uma sessão WebSocket dedicada para uma chamada ou turno de voz.
   */
  public createSession(options: CartesiaStreamOptions) {
    const apiKey = options.apiKey;
    const voiceId = options.voiceId || DEFAULT_CARTESIA_VOICE;
    const modelId = options.modelId || DEFAULT_CARTESIA_MODEL;
    const sampleRate = options.sampleRate || 24000;
    const language = options.language || 'pt';

    const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(
      apiKey,
    )}&cartesia_version=${CARTESIA_VERSION}`;

    const ws = new WebSocket(url, {
      headers: {
        'Cartesia-Version': CARTESIA_VERSION,
      },
    });

    let isConnected = false;
    const activeContexts = new Map<string, CartesiaContextCallbacks>();
    const pendingMessages: string[] = [];

    ws.on('open', () => {
      this.logger.debug(
        `⚡ [CartesiaTTS] WebSocket conectado (modelo: ${modelId}, rate: ${sampleRate}Hz)`,
      );
      isConnected = true;
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        if (msg) ws.send(msg);
      }
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const data = JSON.parse(raw.toString('utf-8'));
        const contextId = data.context_id;
        const callbacks = contextId ? activeContexts.get(contextId) : null;

        if (data.type === 'chunk' && data.data) {
          const pcmChunk = Buffer.from(data.data, 'base64');
          if (callbacks) {
            callbacks.onAudioChunk(pcmChunk);
          }
        } else if (data.type === 'done') {
          if (callbacks?.onDone) {
            callbacks.onDone();
          }
          if (contextId) activeContexts.delete(contextId);
        } else if (data.type === 'error') {
          const errMsg =
            data.error || data.message || 'Erro desconhecido na Cartesia';
          this.logger.error(
            `❌ [CartesiaTTS] Erro no contexto ${contextId}: ${errMsg}`,
          );
          if (callbacks?.onError) {
            callbacks.onError(new Error(errMsg));
          }
          if (contextId) activeContexts.delete(contextId);
        }
      } catch (err: any) {
        this.logger.error(
          `❌ [CartesiaTTS] Falha ao processar mensagem WS: ${err.message}`,
        );
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`❌ [CartesiaTTS] Erro de conexão WS: ${err.message}`);
      for (const [ctxId, cb] of activeContexts) {
        cb.onError?.(err);
      }
      activeContexts.clear();
    });

    ws.on('close', (code, reason) => {
      this.logger.debug(
        `🔌 [CartesiaTTS] WebSocket fechado (código: ${code}, motivo: ${reason || 'normal'})`,
      );
      isConnected = false;
      activeContexts.clear();
      pendingMessages.length = 0;
    });

    const sendPayload = (payload: Record<string, any>) => {
      const json = JSON.stringify(payload);
      if (isConnected && ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      } else {
        pendingMessages.push(json);
      }
    };

    return {
      /**
       * Inicia o envio de um trecho de texto dentro de um contexto.
       */
      pushText: (
        contextId: string,
        transcript: string,
        continueStream: boolean,
        callbacks: CartesiaContextCallbacks,
      ) => {
        activeContexts.set(contextId, callbacks);
        sendPayload({
          context_id: contextId,
          model_id: modelId,
          transcript,
          voice: {
            mode: 'id',
            id: voiceId,
          },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: sampleRate,
          },
          language,
          continue: continueStream,
        });
      },

      /**
       * Notifica a Cartesia que não há mais entradas para este contexto.
       */
      finalizeContext: (contextId: string) => {
        sendPayload({
          context_id: contextId,
          model_id: modelId,
          transcript: '',
          voice: {
            mode: 'id',
            id: voiceId,
          },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: sampleRate,
          },
          language,
          continue: false,
        });
      },

      /**
       * Cancela imediatamente a síntese em andamento (Barge-in).
       */
      cancelContext: (contextId: string) => {
        if (!activeContexts.has(contextId)) {
          return;
        }
        activeContexts.delete(contextId);
        if (ws.readyState === WebSocket.OPEN) {
          sendPayload({
            context_id: contextId,
            cancel: true,
          });
        }
      },

      /**
       * Fecha a sessão WebSocket.
       */
      close: () => {
        activeContexts.clear();
        pendingMessages.length = 0;
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      },
    };
  }
}
