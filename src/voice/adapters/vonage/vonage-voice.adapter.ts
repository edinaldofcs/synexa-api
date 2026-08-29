import { Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { AudioResampler } from '../../audio/audio-resampler.util';
import { TelephonyOutboundPacer } from '../telephony-outbound-pacer';
import { TelephonyInboundPreBuffer } from '../telephony-inbound-prebuffer';

/**
 * Vonage Voice API — WebSocket bidirecional.
 *
 * O Vonage abre a conexão WebSocket contra o Synexa (NCCO `connect` →
 * `type: "websocket"`), envia eventos JSON texto (`websocket:connected`,
 * `websocket:dtmf`, `websocket:cleared`, `websocket:hangup`) e mídia em
 * frames BINÁRIOS de PCM 16-bit LE na taxa do `content-type` do NCCO
 * (`audio/l16;rate=16000` é o recomendado pela Vonage).
 *
 * Conexão (NCCO):
 *   {
 *     "action": "connect",
 *     "endpoint": [{
 *       "type": "websocket",
 *       "uri": "wss://<host>/ws/dialer?provider=vonage_voice&token=<secret>",
 *       "content-type": "audio/l16;rate=16000",
 *       "headers": { "did": "+55...", "caller": "+55..." }
 *     }]
 *   }
 *
 * Os `headers` do NCCO chegam achatados no topo do evento
 * `websocket:connected` — usados para roteamento (did) e variáveis.
 *
 * Barge-in: `clearQueuedAudio()` envia `{"action":"clear"}` — o Vonage
 * descarta o buffer de reprodução imediatamente (ack: `websocket:cleared`).
 *
 * Hangup: fechar o WS dispara o webhook `disconnected` naVonage; para
 * encerramento "intencional" sem webhook, use a Voice API REST (backlog).
 */
export interface VonageVoiceAdapterConfig {
  wsSocket: WebSocket;
  metadata?: TelephonyCallMetadata;
  /** Taxa do content-type do NCCO (default 16000) */
  sampleRate?: number;
}

export class VonageVoiceAdapter implements ITelephonyAdapter {
  private readonly logger = new Logger(VonageVoiceAdapter.name);

  public readonly providerName = 'vonage_voice';
  public sampleRate: number;
  public readonly metadata: TelephonyCallMetadata;
  public readonly id: string;

  private ws: WebSocket;
  private connected = false;
  private pendingStart = false;
  private identification: { resolve: () => void } | null = null;
  private pacer: TelephonyOutboundPacer;

  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private dtmfCallback: ((digit: string) => void) | null = null;
  private isClosed = false;

  constructor(config: VonageVoiceAdapterConfig) {
    this.ws = config.wsSocket;
    this.sampleRate = config.sampleRate ?? 16000;
    this.id =
      (config.metadata?.uniqueId as string) ||
      `vg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.metadata = { ...config.metadata, uniqueId: this.id };
    this.pacer = this.createPacer();
    this.setupSocket();
  }

  /**
   * Aguarda o evento `websocket:connected` (traz os headers do NCCO).
   * Retorna true se identificado dentro do timeout.
   */
  public async waitForIdentification(timeoutMs = 5000): Promise<boolean> {
    if (this.connected) return true;
    const identified = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.identification = {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
    });
    return identified;
  }

  public async start(): Promise<void> {
    // O callStart dispara no evento websocket:connected; se já chegou
    // antes de session.start(), dispara imediatamente.
    if (this.connected) {
      this.callStartCallback?.();
    } else {
      this.pendingStart = true;
    }
  }

  public sendAudio(pcm24k: Buffer): void {
    if (this.isClosed || !this.connected || !this.isWsOpen()) return;
    this.pacer.enqueue(pcm24k);
  }

  /**
   * Barge-in: descarta o áudio enfileirado local E o buffer de reprodução
   * do Vonage (`{"action":"clear"}`) — a IA para de falar imediatamente.
   */
  public clearQueuedAudio(): void {
    this.pacer.clear();
    this.sendJson({ action: 'clear' });
  }

  public hangup(reason = 'normal_hangup'): void {
    if (this.isClosed) return;
    this.logger.log(`📞 [Vonage] Encerrando stream (${reason})`);
    // Fechar o WS devolve o fluxo ao NCCO (e dispara webhook `disconnected`
    // na Vonage). Hangup direto via REST exige VONAGE_API_KEY/SECRET (backlog).
    this.close();
  }

  public setVariable(key: string, value: string): void {
    if (!this.metadata.customVariables) {
      this.metadata.customVariables = {};
    }
    this.metadata.customVariables[key] = value;
  }

  public getVariable(key: string): string | undefined {
    return (this.metadata.customVariables?.[key] as string) || undefined;
  }

  public onAudio(callback: (pcm16: Buffer) => void): void {
    this.audioCallback = callback;
    // Entrega o áudio bufferizado durante o setup da sessão, em ordem
    this.inboundPreBuffer.drain(callback);
  }

  public onCallStart(callback: () => void): void {
    this.callStartCallback = callback;
  }

  public onCallEnd(callback: (reason?: string) => void): void {
    this.callEndCallback = callback;
  }

  public onError(callback: (err: Error) => void): void {
    this.errorCallback = callback;
  }

  public onDTMF(callback: (digit: string) => void): void {
    this.dtmfCallback = callback;
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pacer.dispose();
    try {
      this.ws.close();
    } catch {
      /* socket já encerrado */
    }
    this.callEndCallback?.('adapter_closed');
  }

  /**
   * Ingestão direta de mensagens do transporte — usada pelo ingresso WS
   * para reproduzir mensagens recebidas antes da criação do adapter.
   */
  public handleRawMessage(data: unknown, isBinary = false): void {
    if (this.isClosed) return;

    if (isBinary && Buffer.isBuffer(data)) {
      this.handleAudio(data);
      return;
    }

    let msg: any;
    try {
      const raw = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.from(String(data));
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    switch (msg?.event) {
      case 'websocket:connected':
        this.handleConnected(msg);
        break;
      case 'websocket:dtmf':
        if (msg.digit) {
          this.dtmfCallback?.(String(msg.digit));
        }
        break;
      case 'websocket:cleared':
        // Ack do {action:"clear"} — nada a fazer
        break;
      case 'websocket:notify':
        // Notificação de buffer esvaziado — log apenas
        break;
      case 'websocket:hangup':
        this.isClosed = true;
        this.pacer.dispose();
        this.callEndCallback?.('vonage_hangup');
        break;
      default:
        // Eventos desconhecidos são ignorados
        break;
    }
  }

  private handleConnected(msg: Record<string, any>): void {
    const contentType = String(msg['content-type'] || '');
    const rate = Number(contentType.match(/rate=(\d+)/)?.[1] ?? 0);
    if (rate && rate !== this.sampleRate) {
      this.logger.log(`📞 [Vonage] Taxa negociada: ${rate} Hz`);
      this.sampleRate = rate;
      this.pacer.dispose();
      this.pacer = this.createPacer();
    }

    // Headers do NCCO chegam achatados no topo do evento
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(msg)) {
      if (key === 'event' || key === 'content-type' || key === 'version') {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number') {
        headers[key] = String(value);
      }
    }

    this.metadata.didNumber =
      headers.did ||
      headers.DID ||
      headers.SYNEXA_DID ||
      (this.metadata.didNumber as string | undefined);
    this.metadata.callerNumber =
      headers.caller ||
      headers['caller-id'] ||
      headers.From ||
      headers.from ||
      (this.metadata.callerNumber as string | undefined);
    this.metadata.customVariables = { ...headers };

    this.logger.log(
      `📞 [Vonage] Stream conectada | rate=${this.sampleRate} | did=${this.metadata.didNumber ?? 'n/d'} | caller=${this.metadata.callerNumber ?? 'n/d'}`,
    );
    this.connected = true;
    this.identification?.resolve();
    this.identification = null;
    if (this.pendingStart) {
      this.pendingStart = false;
      this.callStartCallback?.();
    }
  }

  private handleAudio(raw: Buffer): void {
    // Payload PCM16 LE na taxa negociada → PCM 16k (entrada do Gemini/gate)
    const pcm16k =
      this.sampleRate === 16000
        ? raw
        : AudioResampler.resample(raw, this.sampleRate, 16000);
    if (this.audioCallback) {
      this.audioCallback(pcm16k);
    } else {
      // Sessão ainda não pronta: bufferiza para não perder o "alô"
      this.inboundPreBuffer.push(pcm16k);
    }
  }

  private createPacer(): TelephonyOutboundPacer {
    // Saída: PCM16 na taxa negociada → frames binários direto ao Vonage
    return new TelephonyOutboundPacer((frame) => this.sendAudioFrame(frame), {
      sampleRate: this.sampleRate,
    });
  }

  private sendAudioFrame(frame: Buffer): void {
    if (this.isClosed || !this.isWsOpen()) return;
    try {
      this.ws.send(frame);
    } catch {
      /* socket encerrado entre a checagem e o envio */
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket encerrado entre a checagem e o envio */
    }
  }

  private isWsOpen(): boolean {
    // ws.OPEN === 1
    return (this.ws as { readyState?: number }).readyState === 1;
  }

  private setupSocket(): void {
    if (!this.ws) return;

    this.ws.on('message', (data: unknown, isBinary?: boolean) => {
      // ws v8: (data, isBinary); versões antigas só (data)
      this.handleRawMessage(data, isBinary ?? false);
    });

    this.ws.on('error', (err: Error) => {
      this.logger.warn(`[Vonage] Erro no WebSocket: ${err.message}`);
      this.errorCallback?.(err);
    });

    this.ws.on('close', () => {
      if (!this.isClosed) {
        this.isClosed = true;
        this.pacer.dispose();
        this.callEndCallback?.('socket_closed');
      }
    });
  }

  private inboundPreBuffer = new TelephonyInboundPreBuffer(16000 * 2 * 6);
}
