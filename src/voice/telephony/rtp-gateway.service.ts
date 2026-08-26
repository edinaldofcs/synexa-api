import { Injectable, Logger } from '@nestjs/common';
import * as dgram from 'dgram';

// Tabelas de Consulta G.711 Pré-computadas
const muLawToPcmTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const uVal = ~i;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = (mantissa << 3) + 33;
  sample <<= exponent;
  sample -= 33;
  muLawToPcmTable[i] = sign ? -sample : sample;
}

const aLawToPcmTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const aVal = i ^ 0x55;
  const sign = aVal & 0x80;
  const exponent = (aVal >> 4) & 0x07;
  const mantissa = aVal & 0x0f;
  let sample = 0;
  if (exponent === 0) {
    sample = (mantissa << 4) + 8;
  } else {
    sample = ((mantissa << 4) + 264) << (exponent - 1);
  }
  aLawToPcmTable[i] = sign ? -sample : sample;
}

const pcmToMuLawTable = new Uint8Array(65536);
function pcm16ToMuLaw(sample: number): number {
  let sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 84;
  let exponent = 0;
  if (sample >= 16384) {
    exponent = 7;
    sample >>= 7;
  } else if (sample >= 8192) {
    exponent = 6;
    sample >>= 6;
  } else if (sample >= 4096) {
    exponent = 5;
    sample >>= 5;
  } else if (sample >= 2048) {
    exponent = 4;
    sample >>= 4;
  } else if (sample >= 1024) {
    exponent = 3;
    sample >>= 3;
  } else if (sample >= 512) {
    exponent = 2;
    sample >>= 2;
  } else if (sample >= 256) {
    exponent = 1;
    sample >>= 1;
  }
  const mantissa = (sample >> 3) & 0x0f;
  const uVal = sign | (exponent << 4) | mantissa;
  return ~uVal & 0xff;
}
for (let val = -32768; val <= 32767; val++) {
  pcmToMuLawTable[val + 32768] = pcm16ToMuLaw(val);
}

const pcmToALawTable = new Uint8Array(65536);
function pcm16ToALaw(sample: number): number {
  let sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > 32767) sample = 32767;
  let exponent = 0;
  let mantissa = 0;
  if (sample >= 16384) {
    exponent = 7;
    mantissa = (sample >> 7) & 0x0f;
  } else if (sample >= 8192) {
    exponent = 6;
    mantissa = (sample >> 6) & 0x0f;
  } else if (sample >= 4096) {
    exponent = 5;
    mantissa = (sample >> 5) & 0x0f;
  } else if (sample >= 2048) {
    exponent = 4;
    mantissa = (sample >> 4) & 0x0f;
  } else if (sample >= 1024) {
    exponent = 3;
    mantissa = (sample >> 3) & 0x0f;
  } else if (sample >= 512) {
    exponent = 2;
    mantissa = (sample >> 2) & 0x0f;
  } else if (sample >= 256) {
    exponent = 1;
    mantissa = (sample >> 1) & 0x0f;
  } else if (sample >= 128) {
    exponent = 0;
    mantissa = (sample >> 4) & 0x0f;
  } else {
    exponent = 0;
    mantissa = (sample >> 3) & 0x0f;
  }
  let aVal = (exponent << 4) | mantissa;
  if (sign) aVal |= 0x80;
  return (aVal ^ 0x55) & 0xff;
}
for (let val = -32768; val <= 32767; val++) {
  pcmToALawTable[val + 32768] = pcm16ToALaw(val);
}

