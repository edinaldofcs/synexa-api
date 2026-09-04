export interface VoiceProviderToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, any>;
}

export interface VoiceProviderConnectOptions {
  apiKey: string;
  cartesiaApiKey?: string;
  groqApiKey?: string;
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
  sendToolResponse(
    functionResponses: {
      name: string;
      id: string;
      response: Record<string, any>;
    }[],
  ): void;
  close(): void;
}
