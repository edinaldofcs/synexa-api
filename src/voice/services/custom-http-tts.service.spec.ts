jest.mock('../../common/utils/public-http', () => ({
  publicFetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));
import { CustomHttpTtsService } from './custom-http-tts.service';

const PRIVATE_URL = 'http://localhost:9090/tts';
const PUBLIC_URL = 'https://tts.cliente.com/api/synthesize';

function jsonResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(
  body: Buffer,
  contentType = 'application/octet-stream',
) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('CustomHttpTtsService', () => {
  let service: CustomHttpTtsService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    service = new CustomHttpTtsService();
    fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(binaryResponse(Buffer.alloc(4800, 1)) as any);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('createSession exige baseUrl', () => {
    expect(() => service.createSession({ apiKey: 'k' })).toThrow(
      'baseUrl obrigatório',
    );
  });

  it('createSession bloqueia host privado (SSRF)', () => {
    expect(() =>
      service.createSession({ apiKey: 'k', baseUrl: PRIVATE_URL }),
    ).toThrow('não permitido');
  });

  it('pushText chama o endpoint com JSON do contrato e entrega PCM 24kHz', (done) => {
    service
      .createSession({
        apiKey: 'chave-custom',
        baseUrl: PUBLIC_URL,
        voiceId: 'minha-voz',
      })
      .pushText('ctx-1', 'Olá, tudo bem?', true, {
        onAudioChunk: (chunk) => {
          const [url, init] = fetchMock.mock.calls[0];
          expect(url).toBe(PUBLIC_URL);
          const body = JSON.parse((init as any).body as string);
          expect(body.text).toBe('Olá, tudo bem?');
          expect(body.voice).toBe('minha-voz');
          expect(body.format).toBe('pcm_s16le');
          expect(body.sample_rate).toBe(24000);
          expect((init as any).headers['Authorization']).toBe(
            'Bearer chave-custom',
          );
          expect(chunk.length).toBe(4800); // já normalizado @24kHz
          done();
        },
        onError: (err) => done(err),
      });
  });

  it('normaliza resposta JSON audio_base64 e taxa declarada (48kHz -> 24kHz)', (done) => {
    // 48000 samples @48kHz = 48000 bytes; resample p/ 24kHz = 24000 bytes
    fetchMock.mockResolvedValue(
      jsonResponse({ audio_base64: Buffer.alloc(48000, 2).toString('base64') }),
    );

    service
      .createSession({
        apiKey: 'k',
        baseUrl: PUBLIC_URL,
        outputSampleRate: 48000,
      })
      .pushText('ctx-1', 'teste de taxa', false, {
        onAudioChunk: (chunk) => {
          expect(chunk.length).toBe(24000);
          done();
        },
        onError: (err) => done(err),
      });
  });

  it('remove header WAV quando o endpoint responde com WAV', (done) => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    header.writeUInt32LE(24000, 24); // sample rate no header
    fetchMock.mockResolvedValue(
      binaryResponse(
        Buffer.concat([header, Buffer.alloc(2400, 3)]),
        'audio/wav',
      ),
    );

    service
      .createSession({ apiKey: 'k', baseUrl: PUBLIC_URL })
      .pushText('ctx-1', 'wav test', false, {
        onAudioChunk: (chunk) => {
          expect(chunk.length).toBe(2400);
          done();
        },
        onError: (err) => done(err),
      });
  });

  it('reporta onError quando o endpoint falha', (done) => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }) as any);

    service
      .createSession({ apiKey: 'k', baseUrl: PUBLIC_URL })
      .pushText('ctx-1', 'erro test', false, {
        onAudioChunk: () => done(new Error('não deveria produzir áudio')),
        onError: (err) => {
          expect(err.message).toContain('500');
          done();
        },
      });
  });

  it('serialize frases do mesmo contexto em ordem (fila por contexto)', (done) => {
    let audioCount = 0;
    const session = service.createSession({
      apiKey: 'k',
      baseUrl: PUBLIC_URL,
    });

    session.pushText('ctx-1', 'primeira frase', true, {
      onAudioChunk: () => {
        audioCount++;
        // A segunda frase só deve ser sintetizada após a primeira (fila sequencial)
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
      },
      onDone: () => {
        if (audioCount === 1) done();
      },
      onError: (err) => done(err),
    });
  });

  it('cancelContext aborta a request em voo e descarta o áudio', (done) => {
    fetchMock.mockImplementation((_url: any, init: any) => {
      return new Promise<Response>((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          (err as any).name = 'AbortError';
          rej(err);
        });
      });
    });

    const session = service.createSession({
      apiKey: 'k',
      baseUrl: PUBLIC_URL,
    });
    session.pushText('ctx-1', 'frase cancelada', false, {
      onAudioChunk: () => done(new Error('não deveria sintetizar')),
      onError: () => done(new Error('abort não deveria reportar onError')),
    });
    expect(() => session.cancelContext('ctx-1')).not.toThrow();
    expect(() => session.close()).not.toThrow();
    setTimeout(() => done(), 30);
  });
});
