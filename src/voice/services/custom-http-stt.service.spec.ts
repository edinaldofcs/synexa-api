jest.mock('../../common/utils/public-http', () => ({
  publicFetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));
import { CustomHttpSttService } from './custom-http-stt.service';
import { pcmToWav } from '../../common/utils/pcm-wav.util';

const PRIVATE_URL = 'http://127.0.0.1:8080/stt';
const PUBLIC_URL = 'https://stt.cliente.com/api/transcribe';

describe('CustomHttpSttService', () => {
  let service: CustomHttpSttService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    service = new CustomHttpSttService();
    fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue(
      new Response(JSON.stringify({ text: 'ola tudo bem' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any,
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('rejeita baseUrl ausente', async () => {
    await expect(
      service.transcribePcm(Buffer.alloc(320), { apiKey: 'k' }),
    ).rejects.toThrow('baseUrl obrigatório');
  });

  it('bloqueia endereços privados/loopback (SSRF)', async () => {
    await expect(
      service.transcribePcm(Buffer.alloc(320), {
        apiKey: 'k',
        baseUrl: PRIVATE_URL,
      }),
    ).rejects.toThrow('privados/loopback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envia WAV PCM16 16kHz com Authorization Bearer e devolve texto', async () => {
    const pcm = Buffer.alloc(640, 1); // 20ms @16kHz
    const text = await service.transcribePcm(pcm, {
      apiKey: 'chave-do-cliente',
      baseUrl: PUBLIC_URL,
    });

    expect(text).toBe('ola tudo bem');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PUBLIC_URL);
    const headers = (init as any).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer chave-do-cliente');
    expect(headers['Content-Type']).toBe('audio/wav');

    const body = Buffer.from((init as any).body);
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(pcmToWav(pcm, 16000).length).toBe(body.length);
  });

  it('aceita variantes de resposta (transcript/result) e texto puro', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: 'variante' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any,
    );
    await expect(
      service.transcribePcm(Buffer.alloc(320), {
        apiKey: 'k',
        baseUrl: PUBLIC_URL,
      }),
    ).resolves.toBe('variante');

    fetchMock.mockResolvedValue(
      new Response('texto puro', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }) as any,
    );
    await expect(
      service.transcribePcm(Buffer.alloc(320), {
        apiKey: 'k',
        baseUrl: PUBLIC_URL,
      }),
    ).resolves.toBe('texto puro');
  });

  it('propaga erro HTTP com status', async () => {
    fetchMock.mockResolvedValue(
      new Response('unauthorized', { status: 401 }) as any,
    );
    await expect(
      service.transcribePcm(Buffer.alloc(320), {
        apiKey: 'k',
        baseUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow('401');
  });

  it('retorna string vazia para buffer vazio sem chamar endpoint', async () => {
    const result = await service.transcribePcm(Buffer.alloc(0), {
      apiKey: 'k',
      baseUrl: PUBLIC_URL,
    });
    expect(result).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