export interface RtpSessionCallbacks {
  onPcmAudioIn: (pcm16Base64: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export class RtpChannelSession {
  private readonly logger = new Logger(RtpChannelSession.name);
  public socket: dgram.Socket | null = null;
  public localPort = 0;
  public remoteIp = '';
  public remotePort = 0;
  public codec: 'ulaw' | 'alaw' = 'ulaw';
  private sequenceNumber = Math.floor(Math.random() * 65535);
  private timestamp = Math.floor(Math.random() * 4294967295);
  private ssrc = Math.floor(Math.random() * 4294967295);
  private sendInterval: NodeJS.Timeout | null = null;
  private outboundQueue: Buffer[] = [];
  private outboundQueueBytes = 0;

  constructor(
    private readonly callbacks: RtpSessionCallbacks,
    codec: 'ulaw' | 'alaw' = 'ulaw',
  ) {
    this.codec = codec;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        this.logger.error(`❌ [RtpSession] Erro no socket UDP: ${err.message}`);
        this.callbacks.onError?.(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        if (!this.remoteIp || !this.remotePort) {
          this.remoteIp = rinfo.address;
          this.remotePort = rinfo.port;
        }

        // Pula o cabeçalho RTP de 12 bytes
        if (msg.length > 12) {
          const payload = msg.subarray(12);
          const pcm16 =
            this.codec === 'alaw'
              ? RtpGatewayService.decodeALawAndUpsampleTo16(payload)
              : RtpGatewayService.decodeMuLawAndUpsampleTo16(payload);

          this.callbacks.onPcmAudioIn(pcm16.toString('base64'));
        }
      });

      this.socket.bind(0, '0.0.0.0', () => {
        const addr = this.socket?.address();
        this.localPort = typeof addr === 'object' && addr ? addr.port : 0;
        this.logger.log(
          `🎧 [RtpSession] Socket UDP alocado na porta ${this.localPort}`,
        );
        this.startOutboundLoop();
        resolve(this.localPort);
      });
    });
  }

  public enqueuePcmOut(pcm24Or16: Buffer): void {
    const encodedG711 = RtpGatewayService.downsampleTo8AndEncode(
      pcm24Or16,
      this.codec,
    );
    this.outboundQueue.push(encodedG711);
    this.outboundQueueBytes += encodedG711.length;
  }

  private startOutboundLoop(): void {
    // A cada 20ms envia um frame RTP de 160 bytes (8kHz mono = 160 bytes por 20ms)
    this.sendInterval = setInterval(() => {
      if (this.outboundQueueBytes < 160 || !this.remoteIp || !this.remotePort) {
        return;
      }

      const frame = Buffer.alloc(160);
      let offset = 0;
      while (offset < 160 && this.outboundQueue.length > 0) {
        const chunk = this.outboundQueue[0];
        const needed = 160 - offset;
        if (chunk.length <= needed) {
          chunk.copy(frame, offset);
          offset += chunk.length;
          this.outboundQueueBytes -= chunk.length;
          this.outboundQueue.shift();
        } else {
          chunk.copy(frame, offset, 0, needed);
          this.outboundQueue[0] = chunk.subarray(needed);
          this.outboundQueueBytes -= needed;
          offset += needed;
        }
      }

      this.sendRtpPacket(frame);
    }, 20);
  }

  private sendRtpPacket(payload: Buffer): void {
    if (!this.socket || !this.remoteIp || !this.remotePort) return;

    const rtpPacket = Buffer.alloc(12 + payload.length);
    rtpPacket[0] = 0x80; // V=2, P=0, X=0, CC=0
    rtpPacket[1] = this.codec === 'alaw' ? 8 : 0; // Payload type 0=PCMU, 8=PCMA
    rtpPacket.writeUInt16BE(this.sequenceNumber++ & 0xffff, 2);
    rtpPacket.writeUInt32BE(this.timestamp & 0xffffffff, 4);
    this.timestamp = (this.timestamp + 160) >>> 0;
    rtpPacket.writeUInt32BE(this.ssrc, 8);
    payload.copy(rtpPacket, 12);

    this.socket.send(
      rtpPacket,
      0,
      rtpPacket.length,
      this.remotePort,
      this.remoteIp,
    );
  }

  public close(): void {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignora erro de socket ja fechado
      }
      this.socket = null;
    }
    this.outboundQueue = [];
    this.outboundQueueBytes = 0;
    this.callbacks.onClose?.();
  }
}

@Injectable()
export class RtpGatewayService {
  private readonly logger = new Logger(RtpGatewayService.name);

  public static decodeMuLawAndUpsampleTo16(buffer: Buffer): Buffer {
    const pcm16 = Buffer.alloc(buffer.length * 4); // 8kHz -> 16kHz (2x samples * 2 bytes = 4x)
    for (let i = 0; i < buffer.length; i++) {
      const valCurrent = muLawToPcmTable[buffer[i]];
      const valNext =
        i < buffer.length - 1 ? muLawToPcmTable[buffer[i + 1]] : valCurrent;
      const valInterm = Math.round((valCurrent + valNext) / 2);

      const offset = i * 4;
      pcm16.writeInt16LE(valCurrent, offset);
      pcm16.writeInt16LE(valInterm, offset + 2);
    }
    return pcm16;
  }

  public static decodeALawAndUpsampleTo16(buffer: Buffer): Buffer {
    const pcm16 = Buffer.alloc(buffer.length * 4);
    for (let i = 0; i < buffer.length; i++) {
      const valCurrent = aLawToPcmTable[buffer[i]];
      const valNext =
        i < buffer.length - 1 ? aLawToPcmTable[buffer[i + 1]] : valCurrent;
      const valInterm = Math.round((valCurrent + valNext) / 2);

      const offset = i * 4;
      pcm16.writeInt16LE(valCurrent, offset);
      pcm16.writeInt16LE(valInterm, offset + 2);
    }
    return pcm16;
  }

  public static downsampleTo8AndEncode(
    pcmBuffer: Buffer,
    codec: 'ulaw' | 'alaw' = 'ulaw',
    sourceRate = 24000,
  ): Buffer {
    const table = codec === 'alaw' ? pcmToALawTable : pcmToMuLawTable;
    const ratio = Math.round(sourceRate / 8000); // 24kHz / 8kHz = 3; 16kHz / 8kHz = 2
    const totalSamples = Math.floor(pcmBuffer.length / 2);
    const targetSamples = Math.floor(totalSamples / ratio);
    const encoded = Buffer.alloc(targetSamples);

    for (let i = 0; i < targetSamples; i++) {
      const sample = pcmBuffer.readInt16LE(i * ratio * 2);
      encoded[i] = table[sample + 32768];
    }
    return encoded;
  }

  public createSession(
    callbacks: RtpSessionCallbacks,
    codec: 'ulaw' | 'alaw' = 'ulaw',
  ): RtpChannelSession {
    return new RtpChannelSession(callbacks, codec);
  }
}
