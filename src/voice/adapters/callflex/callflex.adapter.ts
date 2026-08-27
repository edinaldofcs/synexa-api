import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { G711Codec } from '../../audio/g711-codec.util';
import { AudioResampler } from '../../audio/audio-resampler.util';

export interface CallFlexAdapterConfig {
  wsUrl?: string;
  wsSocket?: WebSocket;
  metadata?: TelephonyCallMetadata;
  audioFormat?: 'g711_ulaw' | 'g711_alaw' | 'pcm_8k' | 'pcm_16k';
}

export class CallFlexAdapter implements ITelephonyAdapter {
  private readonly logger = new Logger(CallFlexAdapter.name);

  public readonly id: string;
  public readonly providerName = 'callflex';
  public readonly sampleRate = 8000;
  public metadata: TelephonyCallMetadata;

  private ws: WebSocket | null = null;
  private audioFormat: 'g711_ulaw' | 'g711_alaw' | 'pcm_8k' | 'pcm_16k';
  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private variableCallback: ((key: string, value: string) => void) | null =
    null;
  private isClosed = false;

  constructor(config: CallFlexAdapterConfig) {
    this.metadata = config.metadata || {};
    this.id =
      this.metadata.uniqueId ||
      `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.audioFormat = config.audioFormat || 'g711_ulaw';

    if (config.wsSocket) {
      this.ws = config.wsSocket;
      this.setupWebSocketListeners();
    }
  }

  /**
   * Aguarda o frame de identificação (start/connected) com metadados da
   * chamada. Cumpre o contrato opcional de adapters em streaming.
   */
  public async waitForIdentification(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      Date.now() < deadline &&
      !this.metadata.callerNumber &&
      !this.metadata.didNumber
    ) {
      if (this.isClosed || this.ws?.readyState !== WebSocket.OPEN) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return Boolean(this.metadata.callerNumber || this.metadata.didNumber);
  }

  private setupWebSocketListeners(): void {
    if (!this.ws) return;

    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary && Buffer.isBuffer(data)) {
        this.processIncomingAudio(data);
      } else {
        try {
          const text = data.toString();
          const json = JSON.parse(text);
          this.handleControlMessage(json);
        } catch {
          // Ignora mensagens de texto não-JSON
        }
      }
    });

    this.ws.on('close', () => {
      if (!this.isClosed) {
        this.isClosed = true;
        this.callEndCallback?.('callflex_disconnected');
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`❌ [CallFlexAdapter] Erro na conexão: ${err.message}`);
      this.errorCallback?.(err);
    });
  }

  private processIncomingAudio(rawAudio: Buffer): void {
    if (this.isClosed || !this.audioCallback) return;

    let pcm8k: Buffer;
    if (this.audioFormat === 'g711_ulaw') {
      pcm8k = G711Codec.decodeUlaw(rawAudio);
    } else if (this.audioFormat === 'g711_alaw') {
      pcm8k = G711Codec.decodeAlaw(rawAudio);
    } else {
      pcm8k = rawAudio;
    }

    const pcm16k =
      this.audioFormat === 'pcm_16k'
        ? rawAudio
        : AudioResampler.telephonyToGemini(pcm8k);

    this.audioCallback(pcm16k);
  }

  private handleControlMessage(msg: Record<string, any>): void {
    switch (msg.type || msg.event) {
      case 'start':
      case 'call_started':
      case 'connected':
        this.applyIncomingMetadata(msg);
        this.callStartCallback?.();
        break;
      case 'call_ended':
      case 'hangup':
        this.hangup(msg.reason || 'remote_hangup');
        break;
      case 'variable_update':
        if (msg.key && msg.value) {
          this.setVariable(msg.key, String(msg.value));
        }
        break;
    }
  }

  /**
   * Absorve metadados do frame de identificação do discador.
   * Formato esperado (contrato Synexa v1):
   * { type: 'start', call_id, from, did, variables: {...} }
   */
  private applyIncomingMetadata(msg: Record<string, any>): void {
    const incoming = msg.metadata || {};
    const patch: TelephonyCallMetadata = {
      ...(msg.call_id || msg.uniqueid
        ? { uniqueId: String(msg.call_id || msg.uniqueid) }
        : {}),
      ...(incoming.callerNumber
        ? { callerNumber: String(incoming.callerNumber) }
        : msg.from || msg.caller
          ? { callerNumber: String(msg.from || msg.caller) }
          : {}),
      ...(incoming.didNumber || msg.did
        ? { didNumber: String(incoming.didNumber ?? msg.did) }
        : {}),
      ...(incoming.customVariables || incoming.variables || msg.variables
        ? {
            customVariables: {
              ...((this.metadata.customVariables as Record<string, unknown>) ||
                {}),
              ...((incoming.customVariables ||
                incoming.variables ||
                msg.variables) as Record<string, unknown>),
            },
          }
        : {}),
    };
    this.metadata = { ...this.metadata, ...patch } as TelephonyCallMetadata;
  }

  public async start(): Promise<void> {
    this.callStartCallback?.();
  }

  public sendAudio(pcm16: Buffer): void {
    if (!this.ws || this.isClosed || this.ws.readyState !== WebSocket.OPEN)
      return;

    let outgoingBuffer: Buffer;
    if (this.audioFormat === 'g711_ulaw') {
      const pcm8k = AudioResampler.resample(pcm16, 24000, 8000);
      outgoingBuffer = G711Codec.encodeUlaw(pcm8k);
    } else if (this.audioFormat === 'g711_alaw') {
      const pcm8k = AudioResampler.resample(pcm16, 24000, 8000);
      outgoingBuffer = G711Codec.encodeAlaw(pcm8k);
    } else {
      outgoingBuffer = AudioResampler.resample(pcm16, 24000, 8000);
    }

    this.ws.send(outgoingBuffer);
  }

  public hangup(reason = 'normal_hangup'): void {
    if (this.isClosed) return;
    this.logger.log(
      `📞 [CallFlexAdapter] Desconectando chamada CallFlex (${reason})`,
    );
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'hangup', reason }));
    }
    this.close();
  }

  public setVariable(key: string, value: string): void {
    if (!this.metadata.customVariables) {
      this.metadata.customVariables = {};
    }
    this.metadata.customVariables[key] = value;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'set_variable', key, value }));
    }
    this.variableCallback?.(key, value);
    this.logger.log(
      `📞 [CallFlexAdapter] Variável atualizada: ${key}="${value}"`,
    );
  }

  public getVariable(key: string): string | undefined {
    return (this.metadata.customVariables?.[key] as string) || undefined;
  }

  public onAudio(callback: (pcm16: Buffer) => void): void {
    this.audioCallback = callback;
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

  public onVariable(callback: (key: string, value: string) => void): void {
    this.variableCallback = callback;
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.callEndCallback?.('adapter_closed');
  }
}
