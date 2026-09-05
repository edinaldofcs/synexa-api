import { SileroVadService, SileroVadSession } from './silero-vad.service';

describe('SileroVadService & SileroVadSession (Silero VAD v5)', () => {
  let service: SileroVadService;

  const createPcmChunk = (amplitude: number, samples = 512): Buffer => {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer;
  };

  const createMockOrt = () => ({
    Tensor: class {
      constructor(public type: string, public data: any, public dims: any) {}
    },
  });

  beforeAll(async () => {
    service = new SileroVadService();
    await service.onModuleInit();
  });

  it('deve inicializar o serviço Silero VAD', () => {
    expect(service).toBeDefined();
  });

  it('deve classificar silêncio absoluto com probabilidade de fala baixa', async () => {
    const mockInferenceSession = {
      run: jest.fn().mockResolvedValue({
        output: { data: [0.0005] },
        stateN: {},
      }),
    };
    const session = new SileroVadSession(
      mockInferenceSession,
      createMockOrt(),
      { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35 },
    );
    const silenceChunk = createPcmChunk(0, 512);

    const result = await session.processChunk(silenceChunk);
    expect(result.isSpeech).toBe(false);
    expect(result.probability).toBeLessThan(0.01);
  });

  it('deve disparar onSpeechStart quando Silero VAD detectar fala contínua', async () => {
    const onSpeechStart = jest.fn();
    const mockInferenceSession = {
      run: jest.fn().mockResolvedValue({
        output: { data: [0.95] },
        stateN: {},
      }),
    };
    const session = new SileroVadSession(
      mockInferenceSession,
      createMockOrt(),
      {
        positiveSpeechThreshold: 0.5,
        minSpeechFrames: 2,
        onSpeechStart,
      },
    );

    const speechChunk = createPcmChunk(3000, 512);
    await session.processChunk(speechChunk);
    expect(onSpeechStart).not.toHaveBeenCalled(); // Precisa de 2 frames (minSpeechFrames)

    await session.processChunk(speechChunk);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(session.speaking).toBe(true);
  });

  it('deve disparar onSpeechEnd após redemptionFrames de silêncio', async () => {
    const onSpeechEnd = jest.fn();
    let currentProb = 0.95;
    const mockInferenceSession = {
      run: jest.fn().mockImplementation(() =>
        Promise.resolve({
          output: { data: [currentProb] },
          stateN: {},
        }),
      ),
    };
    const session = new SileroVadSession(
      mockInferenceSession,
      createMockOrt(),
      {
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.3,
        minSpeechFrames: 2,
        redemptionFrames: 3,
        onSpeechEnd,
      },
    );

    const chunk = createPcmChunk(2000, 512);
    // Ativa fala
    await session.processChunk(chunk);
    await session.processChunk(chunk);
    expect(session.speaking).toBe(true);

    // Entra em silêncio
    currentProb = 0.05;
    const silence = createPcmChunk(0, 512);
    await session.processChunk(silence); // frame 1
    await session.processChunk(silence); // frame 2
    expect(session.speaking).toBe(true);

    await session.processChunk(silence); // frame 3 -> fecha turno
    expect(session.speaking).toBe(false);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(onSpeechEnd.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('deve operar com fallback acústico se a sessão ONNX for nula', async () => {
    const onSpeechStart = jest.fn();
    const session = new SileroVadSession(null, null, { onSpeechStart });

    // Áudio com volume alto simula fala no fallback
    const loudChunk = createPcmChunk(3000, 512);
    const res = await session.processChunk(loudChunk);

    expect(res.isSpeech).toBe(true);
    expect(onSpeechStart).toHaveBeenCalled();
  });
});
