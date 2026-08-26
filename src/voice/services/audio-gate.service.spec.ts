import { AudioGateSession, AudioGateService } from './audio-gate.service';
import { ConfigService } from '@nestjs/config';

describe('AudioGateService & AudioGateSession', () => {
  let service: AudioGateService;
  let mockConfigService: { get: jest.Mock };

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    };
    service = new AudioGateService(
      mockConfigService as unknown as ConfigService,
    );
  });

  function createPcmChunk(amplitude: number, samples = 160): string {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer.toString('base64');
  }

  describe('AudioGateSession', () => {
    it('should forward all audio when disabled', () => {
      const session = new AudioGateSession({ enabled: false });
      const chunk = createPcmChunk(100);

      const result = session.processChunk(chunk, false);
      expect(result.forwardChunks).toEqual([chunk]);
      expect(result.isGateOpen).toBe(true);
      expect(result.shouldSendStreamEnd).toBe(false);
    });

    it('should bypass gate and forward immediately when AI is speaking (barge-in path)', () => {
      const session = new AudioGateSession({
        enabled: true,
        threshold: 500,
      });
      const lowEnergyChunk = createPcmChunk(100);

      const result = session.processChunk(lowEnergyChunk, true);
      expect(result.forwardChunks).toContain(lowEnergyChunk);
      expect(result.isGateOpen).toBe(true);
      expect(result.shouldSendStreamEnd).toBe(false);

      const stats = session.getStats();
      expect(stats.forwardedAiSpeakingBytes).toBeGreaterThan(0);
    });

    it('should detect speech above threshold and forward', () => {
      const session = new AudioGateSession({
        enabled: true,
        threshold: 500,
        hangoverMarginMs: 300,
      });
      const speechChunk = createPcmChunk(800);

      const result = session.processChunk(speechChunk, false);
      expect(result.hasVoice).toBe(true);
      expect(result.forwardChunks).toEqual([speechChunk]);
      expect(result.isGateOpen).toBe(true);
    });

    it('should forward silence within hangover margin', () => {
      const session = new AudioGateSession({
        enabled: true,
        threshold: 500,
        hangoverMarginMs: 500,
      });
      const speechChunk = createPcmChunk(800);
      session.processChunk(speechChunk, false);

      const silenceChunk = createPcmChunk(50);
      const result = session.processChunk(silenceChunk, false);

      expect(result.hasVoice).toBe(false);
      expect(result.forwardChunks).toEqual([silenceChunk]);
      expect(result.isGateOpen).toBe(true);
    });

    it('should close gate and send streamEnd once hangover margin expires', async () => {
      const session = new AudioGateSession({
        enabled: true,
        threshold: 500,
        hangoverMarginMs: 50,
        prerollMs: 100,
      });
      const speechChunk = createPcmChunk(800);
      session.processChunk(speechChunk, false);

      // Wait for hangover to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      const silenceChunk = createPcmChunk(50);
      const result = session.processChunk(silenceChunk, false);

      expect(result.isGateOpen).toBe(false);
      expect(result.shouldSendStreamEnd).toBe(true);
      expect(result.forwardChunks).toEqual([]);

      const stats = session.getStats();
      expect(stats.closes).toBe(1);
      expect(stats.suppressedBytes).toBeGreaterThan(0);
    });

    it('should flush pre-roll buffer when reopening upon new speech', async () => {
      const session = new AudioGateSession({
        enabled: true,
        threshold: 500,
        hangoverMarginMs: 30,
        prerollMs: 200,
      });

      // 1. Initial speech
      session.processChunk(createPcmChunk(800), false);

      // 2. Wait to close gate
      await new Promise((resolve) => setTimeout(resolve, 40));
      const preRollChunk1 = createPcmChunk(60);
      const preRollChunk2 = createPcmChunk(70);
      session.processChunk(preRollChunk1, false);
      session.processChunk(preRollChunk2, false);

      // 3. New speech occurs -> Gate reopens and returns preRoll + current speech chunk
      const newSpeechChunk = createPcmChunk(900);
      const result = session.processChunk(newSpeechChunk, false);

      expect(result.isGateOpen).toBe(true);
      expect(result.hasVoice).toBe(true);
      expect(result.forwardChunks).toEqual([
        preRollChunk1,
        preRollChunk2,
        newSpeechChunk,
      ]);
    });
  });

  describe('AudioGateService factory', () => {
    it('should instantiate session with config service values', () => {
      const session = service.createSession({
        threshold: 600,
      });
      expect(session).toBeInstanceOf(AudioGateSession);
      expect(session.threshold).toBe(600);
      expect(session.enabled).toBe(true);
    });
  });
});
