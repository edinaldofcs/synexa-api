import { WebSocket } from 'ws';
import type { AudioGateSession } from '../services/audio-gate.service';
import type { GeminiLiveVoiceProvider } from '../providers/gemini-live-voice.provider';

export interface VoiceAiMessageBuffer {
  messageId: string | null;
  content: string;
  lastPersist: number;
}

export interface VoiceMockSession {
  handleClientMessage: (msg: any) => void;
  close: () => void;
}

/**
 * Estado mutável de uma sessão de voz por conexão WebSocket (navegador).
 * Isola buffers, contadores de telemetria e geração do provider — o
 * VoiceGateway fica responsável apenas por transporte e roteamento.
 */
export class VoiceClientSession {
  clientWs: WebSocket;
  liveProvider: GeminiLiveVoiceProvider | null = null;
  gateSession: AudioGateSession | null = null;
  mockSession?: VoiceMockSession | null = null;
  isReady = false;
  isAiSpeaking = false;
  companyId?: string;
  clientId?: string;
  agentId?: string;
  conversationId?: string;
  startTime = Date.now();
  inputTokens = 0;
  outputTokens = 0;
  totalTokens = 0;
  interruptedCount = 0;
  hybridSttUtterances = 0;
  hybridSttFallbacks = 0;
  aiResponseStarted = false;
  model = 'gemini-3.1-flash-live-preview';
  voiceName = 'Aoede';
  bufferedUserPcm: Buffer[] = [];
  bufferedUserPcmBytes = 0;
  telemetryPersisted = false;
  state: Record<string, unknown> = {};
  providerGeneration = 0;
  /** Acumulador do turno atual da IA para persistir a fala como mensagem única */
  aiMessageBuffer: VoiceAiMessageBuffer | null = null;

  constructor(clientWs: WebSocket) {
    this.clientWs = clientWs;
  }

  /** Incrementa e retorna a geração do provider (invalida callbacks antigos). */
  nextGeneration(): number {
    return ++this.providerGeneration;
  }

  get elapsedSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /** Reinicia o estado para um novo "start" no mesmo socket. */
  beginSession(params: {
    companyId: string;
    agentId?: string;
    state: Record<string, unknown>;
  }): void {
    this.startTime = Date.now();
    this.companyId = params.companyId;
    this.agentId = params.agentId;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.totalTokens = 0;
    this.interruptedCount = 0;
    this.bufferedUserPcm = [];
    this.bufferedUserPcmBytes = 0;
    this.telemetryPersisted = false;
    this.aiResponseStarted = false;
    this.aiMessageBuffer = null;
    this.state = params.state;
    this.nextGeneration();
  }
}

/** Resumo compacto do estado para mensagens de debug no painel. */
export function summarizeState(state: Record<string, unknown>): string {
  const entries = Object.entries(state || {})
    .filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'object') return false;
      if (typeof value === 'string' && value.length > 80) return false;
      return true;
    })
    .filter(
      ([key]) =>
        ![
          'inbound_variable_mapping',
          'activation_rules',
          'llm_providers',
        ].includes(key),
    );
  if (!entries.length) return 'vazio';
  return entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}
