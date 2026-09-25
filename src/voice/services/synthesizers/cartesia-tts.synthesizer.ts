import { Injectable, Logger } from '@nestjs/common';
import {
  ITtsSynthesizer,
  TtsSynthesizeOptions,
} from './tts-synthesizer.interface';

const DEFAULT_CARTESIA_VOICE = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
const DEFAULT_CARTESIA_MODEL = 'sonic-3.6';
const CARTESIA_VERSION = '2024-11-13';

@Injectable()
export class CartesiaTtsSynthesizer implements ITtsSynthesizer {
  private readonly logger = new Logger(CartesiaTtsSynthesizer.name);
  public readonly providerName = 'cartesia';

  public async synthesize(
    text: string,
    options: TtsSynthesizeOptions,
  ): Promise<Buffer> {
    const rawKey = options.apiKey || process.env.CARTESIA_API_KEY || '';
    const cleanKey = rawKey.trim();
    if (!cleanKey) {
      throw new Error('CARTESIA_API_KEY não configurada para síntese');
    }

    const voiceId = options.voiceId || DEFAULT_CARTESIA_VOICE;
    const modelId = options.modelId || DEFAULT_CARTESIA_MODEL;
    const sampleRate = options.sampleRate || 24000;
    const language = options.language || 'pt';

    const payload = {
      model_id: modelId,
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId,
      },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: sampleRate,
      },
      language,
    };

    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': cleanKey,
        Authorization: `Bearer ${cleanKey}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      this.logger.error(
        `❌ [CartesiaTtsSynthesizer] Falha HTTP ${response.status}: ${errText}`,
      );
      throw new Error(
        `Erro na síntese Cartesia (HTTP ${response.status}): ${errText || response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
