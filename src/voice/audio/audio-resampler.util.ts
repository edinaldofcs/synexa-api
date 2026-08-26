/**
 * Audio Resampler Utility
 * Realiza conversão de taxa de amostragem (Linear Interpolation Resampling) para Linear PCM 16-bit LE.
 * Otimizado para conversão em tempo real entre taxas comuns de telefonia e IA (8kHz, 16kHz, 24kHz, 48kHz).
 */

export class AudioResampler {
  /**
   * Converte um buffer PCM 16-bit mono de `fromRate` para `toRate`.
   */
  public static resample(
    inputBuffer: Buffer,
    fromRate: number,
    toRate: number,
  ): Buffer {
    if (fromRate === toRate || inputBuffer.length === 0) {
      return inputBuffer;
    }

    const inputSampleCount = Math.floor(inputBuffer.length / 2);
    if (inputSampleCount === 0) return Buffer.alloc(0);

    const ratio = fromRate / toRate;
    const outputSampleCount = Math.round(inputSampleCount / ratio);
    const outputBuffer = Buffer.allocUnsafe(outputSampleCount * 2);

    for (let i = 0; i < outputSampleCount; i++) {
      const srcIndex = i * ratio;
      const indexFloor = Math.floor(srcIndex);
      const frac = srcIndex - indexFloor;

      let sample: number;
      if (indexFloor >= inputSampleCount - 1) {
        sample = inputBuffer.readInt16LE((inputSampleCount - 1) * 2);
      } else {
        const s1 = inputBuffer.readInt16LE(indexFloor * 2);
        const s2 = inputBuffer.readInt16LE((indexFloor + 1) * 2);
        sample = Math.round(s1 + frac * (s2 - s1));
      }

      // Clamping para 16-bit signed integer
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;

      outputBuffer.writeInt16LE(sample, i * 2);
    }

    return outputBuffer;
  }

  /**
   * Converte áudio de Telefonia (8kHz) para Gemini Live Input (16kHz).
   */
  public static telephonyToGemini(pcm8k: Buffer): Buffer {
    return this.resample(pcm8k, 8000, 16000);
  }

  /**
   * Converte áudio de saída do Gemini Live (24kHz) para Telefonia (8kHz).
   */
  public static geminiToTelephony(pcm24k: Buffer): Buffer {
    return this.resample(pcm24k, 24000, 8000);
  }
}
