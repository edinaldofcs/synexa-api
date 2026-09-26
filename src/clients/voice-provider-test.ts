import { publicFetch } from '../common/utils/public-http';
import {
  assertPublicHttpUrl,
  customHttpTimeout,
  MAX_CUSTOM_RESPONSE_BYTES,
} from '../common/utils/url-guard.util';
import { pcmToWav } from '../common/utils/pcm-wav.util';
import { TestVoiceProviderDto } from './dto/test-voice-provider.dto';

class VoiceTestError extends Error {}

function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > Math.ceil((MAX_CUSTOM_RESPONSE_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new VoiceTestError('Áudio Base64 inválido ou excessivamente grande.');
  }
  return Buffer.from(value, 'base64');
}

function readWav(buffer: Buffer, requiredRate?: number) {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    throw new VoiceTestError(
      'Envie áudio WAV PCM de 16 bits, mono, com cabeçalho válido.',
    );
  }
  let rate = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length)
      throw new VoiceTestError('Áudio WAV incompleto.');
    if (id === 'fmt ') {
      if (
        size < 16 ||
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt16LE(start + 14) !== 16 ||
        buffer.readUInt16LE(start + 12) !== 2
      ) {
        throw new VoiceTestError(
          'O WAV deve usar PCM de 16 bits e um canal (mono).',
        );
      }
      rate = buffer.readUInt32LE(start + 4);
      if (buffer.readUInt32LE(start + 8) !== rate * 2)
        throw new VoiceTestError('Taxa de áudio WAV inválida.');
    }
    if (id === 'data') pcm = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (
    !pcm?.length ||
    pcm.length % 2 ||
    rate < 8000 ||
    rate > 48000 ||
    (requiredRate && rate !== requiredRate)
  ) {
    throw new VoiceTestError(
      requiredRate
        ? 'O STT espera WAV mono PCM16 a 16000 Hz.'
        : 'Áudio PCM/WAV inválido.',
    );
  }
  return { pcm, rate };
}

function httpError(status: number): string {
  const hints: Record<number, string> = {
    400: 'Confira o formato da requisição e os parâmetros do seu endpoint.',
    401: 'Chave inválida. Confira o token Bearer do seu endpoint.',
    402: 'Verifique o saldo ou faturamento do serviço.',
    403: 'A chave não tem permissão para este serviço ou modelo.',
    404: 'Confira o caminho completo do endpoint e o modelo/voz configurado no seu serviço.',
    415: 'Formato não aceito. TTS envia JSON; STT envia WAV no corpo, sem multipart.',
    422: 'Confira os parâmetros, modelo e voz aceitos pelo seu serviço.',
    429: 'Limite de requisições atingido. Aguarde e confira a cota do serviço.',
  };
  return (
    'HTTP ' +
    status +
    ': ' +
    (hints[status] || 'O endpoint falhou. Verifique os logs do seu serviço.')
  );
}

