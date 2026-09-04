import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

export interface GeminiLiveToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

export interface GeminiLiveConnectOptions {
  apiKey: string;
  systemPrompt: string;
  model?: string;
  voiceName?: string;
  thinkingBudget?: number;
  thinkingLevel?: string;
  contextCompressionEnabled?: boolean;
  contextCompressionTargetTokens?: number;
  tools?: { functionDeclarations: GeminiLiveToolDeclaration[] }[];
  handshakeTimeoutMs?: number;
  onAudio?: (base64Audio: string) => void;
  onUserTranscript?: (text: string) => void;
  onAiTranscript?: (text: string) => void;
  onToolCall?: (functionCalls: any[]) => void;
  onSetupComplete?: () => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onUsageMetadata?: (metadata: {
    totalTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    promptTokensDetails?: any[];
    candidatesTokensDetails?: any[];
  }) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

const GOOGLE_LIVE_API_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Somente modelos Live (bidiGenerateContent) são aceitos na Live API —
 * ex.: *-live-* e *native-audio*. O campo `model` do agente carrega o
 * modelo de TEXTO (chat) e nunca deve ser repassado ao Live.
 */
export function isLiveCapableModel(model?: string | null): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return (
    normalized.includes('live') ||
    normalized.includes('native-audio') ||
    normalized.includes('native_audio')
  );
}

export function resolveLiveModel(requested?: string | null): string {
  if (isLiveCapableModel(requested)) return requested as string;
  return DEFAULT_LIVE_MODEL;
}

const EXPENSIVE_VOICES_MAP: Record<string, number> = {
  Flare: 1632, // Nota: Flare consome 1632 tokens de audio fixos por turno vs ~241 de outras vozes
};

const DEFAULT_WS_BACKPRESSURE_BYTES = 1048576;
const BACKPRESSURE_LOG_EVERY = 100;

import { IVoiceProvider } from './voice-provider.interface';

export class GeminiLiveVoiceProvider implements IVoiceProvider {
  private readonly logger = new Logger(GeminiLiveVoiceProvider.name);
  private ws: WebSocket | null = null;
  private isReady = false;
  private options: GeminiLiveConnectOptions | null = null;
  private readonly backpressureBytes: number;
  private droppedAudioFramesCount = 0;

  constructor() {
    this.backpressureBytes =
      Number(process.env.VOICE_WS_BACKPRESSURE_BYTES) ||
      DEFAULT_WS_BACKPRESSURE_BYTES;
  }

  /** Frames de áudio descartados por backpressure do WS do Gemini. */
  public get droppedAudioFrames(): number {
    return this.droppedAudioFramesCount;
  }

