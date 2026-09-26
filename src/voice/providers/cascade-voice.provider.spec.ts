import { CascadeVoiceProvider } from './cascade-voice.provider';
import { CartesiaTtsService } from '../services/cartesia-tts.service';
import { GroqWhisperSttService } from '../services/groq-whisper-stt.service';

describe('CascadeVoiceProvider - VAD & Barge-In Debounce', () => {
  let cartesiaService: jest.Mocked<CartesiaTtsService>;
  let groqWhisperService: jest.Mocked<GroqWhisperSttService>;
  let mockSession: {
    pushText: jest.Mock;
    finalizeContext: jest.Mock;
    cancelContext: jest.Mock;
    close: jest.Mock;
  };

  const createPcmChunk = (amplitude: number, samples = 160): string => {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer.toString('base64');
  };

  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(''));
    mockSession = {
      pushText: jest.fn(),
      finalizeContext: jest.fn(),
      cancelContext: jest.fn(),
      close: jest.fn(),
    };

    cartesiaService = {
      createSession: jest.fn().mockReturnValue(mockSession),
    } as any;

    groqWhisperService = {
      transcribePcm: jest.fn(),
    } as any;
  });

  it('não deve interromper a fala da IA em chunks de silêncio ou ruído ambiente', () => {
    const onInterrupted = jest.fn();
    const provider = new CascadeVoiceProvider(
      cartesiaService,
      groqWhisperService,
    );
    provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

    // Simula que a IA está falando
    (provider as any).isSpeaking = true;

    // Envia múltiplos chunks de baixo volume (ruído de fundo: amplitude 100)
    const silenceChunk = createPcmChunk(100);
    for (let i = 0; i < 10; i++) {
      provider.sendAudio(silenceChunk);
    }

    expect(onInterrupted).not.toHaveBeenCalled();
    expect(mockSession.cancelContext).not.toHaveBeenCalled();
    expect((provider as any).isSpeaking).toBe(true);
  });

  it('deve confirmar barge-in e interromper a IA após frames consecutivos de voz real', () => {
    const onInterrupted = jest.fn();
    const provider = new CascadeVoiceProvider(
      cartesiaService,
      groqWhisperService,
    );
    provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

    // Simula que a IA está falando
    (provider as any).isSpeaking = true;

    // Chunk de voz humana real (amplitude 3000)
    const voiceChunk = createPcmChunk(3000);

    // 1º frame: inicia contagem, ainda não corta
    provider.sendAudio(voiceChunk);
    expect(onInterrupted).not.toHaveBeenCalled();

    // 2º frame: confirma barge-in e corta imediatamente
    provider.sendAudio(voiceChunk);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect((provider as any).isSpeaking).toBe(false);
  });

  it('não deve enviar silêncio acumulado ao Whisper se o usuário não falou', async () => {
    const onUserTranscript = jest.fn();
    const provider = new CascadeVoiceProvider(
      cartesiaService,
      groqWhisperService,
    );
    provider.connect({ apiKey: 'k', systemPrompt: 'p', onUserTranscript });

    // IA calada, usuário mudo (apenas ruído ambiente do mic)
    const silenceChunk = createPcmChunk(80);
    for (let i = 0; i < 20; i++) {
      provider.sendAudio(silenceChunk);
    }

    provider.sendAudioStreamEnd();

    expect(groqWhisperService.transcribePcm).not.toHaveBeenCalled();
    expect(onUserTranscript).not.toHaveBeenCalled();
  });

  it('deve filtrar alucinações comuns do Whisper em áudios de baixa energia', async () => {
    const onUserTranscript = jest.fn();
    const provider = new CascadeVoiceProvider(
      cartesiaService,
      groqWhisperService,
    );
    provider.connect({
      apiKey: 'k',
      systemPrompt: 'p',
      groqApiKey: 'g-k',
      onUserTranscript,
    });

    // Simula áudio com voz limiar
    (provider as any).hasVoiceInCurrentTurn = true;
    (provider as any).inboundAudioBuffers = [Buffer.alloc(16000, 50)]; // ~500ms de áudio fraco

    groqWhisperService.transcribePcm.mockResolvedValueOnce('Obrigado.');

    provider.sendAudioStreamEnd();

    // Aguarda o promise resolver
    await new Promise((r) => setTimeout(r, 20));

    // A alucinação deve ter sido descartada e não disparar transcrição do usuário
    expect(onUserTranscript).not.toHaveBeenCalled();
  });

  describe('Integração com Silero VAD v5', () => {
    let mockVadSession: any;
    let sileroVadService: any;

    beforeEach(() => {
      mockVadSession = {
        processChunk: jest
          .fn()
          .mockResolvedValue({ isSpeech: false, probability: 0 }),
        reset: jest.fn(),
        flush: jest.fn().mockReturnValue(null),
        speaking: false,
        probability: 0,
      };

      sileroVadService = {
        createSession: jest.fn().mockImplementation((opts) => {
          mockVadSession._opts = opts;
          return mockVadSession;
        }),
      };
    });

    it('deve inicializar SileroVadSession na conexão e delegar chunks de áudio', () => {
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p' });

      expect(sileroVadService.createSession).toHaveBeenCalled();

      const chunk = createPcmChunk(500, 512);
      provider.sendAudio(chunk);

      expect(mockVadSession.processChunk).toHaveBeenCalled();
    });

    it('deve interromper a IA quando onSpeechStart do Silero VAD for disparado durante a fala', () => {
      const onInterrupted = jest.fn();
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

      // IA falando: áudio já enfileirado no cliente (janela de reprodução ativa).
      // Apenas isSpeaking=true (LLM gerando, janela morta) NÃO deve interromper.
      (provider as any).isSpeaking = true;
      (provider as any).aiPlaybackUntil = Date.now() + 2000;
      (provider as any).activeContextId = 'ctx-1';

      // Dispara o callback de onSpeechStart configurado na sessão
      mockVadSession._opts.onSpeechStart();

      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect((provider as any).isSpeaking).toBe(false);
      expect(mockSession.cancelContext).toHaveBeenCalledWith('ctx-1');
    });

    it('não deve interromper durante a janela morta de geração do LLM (sem áudio reproduzindo)', () => {
      const onInterrupted = jest.fn();
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

      // LLM gerando (isSpeaking=true) mas nenhum chunk de áudio entregue ainda
      (provider as any).isSpeaking = true;
      (provider as any).activeContextId = 'ctx-1';

      mockVadSession._opts.onSpeechStart();

      expect(onInterrupted).not.toHaveBeenCalled();
      expect((provider as any).isSpeaking).toBe(true);
    });

    it('deve confirmar barge-in se o usuário falar durante a janela de reprodução do áudio (aiPlaybackUntil) mesmo com isSpeaking false', () => {
      const onInterrupted = jest.fn();
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

      // Simula que a síntese Cartesia já terminou (isSpeaking = false), mas ainda faltam 2 segundos de áudio tocando no cliente
      (provider as any).isSpeaking = false;
      (provider as any).aiPlaybackUntil = Date.now() + 2000;
      (provider as any).activeContextId = 'ctx-2';

      mockVadSession._opts.onSpeechStart();

      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect((provider as any).aiPlaybackUntil).toBe(0);
      expect(mockSession.cancelContext).toHaveBeenCalledWith('ctx-2');
    });

    it('deve processar fala quando onSpeechEnd do Silero VAD for disparado', async () => {
      const onUserTranscript = jest.fn();
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({
        apiKey: 'k',
        systemPrompt: 'p',
        groqApiKey: 'g-k',
        onUserTranscript,
      });

      groqWhisperService.transcribePcm.mockResolvedValueOnce(
        'Olá, como posso ajudar?',
      );

      // Gera um buffer de fala de 500ms com energia audível
      const speechBuffer = Buffer.alloc(16000);
      for (let i = 0; i < 8000; i++) {
        speechBuffer.writeInt16LE(2000, i * 2);
      }

      mockVadSession._opts.onSpeechEnd(speechBuffer);

      await new Promise((r) => setTimeout(r, 20));

      expect(groqWhisperService.transcribePcm).toHaveBeenCalledWith(
        speechBuffer,
        expect.objectContaining({ apiKey: 'g-k' }),
      );
      expect(onUserTranscript).toHaveBeenCalledWith('Olá, como posso ajudar?');
    });

    it('deve descarregar buffer via flush no sendAudioStreamEnd e resetar no close', () => {
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p' });

      provider.sendAudioStreamEnd();
      expect(mockVadSession.flush).toHaveBeenCalled();

      provider.close();
      expect(mockVadSession.reset).toHaveBeenCalled();
    });

    it('seedGreetingTurn registra histórico inicial da IA sem disparar síntese de fala', () => {
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p' });

      provider.seedGreetingTurn('Olá, falo com Edinaldo?');

      const history = (provider as any).conversationHistory;
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        role: 'user',
        parts: [{ text: '[INÍCIO DA LIGAÇÃO / ATENDIMENTO INICIADO]' }],
      });
      expect(history[1]).toEqual({
        role: 'model',
        parts: [{ text: 'Olá, falo com Edinaldo?' }],
      });
      // Garante que o Cartesia TTS NÃO foi acionado
      expect(mockSession.pushText).not.toHaveBeenCalled();
    });

    it('setInterruptionBlocked impede interrupção da saudação inicial pelo Silero VAD', () => {
      const onInterrupted = jest.fn();
      const provider = new CascadeVoiceProvider(
        cartesiaService,
        groqWhisperService,
        sileroVadService,
      );
      provider.connect({ apiKey: 'k', systemPrompt: 'p', onInterrupted });

      // Simula saudação tocando com bloqueio ativo
      (provider as any).isSpeaking = true;
      provider.setInterruptionBlocked(true);

      // Silero detecta voz ou ruído de barge-in
      mockVadSession._opts.onSpeechStart();

      // Interrupção DEVE ser ignorada
      expect(onInterrupted).not.toHaveBeenCalled();
      expect(mockSession.cancelContext).not.toHaveBeenCalled();
      expect((provider as any).isSpeaking).toBe(true);

      // Ao desbloquear a interrupção (saudação terminou), deve resetar a sessão do VAD
      provider.setInterruptionBlocked(false);
      expect(mockVadSession.reset).toHaveBeenCalled();
    });
  });
});

