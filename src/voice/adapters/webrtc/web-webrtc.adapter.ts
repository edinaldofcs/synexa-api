import { WebSocket } from 'ws';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';

export interface WebRtcAdapterOptions {
  /** Identificador da sessão/conversa associada ao socket do navegador. */
  id?: string;
  /** WebSocket já autenticado do ingresso /ws/voice. */
  socket: WebSocket;
  metadata?: TelephonyCallMetadata;
  /** Navegador captura/transmite em 16 kHz (mesmo rate do Audio Gate). */
  sampleRate?: number;
}

/**
 * Adapter do canal Web (navegador/WebRTC do painel) sob o mesmo contrato
 * `ITelephonyAdapter` usado por Asterisk/Twilio/Vonage/CallFlex — o pipeline
 * de áudio (Audio Gate → provider → retorno) passa a ser idêntico ao da
 * telefonia.
 *
 * O ingresso `/ws/voice` mantém a posse do protocolo JSON de controle
 * (start/audio/text/stop) e alimenta o adapter:
 *  - `handleClientAudio(base64)` para cada frame de áudio do usuário;
 *  - o adapter entrega via `onAudio` o PCM 16-bit para o pipeline;
 *  - `sendAudio(pcm16)` devolve o áudio da IA como frame JSON ao navegador.
 */
export class WebRtcAdapter implements ITelephonyAdapter {
  readonly id: string;
  readonly providerName = 'web_webrtc';
  readonly sampleRate: number;
  metadata: TelephonyCallMetadata;

  private readonly socket: WebSocket;
  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private readonly variables = new Map<string, string>();
  private started = false;
  private closedByAdapter = false;

  constructor(options: WebRtcAdapterOptions) {
    this.id =
      options.id ||
      `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.socket = options.socket;
    this.sampleRate = options.sampleRate ?? 16000;
    this.metadata = options.metadata || {};
  }

  /** O socket do navegador já chega aberto pelo ingresso WS. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.socket.readyState === WebSocket.OPEN) {
      this.callStartCallback?.();
    } else {
      this.socket.once('open', () => this.callStartCallback?.());
    }

    this.socket.on('close', (code: number) => {
      this.callEndCallback?.(String(code));
    });
    this.socket.on('error', (err: Error) => {
      this.errorCallback?.(err);
    });
  }

  /** Frame JSON `{type:'audio', data:<base64 PCM 16-bit>}` → pipeline. */
  handleClientAudio(base64Pcm16: string): void {
    if (!base64Pcm16 || !this.audioCallback) return;
    const pcm16 = Buffer.from(base64Pcm16, 'base64');
    if (pcm16.length === 0) return;
    this.audioCallback(pcm16);
  }

  sendAudio(pcm16: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({ type: 'audio', data: pcm16.toString('base64') }),
    );
  }

  setVariable(key: string, value: string): void {
    this.variables.set(key, String(value));
  }

  getVariable(key: string): string | undefined {
    return this.variables.get(key);
  }

  /** Não há transferência de chamada no canal Web. */
  async transferCall(_destination?: string): Promise<boolean> {
    return false;
  }

  onAudio(callback: (pcm16: Buffer) => void): void {
    this.audioCallback = callback;
  }

  onCallStart(callback: () => void): void {
    this.callStartCallback = callback;
  }

  onCallEnd(callback: (reason?: string) => void): void {
    this.callEndCallback = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCallback = callback;
  }

  hangup(reason?: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.closedByAdapter = true;
      this.socket.close(1000, reason || 'hangup');
    }
  }

  /** O playback é client-side; não há fila de áudio no servidor. */
  clearQueuedAudio(): void {
    // no-op: mantido para o contrato uniforme de barge-in
  }

  close(): void {
    if (this.closedByAdapter) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, 'session_closed');
    }
  }
}
