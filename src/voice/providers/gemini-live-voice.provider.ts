import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

export interface GeminiLiveToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

export interface GeminiLiveConnectOptions {
  geminiLive?: unknown;
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

export const VALID_GEMINI_LIVE_VOICES = new Set([
  'Aoede',
  'Charon',
  'Fenrir',
  'Kore',
  'Puck',
  'Leda',
  'Orus',
  'Zephyr',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Callirrhoe',
]);

export function resolveLiveVoice(voice?: string | null): string {
  if (!voice) return 'Aoede';
  const trimmed = voice.trim();
  if (VALID_GEMINI_LIVE_VOICES.has(trimmed)) return trimmed;
  for (const v of VALID_GEMINI_LIVE_VOICES) {
    if (v.toLowerCase() === trimmed.toLowerCase()) return v;
  }
  return 'Aoede';
}

/** Validates the Flow metadata before forwarding any configuration to Google. */
export function resolveGeminiLiveSettings(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const bounded = (
    input: unknown,
    fallback: number,
    min: number,
    max: number,
  ) =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.max(min, Math.min(max, Math.round(input)))
      : fallback;
  return {
    model:
      value.model === 'gemini-3.1-flash-live-preview'
        ? value.model
        : 'gemini-3.8-live',
    voiceName: resolveLiveVoice(
      typeof value.voiceName === 'string' ? value.voiceName : undefined,
    ),
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity:
          value.startSensitivity === 'low'
            ? 'START_SENSITIVITY_LOW'
            : 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity:
          value.endSensitivity === 'low'
            ? 'END_SENSITIVITY_LOW'
            : 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: bounded(value.prefixPaddingMs, 100, 0, 1000),
        silenceDurationMs: bounded(value.silenceDurationMs, 800, 100, 2000),
      },
      activityHandling:
        value.allowInterruption === false
          ? 'NO_INTERRUPTION'
          : 'START_OF_ACTIVITY_INTERRUPTS',
    },
  };
}

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
    const live = resolveGeminiLiveSettings(options.geminiLive);
    const model = live?.model ?? resolveLiveModel(options.model);
    if (!live && options.model && model !== options.model) {
      this.logger.warn(
        `⚠️ [GeminiLive] Modelo "${options.model}" nao suporta bidiGenerateContent (Live); usando "${model}".`,
      );
    }
    const voice = live?.voiceName ?? resolveLiveVoice(options.voiceName);
    if (!live && options.voiceName && voice !== options.voiceName) {
      this.logger.warn(
        `⚠️ [GeminiLive] Voz "${options.voiceName}" nao e suportada pela API Google Live; usando voz segura "${voice}".`,
      );
    }
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

      if (live)
        setupMessage.setup.realtimeInputConfig = live.realtimeInputConfig;

      if (options.contextCompressionEnabled) {
        setupMessage.setup.contextWindowCompression = {
          slidingWindow: {
            targetTokens: options.contextCompressionTargetTokens || 8000,
          },
        };
      }

      if (options.tools && options.tools.length > 0) {
        // Keep the existing sequential tool execution contract on Gemini 3.8.
        setupMessage.setup.tools =
          model === 'gemini-3.8-live'
            ? options.tools.map((group) => ({
                ...group,
                functionDeclarations: group.functionDeclarations.map(
                  (tool) => ({ ...tool, behavior: 'BLOCKING' }),
                ),
              }))
            : options.tools;
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

  public sendAudio(base64Pcm16: string, _sampleRate = 16000): void {
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
        mediaChunks: [
          {
            mimeType: 'audio/pcm',
            data: base64Pcm16,
          },
        ],
      },
    };
    this.ws.send(JSON.stringify(payload));
  }

  public sendAudioStreamEnd(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audioStreamEnd: true,
          },
        }),
      );
      this.ws.send(
        JSON.stringify({
          clientContent: {
            turnComplete: true,
          },
        }),
      );
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

  public setInterruptionBlocked(_blocked: boolean): void {
    // Provedor nativo Gemini Live compat
  }

  public seedGreetingTurn(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && text) {
      const payload = {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `[EVENTO DO SISTEMA: Saudação inicial já reproduzida: "${text}". NÃO fale agora. Aguarde a resposta do usuário.]`,
                },
              ],
            },
          ],
          turnComplete: false,
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
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        try {
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          } else {
            socket.close();
          }
        } catch {
          try {
            socket.terminate();
          } catch {}
        }
      }
    }
    this.isReady = false;
  }
}