/** Contract probe only; audio/text stay in memory and are not logged or stored. */
export async function testCustomVoiceEndpoint(
  dto: TestVoiceProviderDto,
  apiKey: string,
) {
  const start = Date.now();
  try {
    let url: URL;
    try {
      url = assertPublicHttpUrl(dto.baseUrl);
      if (url.username || url.password) throw new Error();
    } catch {
      throw new VoiceTestError(
        'Informe uma URL pública HTTPS válida, sem usuário ou senha na URL.',
      );
    }
    let body: RequestInit['body'];
    if (dto.kind === 'tts') {
      const text =
        dto.text === undefined ? 'Teste de voz do Synexa.' : dto.text.trim();
      if (!text || text.length > 500)
        throw new VoiceTestError('Digite uma frase de 1 a 500 caracteres.');
      body = JSON.stringify({
        text,
        voice: dto.voice || undefined,
        language: 'pt',
        format: 'pcm_s16le',
        sample_rate: dto.outputSampleRate || 24000,
      });
    } else if (dto.audioBase64) {
      const { pcm, rate } = readWav(decodeBase64(dto.audioBase64), 16000);
      if (pcm.length > rate * 2 * 20)
        throw new VoiceTestError('Envie no máximo 20 segundos de áudio.');
      body = new Uint8Array(pcmToWav(pcm, rate));
    } else {
      // Legacy connectivity probe. Silence checks the contract, not accuracy.
      body = new Uint8Array(pcmToWav(Buffer.alloc(16000 * 2), 16000));
    }
    const response = await publicFetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': dto.kind === 'tts' ? 'application/json' : 'audio/wav',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(
        customHttpTimeout(dto.timeoutMs || (dto.kind === 'tts' ? 10000 : 5000)),
      ),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: httpError(response.status),
      };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_CUSTOM_RESPONSE_BYTES)
      throw new VoiceTestError('Resposta vazia ou excessivamente grande.');
    const contentType =
      response.headers.get('content-type')?.toLowerCase() || '';
    if (dto.kind === 'stt') {
      if (bytes.length > 100000)
        throw new VoiceTestError('Transcrição excessivamente grande.');
      let text = bytes.toString('utf8').trim();
      if (contentType.includes('json') || text.startsWith('{')) {
        const result: unknown = JSON.parse(text);
        if (!result || typeof result !== 'object')
          throw new VoiceTestError(
            'O STT deve retornar JSON com text, transcript ou result do tipo texto.',
          );
        const obj = result as Record<string, unknown>;
        const value = obj.text ?? obj.transcript ?? obj.result;
        if (typeof value !== 'string')
          throw new VoiceTestError(
            'O STT deve retornar JSON com text, transcript ou result do tipo texto.',
          );
        text = value.trim();
      } else if (contentType && !contentType.startsWith('text/plain')) {
        throw new VoiceTestError(
          'O STT deve responder JSON ou texto puro, não HTML ou áudio.',
        );
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        text,
        message: dto.audioBase64
          ? 'Transcrição concluída.'
          : 'Conexão validada com silêncio. Envie uma fala para avaliar a transcrição.',
      };
    }
    let audio: Buffer = bytes;
    if (contentType.includes('json')) {
      const result = JSON.parse(bytes.toString('utf8')) as {
        audio_base64?: unknown;
      };
      audio = decodeBase64(result?.audio_base64);
    } else if (
      contentType &&
      !/^(audio\/(wav|x-wav|wave|pcm|x-pcm)|application\/octet-stream)(;|$)/.test(
        contentType,
      )
    ) {
      throw new VoiceTestError(
        'O TTS deve responder PCM16 mono, WAV PCM16 mono ou JSON com audio_base64.',
      );
    }
    let rate = dto.outputSampleRate || 24000;
    if (audio.toString('ascii', 0, 4) === 'RIFF') {
      const wav = readWav(audio);
      audio = wav.pcm;
      rate = wav.rate;
    }
    if (!audio.length || audio.length % 2 || audio.length > rate * 2 * 60) {
      throw new VoiceTestError(
        'Áudio inválido ou maior que 60 segundos. Use uma frase curta e PCM16 mono.',
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - start,
      bytes: audio.length,
      audioBase64: pcmToWav(audio, rate).toString('base64'),
      mimeType: 'audio/wav',
      message: 'Áudio gerado. Ouça a prévia abaixo.',
    };
  } catch (error: unknown) {
    const name =
      error && typeof error === 'object' && 'name' in error
        ? String(error.name)
        : '';
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error:
        error instanceof VoiceTestError
          ? error.message
          : name === 'TimeoutError' || name === 'AbortError'
            ? 'Tempo limite excedido. Confira a disponibilidade do endpoint ou aumente o timeout.'
            : name === 'SyntaxError'
              ? 'O endpoint retornou JSON inválido.'
              : 'Não foi possível acessar o endpoint. Confira DNS, HTTPS, certificado e disponibilidade; URLs privadas e redirecionamentos não são aceitos.',
    };
  }
}
