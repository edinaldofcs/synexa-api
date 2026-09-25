import { Injectable, Logger } from '@nestjs/common';
import {
  ITtsSynthesizer,
  TtsSynthesizeOptions,
} from './tts-synthesizer.interface';

@Injectable()
export class GoogleTtsSynthesizer implements ITtsSynthesizer {
  private readonly logger = new Logger(GoogleTtsSynthesizer.name);
  public readonly providerName = 'google';

  public async synthesize(
    text: string,
    options: TtsSynthesizeOptions,
  ): Promise<Buffer> {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      throw new Error('Chave de API do Google não configurada para síntese');
    }

    const voiceName = options.voiceId || 'Aoede';
    const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';

    const payload = {
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voiceName }] },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      this.logger.error(
        `❌ [GoogleTtsSynthesizer] Falha HTTP ${response.status}: ${errText}`,
      );
      throw new Error(
        `Erro na síntese Google (HTTP ${response.status}): ${errText || response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      output_audio?: { data?: string };
    };
    if (!data.output_audio?.data) {
      throw new Error('Google TTS retornou audioContent vazio');
    }

    const wav = Buffer.from(data.output_audio.data, 'base64');
    if (
      wav.length < 12 ||
      wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw new Error('Gemini TTS retornou WAV inválido');
    let formatValid = false;
    for (let offset = 12; offset + 8 <= wav.length; ) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > wav.length) throw new Error('WAV truncado');
      if (id === 'fmt ' && size >= 16) {
        formatValid =
          wav.readUInt16LE(start) === 1 &&
          wav.readUInt16LE(start + 2) === 1 &&
          wav.readUInt32LE(start + 4) === 24000 &&
          wav.readUInt16LE(start + 14) === 16;
      }
      if (id === 'data') {
        if (!formatValid || !size || size % 2)
          throw new Error('WAV precisa ser PCM16 mono 24 kHz');
        return wav.subarray(start, start + size);
      }
      offset = start + size + (size % 2);
    }
    throw new Error('WAV sem dados de áudio');
  }
}
