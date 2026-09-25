import { GoogleTtsSynthesizer } from './google-tts.synthesizer';
describe('Gemini cached greeting synthesis', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('uses Gemini credentials and voice and strips WAV chunks safely', async () => {
    const wav = Buffer.alloc(48);
    wav.write('RIFF');
    wav.writeUInt32LE(40, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24);
    wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(4, 40);
    wav.writeInt16LE(100, 44);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_audio: { data: wav.toString('base64') } }),
    });
    const result = await new GoogleTtsSynthesizer().synthesize('Olá', {
      apiKey: 'test-key',
      voiceId: 'Kore',
    });
    expect(result).toEqual(wav.subarray(44));
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
    expect(options.headers['x-goog-api-key']).toBe('test-key');
    expect(JSON.parse(options.body).generation_config.speech_config).toEqual([
      { voice: 'Kore' },
    ]);
  });
  it('rejects malformed audio rather than playing a container as PCM', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_audio: {
          data: Buffer.from('not a wav file').toString('base64'),
        },
      }),
    });
    await expect(
      new GoogleTtsSynthesizer().synthesize('Olá', { apiKey: 'test-key' }),
    ).rejects.toThrow('WAV inválido');
  });
});
