import {
  InworldVoiceService,
  inworldAuthorization,
} from './inworld-voice.service';

describe('Inworld voice', () => {
  const service = new InworldVoiceService();
  const opts = { apiKey: 'test-key', voiceId: 'Mariana' };
  const audio = Buffer.from([1, 0, 2, 0]);
  const line = JSON.stringify({
    result: { audioContent: audio.toString('base64') },
  });
  afterEach(() => jest.restoreAllMocks());

  it('normaliza Basic e rejeita chave vazia', () => {
    expect(inworldAuthorization('Basic test-key')).toBe('Basic test-key');
    expect(() => inworldAuthorization('')).toThrow('Chave');
  });
  it('transcreve PCM usando modelo próprio e idioma português', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ transcription: { transcript: ' Olá ' } }),
        ),
      );
    expect(await service.transcribePcm(audio, opts)).toBe('Olá');
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.transcribeConfig).toEqual({
      modelId: 'inworld/inworld-stt-1',
      audioEncoding: 'LINEAR16',
      sampleRateHertz: 16000,
      numberOfChannels: 1,
      language: 'pt',
    });
    expect(body.audioData.content).toBe(audio.toString('base64'));
  });
  it('decodifica NDJSON fragmentado e última linha sem quebra', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const text = `${line}\n${line}`;
            controller.enqueue(new TextEncoder().encode(text.slice(0, 20)));
            controller.enqueue(new TextEncoder().encode(text.slice(20)));
            controller.close();
          },
        }),
      ),
    );
    expect(await service.synthesize('Olá', opts)).toEqual(
      Buffer.concat([audio, audio]),
    );
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      modelId: 'inworld-tts-2-flash',
      voiceId: 'Mariana',
      audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24000 },
    });
  });
  it('divide textos longos respeitando o limite da API', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(line));
    await service.synthesize('a'.repeat(6000), opts);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(
        ([, init]) => JSON.parse(init!.body as string).text.length,
      ),
    ).toEqual([4000, 2000]);
  });
  it.each([
    ['', 'vazio'],
    [JSON.stringify({ error: { message: 'failure' } }), 'erro'],
    ['invalid', 'JSON'],
  ])('rejeita resposta incompleta/erro %s', async (body) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(service.synthesize('Olá', opts)).rejects.toThrow();
  });
  it('expõe erro HTTP do STT', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }));
    await expect(service.transcribePcm(audio, opts)).rejects.toThrow('401');
  });
  it('mantém ordem de frases e encerra callbacks por frase', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(line));
    const session = service.createSession(opts);
    const onAudioChunk = jest.fn();
    await new Promise<void>((resolve, reject) => {
      let done = 0;
      const callbacks = {
        onAudioChunk,
        onDone: () => {
          if (++done === 2) resolve();
        },
        onError: reject,
      };
      session.pushText('turn', 'primeira', true, callbacks);
      session.pushText('turn', 'segunda', false, callbacks);
      session.finalizeContext('turn');
    });
    expect(
      fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).text),
    ).toEqual(['primeira', 'segunda']);
    expect(onAudioChunk).toHaveBeenCalledTimes(2);
    session.close();
  });
  it('cancela request no barge-in e não entrega áudio atrasado', async () => {
    let signal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const session = service.createSession(opts);
    const onAudioChunk = jest.fn();
    const onDone = jest.fn();
    session.pushText('turn', 'Olá', false, { onAudioChunk, onDone });
    session.cancelContext('turn');
    expect(signal?.aborted).toBe(true);
    finish(new Response(line));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAudioChunk).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    session.close();
    session.pushText('new', 'não enviar', false, { onAudioChunk });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
