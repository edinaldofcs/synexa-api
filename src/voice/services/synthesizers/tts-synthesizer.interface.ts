/**
 * Opções de síntese estática para geração de áudio de abertura/cache.
 */
export interface TtsSynthesizeOptions {
  /** Chave de API do provedor (Cartesia, Google, ElevenLabs, etc.) */
  apiKey: string;
  /** Identificador da voz (ID de voz Cartesia, nome de voz Google como Aoede, etc.) */
  voiceId?: string;
  /** Modelo de voz do provedor (ex: sonic-3.6, etc.) */
  modelId?: string;
  /** Taxa de amostragem em Hz (padrão: 24000 Hz) */
  sampleRate?: number;
  /** Idioma da síntese (padrão: 'pt') */
  language?: string;
  /** Config do endpoint BYO do cliente (obrigatória para provider 'custom') */
  customTts?: {
    baseUrl: string;
    apiKey?: string;
    voice?: string;
    sampleRate?: number;
    timeoutMs?: number;
  };
}

/**
 * Contrato de sintetizador TTS para geração sob demanda de áudio completo em PCM Linear 16-bit.
 */
export interface ITtsSynthesizer {
  /** Nome identificador do provedor (ex: 'cartesia', 'google', 'elevenlabs') */
  readonly providerName: string;

  /**
   * Sintetiza o texto completo e retorna o buffer de áudio em PCM Linear 16-bit Mono.
   */
  synthesize(text: string, options: TtsSynthesizeOptions): Promise<Buffer>;
}
