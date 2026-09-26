import { publicFetch } from '../../../common/utils/public-http';
import { Injectable, Logger } from '@nestjs/common';
import {
  assertPublicHttpUrl,
  customHttpTimeout,
  MAX_CUSTOM_RESPONSE_BYTES,
} from '../../../common/utils/url-guard.util';
import {
  stripWavHeader,
  readWavSampleRate,
} from '../../../common/utils/pcm-wav.util';
import { AudioResampler } from '../../audio/audio-resampler.util';
import {
  ITtsSynthesizer,
  TtsSynthesizeOptions,
} from './tts-synthesizer.interface';

const CANONICAL_SAMPLE_RATE = 24000;

/**
 * Sintetizador TTS BYO (provider 'custom'): chama o endpoint HTTP do cliente
 * para gerar áudio de saudações (batch). A saída é normalizada para
 * PCM s16le mono 24kHz (padrão interno do pipeline).
 */
@Injectable()
export class CustomTtsSynthesizer implements ITtsSynthesizer {
  public readonly providerName = 'custom';
  private readonly logger = new Logger(CustomTtsSynthesizer.name);

  public async synthesize(
    text: string,
    options: TtsSynthesizeOptions,
  ): Promise<Buffer> {
    const config = options.customTts;
    if (!config?.baseUrl) {
      throw new Error(
        '[CustomTtsSynthesizer] customTts.baseUrl é obrigatório para o provider custom',
      );
    }
    assertPublicHttpUrl(config.baseUrl, 'TTS customizado');

    const apiKey = config.apiKey || options.apiKey;
    const voice = config.voice || options.voiceId || '';
    const language = options.language || 'pt';
    const declaredRate =
      config.sampleRate || options.sampleRate || CANONICAL_SAMPLE_RATE;

    const res = await publicFetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        text,
        voice: voice || undefined,
        language,
        format: 'pcm_s16le',
        sample_rate: declaredRate,
      }),
      signal: AbortSignal.timeout(
        customHttpTimeout(config.timeoutMs || 10_000),
      ),
    });

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      throw new Error(`TTS customizado respondeu ${res.status}: ${errText}`);
    }

    const contentType = res.headers.get('content-type') || '';
    let audioBuffer: Buffer;
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as { audio_base64?: string };
      if (!json.audio_base64) {
        throw new Error('TTS customizado retornou JSON sem audio_base64');
      }
      audioBuffer = Buffer.from(json.audio_base64, 'base64');
    } else {
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_CUSTOM_RESPONSE_BYTES) {
        throw new Error('TTS customizado excedeu o limite de resposta');
      }
      audioBuffer = Buffer.from(arrayBuffer);
    }

    const wavRate = readWavSampleRate(audioBuffer);
    let pcm = stripWavHeader(audioBuffer);
    const sourceRate = wavRate || declaredRate;
    if (sourceRate !== CANONICAL_SAMPLE_RATE) {
      pcm = AudioResampler.resample(pcm, sourceRate, CANONICAL_SAMPLE_RATE);
    }

    this.logger.debug(
      `🎙️ [CustomTtsSynthesizer] Síntese concluída (${pcm.length} bytes @24kHz)`,
    );
    return pcm;
  }
}
