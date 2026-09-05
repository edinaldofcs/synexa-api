import { SileroVadService, SileroVadSession } from './silero-vad.service';

describe('SileroVadService & SileroVadSession (Silero VAD v5)', () => {
  let service: SileroVadService;

  const createPcmChunk = (amplitude: number, samples = 160): Buffer => {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer;
  };

  beforeAll(async () => {
    service = new SileroVadService();
    await service.onModuleInit();
  });

  it('deve inicializar o modelo ONNX silero_vad.onnx com sucesso', () => {
    expect(service.available).toBe(true);
  });

  it('deve classificar silêncio absoluto com probabilidade de fala próxima de zero', async () => {
    const session = service.createSession();
    const silenceChunk = createPcmChunk(0, 512); // 512 amostras = 1 frame completo

    const result = await session.processChunk(silenceChunk);
    expect(result.isSpeech).toBe(false);
    expect(result.probability).toBeLessThan(0.01);
  });

  it('não deve disparar onSpeechStart em chunks contínuos de ruído baixo', async () => {
    const onSpeechStart = jest.fn();
    const session = service.createSession({ onSpeechStart });

    // Envia 20 frames de ruído ambiente fraco
    const noiseChunk = createPcmChunk(100, 512);
    for (let i = 0; i < 20; i++) {
      await session.processChunk(noiseChunk);
    }

    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(session.speaking).toBe(false);
  });

  it('deve operar com fallback acústico se a sessão ONNX for nula', async () => {
    const onSpeechStart = jest.fn();
    const session = new SileroVadSession(null, { onSpeechStart });

    // Áudio com volume alto simula fala no fallback
    const loudChunk = createPcmChunk(3000, 512);
    const res = await session.processChunk(loudChunk);

    expect(res.isSpeech).toBe(true);
    expect(onSpeechStart).toHaveBeenCalled();
  });
});