  public connect(options: GeminiLiveConnectOptions): void {
    this.options = options;
    const model = resolveLiveModel(options.model);
    if (options.model && model !== options.model) {
      this.logger.warn(
        `⚠️ [GeminiLive] Modelo "${options.model}" nao suporta bidiGenerateContent (Live); usando "${model}".`,
      );
    }
    const voice = options.voiceName || 'Kore';
    const handshakeTimeout = options.handshakeTimeoutMs ?? 15000;

    if (!options.apiKey) {
      const err = new Error(
        'GEMINI_API_KEY não informada para o Voice Provider',
      );
      this.logger.error(err.message);
      options.onError?.(err);
      options.onClose?.();
      return;
    }

    if (EXPENSIVE_VOICES_MAP[voice]) {
      this.logger.warn(
        `💸 [GeminiLive] Atenção: a voz '${voice}' consome ~${EXPENSIVE_VOICES_MAP[voice]} tokens fixos de áudio por turno.`,
      );
    }

    const fullUrl = `${GOOGLE_LIVE_API_URL}?key=${options.apiKey}`;
    try {
      this.ws = new WebSocket(fullUrl, {
        handshakeTimeout,
      });
    } catch (e: any) {
      this.logger.error(
        `❌ [GeminiLive] Falha ao instanciar WebSocket: ${e.message}`,
      );
      options.onError?.(e);
      options.onClose?.();
      return;
    }

    this.ws.on('open', () => {
      this.logger.log(
        `✅ [GeminiLive] Conectado ao Google Live API | model=${model} | voice=${voice}`,
      );

      const setupMessage: any = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: options.systemPrompt }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };

      if (options.contextCompressionEnabled) {
        setupMessage.setup.contextWindowCompression = {
          slidingWindow: {
            targetTokens: options.contextCompressionTargetTokens || 8000,
          },
        };
      }

      if (options.tools && options.tools.length > 0) {
        setupMessage.setup.tools = options.tools;
      }

      this.ws?.send(JSON.stringify(setupMessage));
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString());
        this.handleMessage(message);
      } catch (err: any) {
        this.logger.warn(
          `[GeminiLive] Erro ao processar mensagem recebida: ${err.message}`,
        );
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`❌ [GeminiLive] Erro de conexão: ${err.message}`);
      options.onError?.(err);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isReady = false;
      this.logger.log(
        `🔴 [GeminiLive] Conexão encerrada (${code}): ${reason.toString()}`,
      );
      options.onClose?.();
    });
  }

  private handleMessage(message: any): void {
    if (message.setupComplete) {
      this.isReady = true;
      this.logger.log('🎉 [GeminiLive] Handshake & Setup concluído');
      this.options?.onSetupComplete?.();
      return;
    }

    if (message.usageMetadata) {
      this.options?.onUsageMetadata?.(message.usageMetadata);
    }

    const serverContent = message.serverContent;
    if (serverContent) {
      if (serverContent.interrupted) {
        this.logger.debug('⚡ [GeminiLive] Interrupção (barge-in) detectada');
        this.options?.onInterrupted?.();
      }

      const modelTurn = serverContent.modelTurn;
      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          if (part.inlineData?.data) {
            this.options?.onAudio?.(part.inlineData.data);
          }
          if (part.text) {
            this.options?.onAiTranscript?.(part.text);
          }
        }
      }

      if (serverContent.inputTranscription?.text) {
        this.options?.onUserTranscript?.(serverContent.inputTranscription.text);
      }
      if (serverContent.outputTranscription?.text) {
        this.options?.onAiTranscript?.(serverContent.outputTranscription.text);
      }

      if (serverContent.turnComplete) {
        this.options?.onTurnComplete?.();
      }
    }

    if (message.toolCall?.functionCalls) {
      this.logger.log(
        `🔧 [GeminiLive] Tool Call: ${message.toolCall.functionCalls.map((f: any) => f.name).join(', ')}`,
      );
      this.options?.onToolCall?.(message.toolCall.functionCalls);
    }
  }

  public sendAudio(base64Pcm16: string, sampleRate = 16000): void {
    if (this.ws?.readyState !== WebSocket.OPEN || !base64Pcm16) return;
    if (this.ws.bufferedAmount > this.backpressureBytes) {
      this.droppedAudioFramesCount++;
      if (this.droppedAudioFramesCount % BACKPRESSURE_LOG_EVERY === 1) {
        this.logger.warn(
          `[GeminiLive] Backpressure no WS (${this.ws.bufferedAmount}B > ${this.backpressureBytes}B): descartando frame de áudio (${this.droppedAudioFramesCount} descartes)`,
        );
      }
      return;
    }
    const payload = {
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${sampleRate}`,
          data: base64Pcm16,
        },
      },
    };
    this.ws.send(JSON.stringify(payload));
  }

  public sendAudioStreamEnd(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = {
        realtimeInput: {
          audioStreamEnd: true,
        },
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  public sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && text) {
      const payload = {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text }],
            },
          ],
          turnComplete: true,
        },
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  public sendToolResponse(
    functionResponses: {
      name: string;
      id: string;
      response: Record<string, any>;
    }[],
  ): void {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      functionResponses?.length > 0
    ) {
      const payload = {
        toolResponse: {
          functionResponses,
        },
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  public get ready(): boolean {
    return this.isReady && this.ws?.readyState === WebSocket.OPEN;
  }

  public close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.isReady = false;
  }
}
