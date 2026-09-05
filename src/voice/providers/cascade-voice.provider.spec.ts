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

  beforeEach(() => {
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
    const provider = new CascadeVoiceProvider(cartesiaService, groqWhisperService);
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
    const provider = new CascadeVoiceProvider(cartesiaService, groqWhisperService);
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
    const provider = new CascadeVoiceProvider(cartesiaService, groqWhisperService);
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
    const provider = new CascadeVoiceProvider(cartesiaService, groqWhisperService);
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
        processChunk: jest.fn().mockResolvedValue({ isSpeech: false, probability: 0 }),
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

      (provider as any).isSpeaking = true;
      (provider as any).activeContextId = 'ctx-1';

      // Dispara o callback de onSpeechStart configurado na sessão
      mockVadSession._opts.onSpeechStart();

      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect((provider as any).isSpeaking).toBe(false);
      expect(mockSession.cancelContext).toHaveBeenCalledWith('ctx-1');
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

      groqWhisperService.transcribePcm.mockResolvedValueOnce('Olá, como posso ajudar?');

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
  });
});
