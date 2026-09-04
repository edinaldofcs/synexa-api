import { Injectable, Logger } from '@nestjs/common';

export interface GroqTranscriptionOptions {
  apiKey: string;
  sampleRate?: number;
  language?: string;
  prompt?: string;
}

@Injectable()
export class GroqWhisperSttService {
  private readonly logger = new Logger(GroqWhisperSttService.name);

  /**
   * Transcreve um buffer de áudio PCM 16-bit utilizando o Groq Whisper Large v3 Turbo.
   */
  public async transcribePcm(
    pcmBuffer: Buffer,
    options: GroqTranscriptionOptions,
  ): Promise<string> {
    if (!pcmBuffer || pcmBuffer.length === 0) return '';
    const sampleRate = options.sampleRate || 16000;
    const language = options.language || 'pt';

    // Cria cabeçalho WAV simples de 44 bytes para o áudio PCM 16-bit mono
    const wavBuffer = this.pcmToWav(pcmBuffer, sampleRate, 1, 16);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', language);
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');

    if (options.prompt) {
      formData.append('prompt', options.prompt);
    }

    const startMs = Date.now();
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(10_000),
    });

    const latencyMs = Date.now() - startMs;

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`❌ [GroqSTT] Erro na transcrição (${res.status}): ${errText}`);
      throw new Error(`Falha no Groq Whisper: ${res.status} - ${errText}`);
    }

    const json = (await res.json()) as { text?: string };
    const text = (json.text || '').trim();
    this.logger.debug(`🎙️ [GroqSTT] Transcrito em ${latencyMs}ms: "${text}"`);
    return text;
  }

  /**
   * Helper para encapsular buffer PCM bruto em WAV mono de 16-bit.
   */
  private pcmToWav(
    pcmBuffer: Buffer,
    sampleRate: number,
    channels: number,
    bitsPerSample: number,
  ): Buffer {
    const dataLength = pcmBuffer.length;
    const header = Buffer.alloc(44);

    // RIFF identifier
    header.write('RIFF', 0);
    // RIFF chunk length
    header.writeUInt32LE(36 + dataLength, 4);
    // RIFF type
    header.write('WAVE', 8);
    // Format chunk identifier
    header.write('fmt ', 12);
    // Format chunk length
    header.writeUInt32LE(16, 16);
    // Sample format (1 = PCM)
    header.writeUInt16LE(1, 20);
    // Channel count
    header.writeUInt16LE(channels, 22);
    // Sample rate
    header.writeUInt32LE(sampleRate, 24);
    // Byte rate (SampleRate * ChannelCount * BitsPerSample / 8)
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
    // Block align (ChannelCount * BitsPerSample / 8)
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
    // Bits per sample
    header.writeUInt16LE(bitsPerSample, 34);
    // Data chunk identifier
    header.write('data', 36);
    // Data chunk length
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, pcmBuffer]);
  }
}
