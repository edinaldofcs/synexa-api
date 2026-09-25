/**
 * Contratos estruturais para TTS/STT plugáveis no pipeline de voz híbrido.
 * Qualquer implementação (Cartesia, Groq ou endpoint HTTP custom do cliente)
 * deve satisfazer estas assinaturas — o CascadeVoiceProvider não conhece
 * detalhes de provedor.
 */

export interface StreamingTtsSessionCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

export interface StreamingTtsSession {
  pushText: (
    contextId: string,
    text: string,
    continueStream: boolean,
    callbacks: StreamingTtsSessionCallbacks,
  ) => void;
  finalizeContext: (contextId: string) => void;
  cancelContext: (contextId: string) => void;
  close: () => void;
}

export interface StreamingTtsSessionOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  sampleRate?: number;
  language?: string;
  /** Endpoint HTTP custom (BYO). Obrigatório para CustomHttpTtsService. */
  baseUrl?: string;
  /** Taxa de amostragem que o endpoint custom entrega (default 24000). */
  outputSampleRate?: number;
  timeoutMs?: number;
}

export interface StreamingTtsSessionFactory {
  createSession(options: StreamingTtsSessionOptions): StreamingTtsSession;
}

export interface SttTranscribeOptions {
  apiKey: string;
  sampleRate?: number;
  language?: string;
  prompt?: string;
  /** Endpoint HTTP custom (BYO). Obrigatório para CustomHttpSttService. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface SttTranscriber {
  transcribePcm: (
    pcmBuffer: Buffer,
    options: SttTranscribeOptions,
  ) => Promise<string>;
}

/** Config BYO de TTS/STT do cliente (não-secreta vem do metadata; chave do BYOK). */
export interface CustomTtsConfig {
  baseUrl: string;
  apiKey: string;
  voice?: string;
  sampleRate?: number;
  timeoutMs?: number;
}

export interface CustomSttConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Extrai a config não-secreta do provider custom a partir do metadata do
 * cliente (painel_clients.metadata.llm_providers['tts-custom'] / 'stt-custom').
 * Tolerante a camelCase e snake_case.
 */
export function extractCustomVoiceConfig(
  clientMeta: Record<string, unknown> | null | undefined,
  provider: 'tts-custom' | 'stt-custom',
): Record<string, any> | null {
  const providers = (clientMeta as any)?.llm_providers;
  if (!providers || typeof providers !== 'object') return null;
  const config = providers[provider] || providers[provider.replace(/-/g, '_')];
  if (!config || typeof config !== 'object') return null;
  const baseUrl = config.baseUrl || config.base_url;
  return baseUrl ? config : null;
}

export function pickConfig(
  config: Record<string, any> | null,
  ...keys: string[]
): string | undefined {
  if (!config) return undefined;
  for (const key of keys) {
    const value = config[key];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return `${value}`.trim();
    }
  }
  return undefined;
}
