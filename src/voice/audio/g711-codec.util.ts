/**
 * G.711 (μ-law e A-law) Codec Utility
 * Converte áudio de telefonia (G.711 8kHz) para Linear PCM 16-bit e vice-versa.
 * Implementação puramente em TypeScript com look-up tables para latência próxima de zero.
 */

// Tabelas de conversão G.711 canônicas (ITU-T) para PCM 16-bit
const SEG_A_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

const ULAW_TO_PCM16: Int16Array = new Int16Array(256);
const ALAW_TO_PCM16: Int16Array = new Int16Array(256);

(function initTables() {
  // μ-law to Linear PCM 16-bit
  for (let i = 0; i < 256; i++) {
    const input = ~i;
    const sign = input & 0x80 ? -1 : 1;
    const exponent = (input >> 4) & 0x07;
    const mantissa = input & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    ULAW_TO_PCM16[i] = sign * sample;
  }

  // A-law to Linear PCM 16-bit
  for (let i = 0; i < 256; i++) {
    const input = i ^ 0x55;
    const sign = (input & 0x80) !== 0 ? 1 : -1;
    const exponent = (input >> 4) & 0x07;
    const mantissa = input & 0x0f;
    let sample = 0;
    if (exponent === 0) {
      sample = (mantissa << 4) + 8;
    } else {
      sample = ((mantissa << 4) + 0x108) << (exponent - 1);
    }
    ALAW_TO_PCM16[i] = sign * sample;
  }
})();

export class G711Codec {
  /**
   * Decodifica um buffer G.711 μ-law (8kHz 8-bit) para Linear PCM 16-bit LE (8kHz).
   */
  public static decodeUlaw(ulawBuffer: Buffer): Buffer {
    const pcmBuffer = Buffer.allocUnsafe(ulawBuffer.length * 2);
    for (let i = 0; i < ulawBuffer.length; i++) {
      pcmBuffer.writeInt16LE(ULAW_TO_PCM16[ulawBuffer[i]], i * 2);
    }
    return pcmBuffer;
  }

  /**
   * Codifica Linear PCM 16-bit LE (8kHz) para G.711 μ-law (8kHz 8-bit).
   */
  public static encodeUlaw(pcmBuffer: Buffer): Buffer {
    const numSamples = Math.floor(pcmBuffer.length / 2);
    const ulawBuffer = Buffer.allocUnsafe(numSamples);

    for (let i = 0; i < numSamples; i++) {
      let sample = pcmBuffer.readInt16LE(i * 2);
      const sign = (sample >> 8) & 0x80;
      if (sign) sample = -sample;
      if (sample > 32635) sample = 32635;
      sample = sample + 0x84;

      let exponent = 7;
      for (
        let expMask = 0x4000;
        (sample & expMask) === 0 && exponent > 0;
        expMask >>= 1
      ) {
        exponent--;
      }

      const mantissa = (sample >> (exponent + 3)) & 0x0f;
      ulawBuffer[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
    }

    return ulawBuffer;
  }

  /**
   * Decodifica um buffer G.711 A-law (8kHz 8-bit) para Linear PCM 16-bit LE (8kHz).
   */
  public static decodeAlaw(alawBuffer: Buffer): Buffer {
    const pcmBuffer = Buffer.allocUnsafe(alawBuffer.length * 2);
    for (let i = 0; i < alawBuffer.length; i++) {
      pcmBuffer.writeInt16LE(ALAW_TO_PCM16[alawBuffer[i]], i * 2);
    }
    return pcmBuffer;
  }

  /**
   * Codifica Linear PCM 16-bit LE (8kHz) para G.711 A-law (8kHz 8-bit) conforme ITU-T G.711.
   */
  public static encodeAlaw(pcmBuffer: Buffer): Buffer {
    const numSamples = Math.floor(pcmBuffer.length / 2);
    const alawBuffer = Buffer.allocUnsafe(numSamples);

    for (let i = 0; i < numSamples; i++) {
      let pcm = pcmBuffer.readInt16LE(i * 2);
      let mask = 0;

      if (pcm >= 0) {
        mask = 0xd5;
      } else {
        mask = 0x55;
        pcm = -pcm - 1;
      }

      let seg = 8;
      for (let s = 0; s < 8; s++) {
        if (pcm <= SEG_A_END[s]) {
          seg = s;
          break;
        }
      }

      let aval: number;
      if (seg >= 8) {
        aval = 0x7f ^ mask;
      } else if (seg < 2) {
        aval = ((seg << 4) | ((pcm >> 4) & 0x0f)) ^ mask;
      } else {
        aval = ((seg << 4) | ((pcm >> (seg + 3)) & 0x0f)) ^ mask;
      }

      alawBuffer[i] = aval & 0xff;
    }

    return alawBuffer;
  }
}
