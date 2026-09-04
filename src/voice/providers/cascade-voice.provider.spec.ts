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
});
