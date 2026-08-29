import { Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { AudioResampler } from '../../audio/audio-resampler.util';
import { G711Codec } from '../../audio/g711-codec.util';
import { TelephonyOutboundPacer } from '../telephony-outbound-pacer';
import { TelephonyInboundPreBuffer } from '../telephony-inbound-prebuffer';

/**
 * Twilio Media Streams (bidirectional).
 *
 * O Twilio abre a conexão WebSocket contra o Synexa (`<Connect><Stream>`),
 * envia eventos JSON (`start`/`media`/`dtmf`/`stop`) com mídia µ-law 8kHz
 * em base64 e recebe de volta `{event:'media', media:{payload}}`.
 *
 * Conexão (TwiML):
 *   wss://<host>/ws/dialer?provider=twilio_media_streams&token=<secret>
 * Routing: telephony_endpoints via token (inbound_secret_hash) e/ou o
 * customParameter `did` configurado no TwiML.
 *
 * Observação: Media Streams não encerra a chamada — o hangup fecha o WS e o
 * controle volta ao TwiML (configure `<Hangup/>` no `action` do `<Connect>`).
 */
export interface TwilioMediaStreamsAdapterConfig {
  wsSocket: WebSocket;
  metadata?: TelephonyCallMetadata;
}

export class TwilioMediaStreamsAdapter implements ITelephonyAdapter {
  private readonly logger = new Logger(TwilioMediaStreamsAdapter.name);

  public readonly providerName = 'twilio_media_streams';
  public readonly sampleRate = 8000;
  public readonly metadata: TelephonyCallMetadata;
  public readonly id: string;

  private ws: WebSocket;
  private streamSid: string | undefined;
  private pendingStart = false;
  private identification: { resolve: () => void } | null = null;
  private readonly pacer = new TelephonyOutboundPacer((frame) =>
    this.sendMediaFrame(frame),
  );
  /** Áudio do caller que chega antes da sessão estar pronta (~1-2s) */
  private readonly inboundPreBuffer = new TelephonyInboundPreBuffer(
    16000 * 2 * 6,
  );

  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private dtmfCallback: ((digit: string) => void) | null = null;
  private isClosed = false;

  constructor(config: TwilioMediaStreamsAdapterConfig) {
    this.ws = config.wsSocket;
    this.id =
      (config.metadata?.uniqueId as string) ||
      `tw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.metadata = { ...config.metadata, uniqueId: this.id };
    this.setupSocket();
  }

  /**
   * Aguarda o evento `start` do Twilio (streamSid/customParameters) antes
   * de rotear a chamada. Retorna true se identificado dentro do timeout.
   */
  public async waitForIdentification(timeoutMs = 5000): Promise<boolean> {
    if (this.streamSid) return true;
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
    // O callStart dispara no evento 'start' do Twilio; se a stream já
    // chegou antes de session.start(), dispara imediatamente.
    if (this.streamSid) {
      this.callStartCallback?.();
    } else {
      this.pendingStart = true;
    }
  }

  public sendAudio(pcm24k: Buffer): void {
    if (this.isClosed || !this.streamSid || !this.isWsOpen()) return;
    this.pacer.enqueue(pcm24k);
  }

  /**
   * Barge-in: descarta o áudio enfileirado local E o buffer do Twilio
   * (`{event:'clear'}`) — a IA para de falar imediatamente.
   */
  public clearQueuedAudio(): void {
    this.pacer.clear();
    if (this.streamSid) {
      this.sendJson({ event: 'clear', streamSid: this.streamSid });
    }
  }

  public hangup(reason = 'normal_hangup'): void {
    if (this.isClosed) return;
    this.logger.log(`📞 [Twilio] Encerrando stream (${reason})`);
    // Media Streams não encerra a chamada telefônica: fechar o WS devolve
    // o fluxo ao TwiML (action do <Connect>). Para hangup direto via REST,
    // configure TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN e use a Calls API.
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

  private setupSocket(): void {
    if (!this.ws) return;

    this.ws.on('message', (data: unknown) => {
      this.handleRawMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      this.logger.warn(`[Twilio] Erro no WebSocket: ${err.message}`);
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

  /**
   * Ingestão direta de mensagens do transporte — usada pelo ingresso WS
   * para reproduzir mensagens recebidas antes da criação do adapter.
   */
  public handleRawMessage(data: unknown): void {
    if (this.isClosed) return;
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
      case 'connected':
        // Handshake inicial do Twilio (protocol Call) — nada a fazer
        break;
      case 'start':
        this.handleStart(msg.start || {});
        break;
      case 'media':
        this.handleMedia(msg.media);
        break;
      case 'dtmf':
        if (msg.dtmf?.digit) {
          this.dtmfCallback?.(String(msg.dtmf.digit));
        }
        break;
      case 'mark':
        // Confirmação de reprodução de mark — log apenas
        break;
      case 'stop':
        this.logger.log(
          `📞 [Twilio] Stream encerrada pelo Twilio (${msg.stop?.reason ?? 'n/d'})`,
        );
        this.isClosed = true;
        this.pacer.dispose();
        this.callEndCallback?.('twilio_stream_stop');
        break;
      case 'errors':
        this.errorCallback?.(
          new Error(`Twilio stream error: ${JSON.stringify(msg.errors ?? [])}`),
        );
        break;
      default:
        // Eventos desconhecidos são ignorados
        break;
    }
  }

  private handleStart(start: Record<string, any>): void {
    this.streamSid = start.streamSid;
    this.metadata.channelId = start.callSid;

    // TwiML: <Parameter name="did" value="+55..."/> chega em customParameters
    const params: Record<string, string> = start.customParameters || {};
    this.metadata.didNumber =
      params.did ||
      params.DID ||
      params.SYNEXA_DID ||
      (this.metadata.didNumber as string | undefined);
    this.metadata.callerNumber =
      params.caller ||
      params.From ||
      params.from ||
      (this.metadata.callerNumber as string | undefined);
    this.metadata.customVariables = { ...params };

    this.logger.log(
      `📞 [Twilio] Stream iniciada | streamSid=${start.streamSid} | callSid=${start.callSid} | did=${this.metadata.didNumber ?? 'n/d'}`,
    );
    this.identification?.resolve();
    this.identification = null;
    if (this.pendingStart) {
      this.pendingStart = false;
      this.callStartCallback?.();
    }
  }

  private handleMedia(media: Record<string, any> | undefined): void {
    if (!media?.payload) return;
    const ulaw = Buffer.from(media.payload, 'base64');
    if (!ulaw.length) return;
    const pcm8k = G711Codec.decodeUlaw(ulaw);
    const pcm16k = AudioResampler.telephonyToGemini(pcm8k);
    if (this.audioCallback) {
      this.audioCallback(pcm16k);
    } else {
      // Sessão ainda não pronta: bufferiza para não perder o "alô"
      this.inboundPreBuffer.push(pcm16k);
    }
  }

  private sendMediaFrame(frame: Buffer): void {
    if (this.isClosed || !this.streamSid || !this.isWsOpen()) return;
    const payload = G711Codec.encodeUlaw(frame).toString('base64');
    this.sendJson({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload },
    });
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
}
