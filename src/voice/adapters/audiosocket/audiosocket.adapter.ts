import { Logger } from '@nestjs/common';
import * as net from 'net';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { AudioResampler } from '../../audio/audio-resampler.util';

/**
 * Protocolo AudioSocket do Asterisk:
 * Frame = [16-byte UUID][2-byte Type BE][2-byte Length BE][Payload]
 */
export const AUDIOSOCKET_FRAME = {
  HEADER_LENGTH: 20,
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
  id: Buffer;
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
  id?: Buffer,
): Buffer {
  const header = Buffer.alloc(AUDIOSOCKET_FRAME.HEADER_LENGTH);
  if (id && id.length === AUDIOSOCKET_FRAME.UUID_LENGTH) {
    id.copy(header, 0);
  }
  header.writeUInt16BE(type, AUDIOSOCKET_FRAME.UUID_LENGTH);
  header.writeUInt16BE(payload.length, AUDIOSOCKET_FRAME.UUID_LENGTH + 2);
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
    const length = buffer.readUInt16BE(
      offset + AUDIOSOCKET_FRAME.UUID_LENGTH + 2,
    );
    const total = AUDIOSOCKET_FRAME.HEADER_LENGTH + length;
    if (buffer.length - offset < total) break;

    frames.push({
      id: buffer.subarray(offset, offset + AUDIOSOCKET_FRAME.UUID_LENGTH),
      type: buffer.readUInt16BE(offset + AUDIOSOCKET_FRAME.UUID_LENGTH),
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
    const pcm8k = AudioResampler.geminiToTelephony(pcm24k);
    for (
      let offset = 0;
      offset < pcm8k.length;
      offset += AUDIOSOCKET_FRAME.AUDIO_PAYLOAD_BYTES
    ) {
      const chunk = pcm8k.subarray(
        offset,
        Math.min(offset + AUDIOSOCKET_FRAME.AUDIO_PAYLOAD_BYTES, pcm8k.length),
      );
      if (chunk.length < AUDIOSOCKET_FRAME.AUDIO_PAYLOAD_BYTES) {
        // Último frame parcial: pad com silêncio para manter 20ms
        const padded = Buffer.alloc(
          AUDIOSOCKET_FRAME.AUDIO_PAYLOAD_BYTES,
          0x00,
        );
        chunk.copy(padded, 0);
        this.writeFrame(AUDIOSOCKET_TYPES.AUDIO, padded);
      } else {
        this.writeFrame(AUDIOSOCKET_TYPES.AUDIO, chunk);
      }
    }
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
        if (frame.length > 0 && this.audioCallback) {
          const pcm16k = AudioResampler.telephonyToGemini(frame.payload);
          this.audioCallback(pcm16k);
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
      this.socket.write(
        buildAudioSocketFrame(type, payload, this.channelIdBuffer),
      );
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
