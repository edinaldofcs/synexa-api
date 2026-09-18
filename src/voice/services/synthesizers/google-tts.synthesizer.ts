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
    const sampleRate = options.sampleRate || 24000;
    const languageCode = options.language?.includes('-')
      ? options.language
      : 'pt-BR';

    // Google Cloud Text-to-Speech REST endpoint
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(
      apiKey,
    )}`;

    const payload = {
      input: { text },
      voice: {
        languageCode,
        name: voiceName.includes('-') ? voiceName : undefined,
      },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

    const data = (await response.json()) as { audioContent?: string };
    if (!data.audioContent) {
      throw new Error('Google TTS retornou audioContent vazio');
    }

    const wavBuffer = Buffer.from(data.audioContent, 'base64');
    // LINEAR16 do Google retorna container WAV (cabeçalho RIFF de 44 bytes).
    // Extraímos os dados brutos PCM para alinhamento com a telefonia:
    if (wavBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
      return wavBuffer.slice(44);
    }
    return wavBuffer;
  }
}
