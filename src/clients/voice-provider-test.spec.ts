import { pcmToWav } from '../common/utils/pcm-wav.util';
import { testCustomVoiceEndpoint } from './voice-provider-test';
import { publicFetch } from '../common/utils/public-http';
import { TestVoiceProviderDto } from './dto/test-voice-provider.dto';
import { validate } from 'class-validator';

jest.mock('../common/utils/public-http', () => ({ publicFetch: jest.fn() }));
const request = jest.mocked(publicFetch);
const base = { kind: 'tts' as const, baseUrl: 'https://voice.example.com/tts' };

describe('Custom voice configuration tests', () => {
  beforeEach(() => jest.resetAllMocks());

  it('sends the selected text and voice and wraps PCM in playable WAV', async () => {
    request.mockResolvedValue(
      new Response(new Uint8Array([1, 0, 2, 0]), {
        headers: { 'content-type': 'audio/pcm' },
      }),
    );
    const result = await testCustomVoiceEndpoint(
      { ...base, text: 'Olá!', voice: 'voz-1', outputSampleRate: 16000 },
      'test-token',
    );
    expect(request).toHaveBeenCalledWith(
      base.baseUrl,
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          text: 'Olá!',
          voice: 'voz-1',
          language: 'pt',
          format: 'pcm_s16le',
          sample_rate: 16000,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    const wav = Buffer.from(result.audioBase64!, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  it.each(['wav', 'json'])(
    'plays a %s response without treating its header as PCM',
    async (mode) => {
      const wav = pcmToWav(Buffer.alloc(320), 8000);
      request.mockResolvedValue(
        mode === 'wav'
          ? new Response(new Uint8Array(wav), {
              headers: { 'content-type': 'audio/wav' },
            })
          : Response.json({ audio_base64: wav.toString('base64') }),
      );
      const result = await testCustomVoiceEndpoint(base, '');
      expect(Buffer.from(result.audioBase64!, 'base64')).toEqual(wav);
    },
  );

  it('sends an uploaded WAV as binary, and returns its transcription', async () => {
    const wav = pcmToWav(Buffer.alloc(320), 16000);
    request.mockResolvedValue(
      Response.json({ text: 'Preciso de atendimento.' }),
    );
    const result = await testCustomVoiceEndpoint(
      {
        kind: 'stt',
        baseUrl: base.baseUrl,
        audioBase64: wav.toString('base64'),
      },
      '',
    );
    expect(result.text).toBe('Preciso de atendimento.');
    const init = request.mock.calls[0][1]!;
    expect(init.headers).toEqual({ 'Content-Type': 'audio/wav' });
    expect(Buffer.from(init.body as Uint8Array)).toEqual(wav);
  });

  it('retains connection-only STT compatibility and accepts an empty transcript', async () => {
    request.mockResolvedValue(Response.json({ text: '' }));
    const result = await testCustomVoiceEndpoint(
      { kind: 'stt', baseUrl: base.baseUrl },
      '',
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('silêncio');
  });

  it.each([
    Buffer.from('not wav'),
    pcmToWav(Buffer.alloc(160), 8000),
    pcmToWav(Buffer.alloc(160), 16000, 2),
    pcmToWav(Buffer.alloc(16000 * 2 * 21), 16000),
  ])(
    'rejects invalid or oversized STT audio before any network request',
    async (wav) => {
      const result = await testCustomVoiceEndpoint(
        {
          kind: 'stt',
          baseUrl: base.baseUrl,
          audioBase64: wav.toString('base64'),
        },
        '',
      );
      expect(result.ok).toBe(false);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([401, 402, 403, 404, 415, 422, 429, 500])(
    'returns an actionable HTTP %i error without reflecting provider secrets',
    async (status) => {
      request.mockResolvedValue(new Response('do-not-echo-secret', { status }));
      const result = await testCustomVoiceEndpoint(base, 'test-token');
      expect(result.error).toContain('HTTP ' + status);
      expect(JSON.stringify(result)).not.toContain('do-not-echo-secret');
    },
  );

  it.each([
    Response.json({ audio_base64: '%%%' }),
    new Response('<html>error</html>', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'audio/pcm' },
    }),
  ])('rejects malformed TTS output', async (response) => {
    request.mockResolvedValue(response);
    expect((await testCustomVoiceEndpoint(base, '')).ok).toBe(false);
  });

  it('does not accept a JSON error object as a successful STT response', async () => {
    request.mockResolvedValue(Response.json({ error: 'Invalid model' }));
    const result = await testCustomVoiceEndpoint(
      { kind: 'stt', baseUrl: base.baseUrl },
      '',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects private destinations and blank phrases before sending credentials', async () => {
    expect(
      (
        await testCustomVoiceEndpoint(
          { ...base, baseUrl: 'https://127.0.0.1' },
          'secret',
        )
      ).ok,
    ).toBe(false);
    expect(
      (await testCustomVoiceEndpoint({ ...base, text: '  ' }, 'secret')).ok,
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('explains timeouts without echoing transport internals', async () => {
    request.mockRejectedValue(new DOMException('sensitive', 'TimeoutError'));
    const result = await testCustomVoiceEndpoint(base, '');
    expect(result.error).toContain('Tempo limite');
    expect(result.error).not.toContain('sensitive');
  });

  it('validates request limits through the public DTO', async () => {
    const dto = Object.assign(new TestVoiceProviderDto(), base, {
      text: 'x'.repeat(501),
      audioBase64: 'invalid',
      outputSampleRate: 96000,
      timeoutMs: 60000,
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining([
        'text',
        'audioBase64',
        'outputSampleRate',
        'timeoutMs',
      ]),
    );
  });
});
