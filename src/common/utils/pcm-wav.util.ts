/**
 * Utilitários de áudio PCM/WAV compartilhados entre providers de voz.
 */

/**
 * Encapsula buffer PCM bruto em WAV mono de 16-bit (header de 44 bytes).
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const dataLength = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Remove header RIFF/WAV de um buffer (caso o endpoint responda com WAV
 * em vez de PCM bruto) e retorna apenas o payload de áudio.
 * Se não for WAV, retorna o buffer original.
 */
export function stripWavHeader(buffer: Buffer): Buffer {
  if (
    buffer.length > 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return buffer.subarray(44);
  }
  return buffer;
}

/**
 * Lê a sample rate declarada no header WAV (offset 24, little-endian).
 * Retorna null se o buffer não for WAV.
 */
export function readWavSampleRate(buffer: Buffer): number | null {
  if (
    buffer.length > 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return buffer.readUInt32LE(24);
  }
  return null;
}
