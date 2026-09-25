export interface VoiceProviderToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

export interface CustomTtsConnectConfig {
  baseUrl: string;
  apiKey: string;
  voice?: string;
  sampleRate?: number;
  timeoutMs?: number;
}

export interface CustomSttConnectConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface VoiceProviderConnectOptions {
  geminiLive?: unknown;
  voiceSettings?: unknown;
  apiKey: string;
  inworldApiKey?: string;
  cartesiaApiKey?: string;
  groqApiKey?: string;
  /** 'custom' = TTS BYO via endpoint HTTP do cliente (config em customTts). */
  ttsProvider?: 'cartesia' | 'inworld' | 'custom';
  /** 'custom' = STT BYO via endpoint HTTP do cliente (config em customStt). */
  sttProvider?: 'groq' | 'inworld' | 'custom';
  customTts?: CustomTtsConnectConfig;
  customStt?: CustomSttConnectConfig;
  systemPrompt: string;
  model?: string;
  voiceName?: string;
  thinkingBudget?: number;
  thinkingLevel?: string;
  contextCompressionEnabled?: boolean;
  contextCompressionTargetTokens?: number;
  tools?: { functionDeclarations: VoiceProviderToolDeclaration[] }[];
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
    responseTokenCount?: number;
    thoughtsTokenCount?: number;
    promptTokensDetails?: any[];
    candidatesTokensDetails?: any[];
  }) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface IVoiceProvider {
  readonly ready: boolean;
  readonly droppedAudioFrames?: number;
  connect(options: VoiceProviderConnectOptions): void | Promise<void>;
  sendAudio(base64Pcm16: string, sampleRate?: number): void;
  sendAudioStreamEnd(): void;
  sendText(text: string): void;
  seedGreetingTurn?(text: string): void;
  setInterruptionBlocked?(blocked: boolean): void;
  sendToolResponse(
    functionResponses: {
      name: string;
      id: string;
      response: Record<string, any>;
    }[],
  ): void;
  close(): void;
}