describe('CascadeVoiceProvider transfer isolation', () => {
  const options = { apiKey: 'test', systemPrompt: 'test', groqApiKey: 'test' };
  function setup() {
    const tts = {
      pushText: jest.fn(),
      finalizeContext: jest.fn(),
      cancelContext: jest.fn(),
      close: jest.fn(),
    };
    const stt = { transcribePcm: jest.fn() };
    const provider = new CascadeVoiceProvider(
      { createSession: () => tts },
      stt,
    );
    return { provider, tts, stt };
  }
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('always aborts on close without emitting a user interruption', () => {
    const { provider } = setup();
    const onInterrupted = jest.fn();
    provider.connect({ ...options, allowInterruption: false, onInterrupted });
    const controller = new AbortController();
    Object.assign(provider, { abortController: controller, isSpeaking: true });
    provider.close();
    expect(controller.signal.aborted).toBe(true);
    expect((provider as any).isSpeaking).toBe(false);
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it('discards STT that finishes after reconnect instead of starting a new answer', async () => {
    const { provider, stt } = setup();
    let finish!: (text: string) => void;
    stt.transcribePcm.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Unexpected request'));
    provider.connect(options);
    const pending = (provider as any).processUserSpeech(
      Buffer.alloc(100),
      1000,
      2000,
    );
    provider.close();
    const onUserTranscript = jest.fn();
    provider.connect({ ...options, onUserTranscript });
    finish('old transcript');
    await pending;
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    provider.close();
  });

  it('ignores old TTS callbacks after reconnect', () => {
    const { provider, tts } = setup();
    provider.connect(options);
    (provider as any).activeContextId = 'old';
    (provider as any).pushToCartesia('old', 'Hello', false);
    const callbacks = tts.pushText.mock.calls[0][3];
    provider.close();
    const onAudio = jest.fn(),
      onTurnComplete = jest.fn(),
      onError = jest.fn();
    provider.connect({ ...options, onAudio, onTurnComplete, onError });
    callbacks.onAudioChunk(Buffer.alloc(4800));
    callbacks.onDone();
    callbacks.onError(new Error('late error'));
    expect(onAudio).not.toHaveBeenCalled();
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    provider.close();
  });

  it('waits for synthesis and playback before completing a transfer', async () => {
    jest.useFakeTimers();
    const { provider, tts } = setup();
    provider.connect(options);
    (provider as any).activeContextId = 'speech';
    (provider as any).pushToCartesia('speech', 'Hello', false);
    const callbacks = tts.pushText.mock.calls[0][3];
    const completed = jest.fn();
    const drain = provider.waitForOutput().then(completed);
    await jest.advanceTimersByTimeAsync(100);
    expect(completed).not.toHaveBeenCalled();
    callbacks.onAudioChunk(Buffer.alloc(48000));
    callbacks.onDone();
    await jest.advanceTimersByTimeAsync(900);
    expect(completed).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(150);
    await drain;
    expect(completed).toHaveBeenCalledTimes(1);
    provider.close();
  });

  it('bounds a transfer wait when TTS never completes', async () => {
    jest.useFakeTimers();
    const { provider } = setup();
    provider.connect(options);
    (provider as any).activeContextId = 'speech';
    (provider as any).pushToCartesia('speech', 'Hello', false);
    const drain = provider.waitForOutput();
    await jest.advanceTimersByTimeAsync(15000);
    await drain;
    provider.close();
  });
  it('ignores a late LLM stream after the provider is reused', async () => {
    const { provider, tts } = setup();
    let finish!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    const read = jest.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finish = resolve;
        }),
    );
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as any);
    provider.connect({ ...options, allowInterruption: false });
    const pending = (provider as any).streamLlmResponse();
    await Promise.resolve();
    expect(read).toHaveBeenCalled();
    provider.close();
    const onAiTranscript = jest.fn();
    provider.connect({ ...options, onAiTranscript });
    finish({
      done: false,
      value: new TextEncoder().encode(
        'data: {"candidates":[{"content":{"parts":[{"text":"Old answer."}]}}]}\n',
      ),
    });
    await pending;
    expect(onAiTranscript).not.toHaveBeenCalled();
    expect(tts.pushText).not.toHaveBeenCalled();
    provider.close();
  });

  it('does not finish a transfer between HTTP TTS phrases', async () => {
    jest.useFakeTimers();
    const { provider, tts } = setup();
    provider.connect({
      ...options,
      ttsProvider: 'custom',
      customTts: { baseUrl: 'https://tts.example.test', apiKey: 'test' },
    });
    (provider as any).activeContextId = 'speech';
    (provider as any).pushToCartesia('speech', 'First.', true);
    (provider as any).pushToCartesia('speech', 'Second.', false);
    const first = tts.pushText.mock.calls[0][3];
    const second = tts.pushText.mock.calls[1][3];
    const completed = jest.fn();
    const drain = provider.waitForOutput().then(completed);
    first.onAudioChunk(Buffer.alloc(4800));
    first.onDone();
    await jest.advanceTimersByTimeAsync(1000);
    expect(completed).not.toHaveBeenCalled();
    second.onAudioChunk(Buffer.alloc(4800));
    second.onDone();
    await jest.advanceTimersByTimeAsync(200);
    await drain;
    expect(completed).toHaveBeenCalledTimes(1);
    provider.close();
  });
});
