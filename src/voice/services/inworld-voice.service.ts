import { Logger } from '@nestjs/common';
import type {
  StreamingTtsSessionFactory,
  StreamingTtsSessionOptions,
  StreamingTtsSessionCallbacks,
  SttTranscriber,
  SttTranscribeOptions,
} from '../providers/custom-voice.types';
import type {
  ITtsSynthesizer,
  TtsSynthesizeOptions,
} from './synthesizers/tts-synthesizer.interface';

export function inworldAuthorization(key: string): string {
  const value = key.trim().replace(/^Basic\s+/i, '');
  if (!value || /[\r\n]/.test(value))
    throw new Error('Chave Inworld inválida ou ausente.');
  return `Basic ${value}`;
}

/** Stateless adapter: each call owns its cancellation and audio queue. */
export class InworldVoiceService
  implements StreamingTtsSessionFactory, SttTranscriber, ITtsSynthesizer
{
  readonly providerName = 'inworld';
  private readonly logger = new Logger(InworldVoiceService.name);

  static async validateCredentials(apiKey: string): Promise<void> {
    const res = await fetch(
      'https://api.inworld.ai/voices/v1/voices?pageSize=1',
      {
        headers: { Authorization: inworldAuthorization(apiKey) },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok)
      throw new Error(
        `Inworld HTTP ${res.status}: não foi possível validar a credencial.`,
      );
    await res.body?.cancel();
  }

  async transcribePcm(
    pcm: Buffer,
    options: SttTranscribeOptions,
  ): Promise<string> {
    if (!pcm.length || pcm.length % 2 || pcm.length > 20 * 1024 * 1024)
      throw new Error('Áudio PCM inválido para Inworld STT.');
    const res = await fetch('https://api.inworld.ai/stt/v1/transcribe', {
      method: 'POST',
      headers: {
        Authorization: inworldAuthorization(options.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transcribeConfig: {
          modelId: 'inworld/inworld-stt-1',
          audioEncoding: 'LINEAR16',
          sampleRateHertz: options.sampleRate || 16000,
          numberOfChannels: 1,
          language: options.language || 'pt',
        },
        audioData: { content: pcm.toString('base64') },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Inworld STT HTTP ${res.status}`);
    const json = await res.json();
    if (typeof json.transcription?.transcript !== 'string')
      throw new Error('Inworld STT retornou uma resposta inválida.');
    return json.transcription.transcript.trim();
  }

  private async stream(
    text: string,
    options: StreamingTtsSessionOptions,
    onAudio: (audio: Buffer) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // Split before dispatch: upstream accepts at most 4000 UTF-16 units per request.
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 4000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const part = text.slice(offset, end);
      offset = end;
      signal.throwIfAborted();
      const res = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
        method: 'POST',
        headers: {
          Authorization: inworldAuthorization(options.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: part,
          voiceId: options.voiceId || 'Mariana',
          modelId: 'inworld-tts-2-flash',
          audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24000 },
        }),
        signal,
      });
      if (!res.ok || !res.body)
        throw new Error(`Inworld TTS HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let bytes = 0;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const item = JSON.parse(line);
        if (item.error)
          throw new Error('Inworld TTS retornou erro durante a síntese.');
        const content = item.result?.audioContent;
        if (content === undefined) return;
        if (
          typeof content !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
        )
          throw new Error('Áudio Inworld inválido.');
        const audio = Buffer.from(content, 'base64');
        bytes += audio.length;
        if (audio.length % 2 || bytes > 20 * 1024 * 1024)
          throw new Error('Áudio Inworld fora dos limites.');
        signal.throwIfAborted();
        if (audio.length) onAudio(audio);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            consume(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          if (pending.length > 4 * 1024 * 1024)
            throw new Error('Resposta Inworld excedeu o limite.');
        }
        consume(pending + decoder.decode());
        if (!bytes) throw new Error('Inworld TTS retornou áudio vazio.');
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }

  async synthesize(
    text: string,
    options: TtsSynthesizeOptions,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.stream(
      text,
      options,
      (audio) => chunks.push(audio),
      AbortSignal.timeout(30_000),
    );
    return Buffer.concat(chunks);
  }

  createSession(options: StreamingTtsSessionOptions) {
    inworldAuthorization(options.apiKey);
    type State = {
      queue: { text: string; callbacks: StreamingTtsSessionCallbacks }[];
      running: boolean;
      finalized: boolean;
      cancelled: boolean;
      controller?: AbortController;
    };
    const contexts = new Map<string, State>();
    let closed = false;
    const run = async (id: string, state: State) => {
      if (state.running) return;
      state.running = true;
      while (state.queue.length && !closed && !state.cancelled) {
        const phrase = state.queue.shift()!;
        state.controller = new AbortController();
        try {
          await this.stream(
            phrase.text,
            options,
            (chunk) => {
              if (!closed && !state.cancelled)
                phrase.callbacks.onAudioChunk(chunk);
            },
            AbortSignal.any([
              state.controller.signal,
              AbortSignal.timeout(30_000),
            ]),
          );
          if (!closed && !state.cancelled) phrase.callbacks.onDone?.();
        } catch (error) {
          if (!closed && !state.cancelled) {
            const err =
              error instanceof Error ? error : new Error('Falha Inworld TTS');
            this.logger.error(err.message);
            phrase.callbacks.onError?.(err);
          }
        }
      }
      state.running = false;
      if (state.finalized || state.cancelled || closed) contexts.delete(id);
    };
    return {
      pushText: (
        id: string,
        text: string,
        _continue: boolean,
        callbacks: StreamingTtsSessionCallbacks,
      ) => {
        if (closed || !text.trim()) return;
        let state = contexts.get(id);
        if (!state) {
          state = {
            queue: [],
            running: false,
            finalized: false,
            cancelled: false,
          };
          contexts.set(id, state);
        }
        if (state.cancelled) return;
        state.queue.push({ text, callbacks });
        void run(id, state);
      },
      finalizeContext: (id: string) => {
        const state = contexts.get(id);
        if (state) {
          state.finalized = true;
          if (!state.running) contexts.delete(id);
        }
      },
      cancelContext: (id: string) => {
        const state = contexts.get(id);
        if (state) {
          state.cancelled = true;
          state.queue = [];
          state.controller?.abort();
          if (!state.running) contexts.delete(id);
        }
      },
      close: () => {
        closed = true;
        for (const state of contexts.values()) {
          state.cancelled = true;
          state.queue = [];
          state.controller?.abort();
        }
        contexts.clear();
      },
    };
  }
}
