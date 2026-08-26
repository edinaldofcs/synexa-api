import { HybridSttService } from './hybrid-stt.service';
import { ConfigService } from '@nestjs/config';

describe('HybridSttService', () => {
  let service: HybridSttService;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => undefined),
    };
    service = new HybridSttService(mockConfigService as ConfigService);
  });

  describe('addWavHeader', () => {
    it('should generate a valid 44-byte WAV header', () => {
      const pcm = Buffer.alloc(1600); // 100ms at 16kHz 16-bit mono
      const wav = service.addWavHeader(pcm, 16000);

      expect(wav.length).toBe(44 + 1600);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
      expect(wav.readUInt32LE(24)).toBe(16000); // Sample rate
      expect(wav.readUInt16LE(22)).toBe(1); // Channels = 1 (mono)
      expect(wav.readUInt16LE(34)).toBe(16); // 16 bits per sample
      expect(wav.toString('ascii', 36, 40)).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(1600);
    });
  });

  describe('frameRms and trimSilence', () => {
    it('should compute zero RMS for silent buffer', () => {
      const silentBuffer = Buffer.alloc(640);
      const rms = service.frameRms(silentBuffer, 0, 640);
      expect(rms).toBe(0);
    });

    it('should return null when trimming pure silence', () => {
      const silentBuffer = Buffer.alloc(640 * 10); // 200ms of pure silence
      const result = service.trimSilence(silentBuffer, 500);
      expect(result).toBeNull();
    });

    it('should extract speech window from silence-padded buffer', () => {
      const totalFrames = 15; // 300ms total
      const buffer = Buffer.alloc(totalFrames * 640);

      // Add speech in the middle (frames 5 to 9 = 100ms)
      for (let f = 5; f <= 9; f++) {
        for (let i = 0; i < 320; i++) {
          buffer.writeInt16LE(1500, f * 640 + i * 2);
        }
      }

      const result = service.trimSilence(buffer, 500);
      expect(result).not.toBeNull();
      expect(result!.speechMs).toBe(5 * 20); // 100ms
      expect(result!.pcm.length).toBeLessThanOrEqual(buffer.length);
    });
  });

  describe('isLikelyHallucination', () => {
    it('should identify hallucination patterns on silence', () => {
      expect(service.isLikelyHallucination('Obrigado por assistir!')).toBe(
        true,
      );
      expect(service.isLikelyHallucination('Legendas pela comunidade')).toBe(
        true,
      );
      expect(service.isLikelyHallucination('Inscreva-se no canal')).toBe(true);
      expect(service.isLikelyHallucination('   ')).toBe(true);
      expect(service.isLikelyHallucination('...')).toBe(true);
    });

    it('should allow legitimate user speech', () => {
      expect(
        service.isLikelyHallucination('Olá, gostaria de pagar meu boleto'),
      ).toBe(false);
      expect(service.isLikelyHallucination('Sim, confirmo')).toBe(false);
      expect(service.isLikelyHallucination('Meu CPF é 12345678900')).toBe(
        false,
      );
    });
  });
});
