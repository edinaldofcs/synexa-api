import { Logger } from '@nestjs/common';
import * as net from 'net';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { AudioResampler } from '../../audio/audio-resampler.util';
import { TelephonyOutboundPacer } from '../telephony-outbound-pacer';
import { TelephonyInboundPreBuffer } from '../telephony-inbound-prebuffer';

/**
 * Protocolo AudioSocket do Asterisk (res_audiosocket, 16.6+):
 * Frame = [1-byte Type][2-byte Length BE][Payload]
 *
 * O UUID do canal chega uma única vez como payload (16 bytes) de um frame
 * do tipo UUID; frames de áudio são SLIN 8kHz mono 16-bit LE de 20ms (320B).
 */
export const AUDIOSOCKET_FRAME = {
  HEADER_LENGTH: 3,
  /** Payload do frame UUID (0x01): 16 bytes */
  UUID_LENGTH: 16,
  /** Payload SLIN de 20ms @ 8kHz, mono, 16-bit LE */
  AUDIO_PAYLOAD_BYTES: 320,
} as const;

export const AUDIOSOCKET_TYPES = {
  TERMINATE: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  AUDIO: 0x10,
  ERROR: 0xff,
} as const;

export interface AudioSocketFrame {
  type: number;
  length: number;
  payload: Buffer;
}

/**
 * Monta um frame de saída no protocolo AudioSocket.
 */
export function buildAudioSocketFrame(
  type: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(AUDIOSOCKET_FRAME.HEADER_LENGTH);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(payload.length, 1);
  return payload.length ? Buffer.concat([header, payload]) : header;
}

/**
 * Parser incremental: extrai frames completos e devolve o restante.
 * Usado puro para facilitar teste unitário.
 */
export function parseAudioSocketFrames(buffer: Buffer): {
  frames: AudioSocketFrame[];
  rest: Buffer;
} {
  const frames: AudioSocketFrame[] = [];
  let offset = 0;

  while (buffer.length - offset >= AUDIOSOCKET_FRAME.HEADER_LENGTH) {
    const length = buffer.readUInt16BE(offset + 1);
    const total = AUDIOSOCKET_FRAME.HEADER_LENGTH + length;
    if (buffer.length - offset < total) break;

    frames.push({
      type: buffer.readUInt8(offset),
      length,
      payload: buffer.subarray(
        offset + AUDIOSOCKET_FRAME.HEADER_LENGTH,
        offset + total,
      ),
    });
    offset += total;
  }

  return { frames, rest: buffer.subarray(offset) };
}

export class AudioSocketAdapter implements ITelephonyAdapter {
  private readonly logger = new Logger(AudioSocketAdapter.name);

  public readonly providerName = 'audiosocket';
  public readonly sampleRate = 8000;
  public readonly metadata: TelephonyCallMetadata;

  private socket: net.Socket;
  public readonly id: string;
  private channelIdBuffer: Buffer<ArrayBufferLike>;
  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private dtmfCallback: ((digit: string) => void) | null = null;
  private isClosed = false;
  private readBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** Pacer compartilhado: cadência 20ms, pre-buffer, silêncio com decay/fade */
  private readonly pacer = new TelephonyOutboundPacer((frame) =>
    this.writeFrame(AUDIOSOCKET_TYPES.AUDIO, frame),
  );
  /** Áudio do cliente que chega antes da sessão estar pronta (~1-2s) */
  private readonly inboundPreBuffer = new TelephonyInboundPreBuffer(
    16000 * 2 * 6,
  );

  constructor(socket: net.Socket, metadata: TelephonyCallMetadata = {}) {
    this.socket = socket;
    this.id =
      (metadata.uniqueId as string) ||
      `as_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.metadata = { ...metadata, uniqueId: this.id };
    this.setupSocket();
  }

  public async start(): Promise<void> {
    // No AudioSocket o ANSWER é responsabilidade do dialplan (Dial/Answer);
    // aqui apenas sinalizamos início da sessão de IA.
    this.callStartCallback?.();
  }

  public sendAudio(pcm24k: Buffer): void {
    if (this.isClosed || !this.socket.writable) return;
    this.pacer.enqueue(pcm24k);
  }

  /**
   * Descarta o áudio ainda não reproduzido (barge-in): a IA para de falar
   * imediatamente e o pacer contínuo segue com silêncio até o próximo turno.
   */
  public clearQueuedAudio(): void {
    this.pacer.clear();
  }

  public hangup(reason = 'normal_hangup'): void {
    if (this.isClosed) return;
    this.logger.log(`📞 [AudioSocket] Encerrando chamada (${reason})`);
    this.writeFrame(AUDIOSOCKET_TYPES.TERMINATE);
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
    if (!this.socket.destroyed) {
      this.socket.end();
      this.socket = null as unknown as net.Socket;
    }
    this.callEndCallback?.('adapter_closed');
  }

  private setupSocket(): void {
    if (!this.socket) return;

    this.socket.on('data', (data: Buffer) => {
      this.readBuffer = Buffer.concat([this.readBuffer, data]);
      const { frames, rest } = parseAudioSocketFrames(this.readBuffer);
      this.readBuffer = rest;
      for (const frame of frames) this.handleFrame(frame);
    });

    this.socket.on('error', (err: Error) => {
      this.logger.warn(`[AudioSocket] Erro no socket TCP: ${err.message}`);
      this.errorCallback?.(err);
    });

    this.socket.on('close', () => {
      if (!this.isClosed) {
        this.isClosed = true;
        this.callEndCallback?.('socket_closed');
      }
    });
  }

  private handleFrame(frame: AudioSocketFrame): void {
    switch (frame.type) {
      case AUDIOSOCKET_TYPES.UUID:
        this.channelIdBuffer = Buffer.from(frame.payload.subarray(0, 16));
        this.metadata.channelId = formatUuid(this.channelIdBuffer);
        this.logger.log(
          `📞 [AudioSocket] Canal identificado: ${this.metadata.channelId}`,
        );
        break;
      case AUDIOSOCKET_TYPES.DTMF:
        this.dtmfCallback?.(frame.payload.toString('ascii', 0, 1));
        break;
      case AUDIOSOCKET_TYPES.AUDIO:
        if (frame.length > 0) {
          const pcm16k = AudioResampler.telephonyToGemini(frame.payload);
          if (this.audioCallback) {
            this.audioCallback(pcm16k);
          } else {
            // Sessão ainda não pronta: bufferiza para não perder o "alô"
            this.inboundPreBuffer.push(pcm16k);
          }
        }
        break;
      case AUDIOSOCKET_TYPES.TERMINATE:
        this.isClosed = true;
        this.callEndCallback?.('audiosocket_terminate');
        break;
      case AUDIOSOCKET_TYPES.ERROR:
        this.errorCallback?.(
          new Error(`AudioSocket error payload=${frame.length}`),
        );
        break;
      default:
        // Tipos desconhecidos são ignorados conforme especificação
        break;
    }
  }

  private writeFrame(type: number, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    try {
      this.socket.write(buildAudioSocketFrame(type, payload));
    } catch {
      // Socket encerrado entre a checagem e a escrita
    }
  }
}

function formatUuid(buffer: Buffer): string {
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
