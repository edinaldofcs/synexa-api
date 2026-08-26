import { G711Codec } from './g711-codec.util';
import { AudioResampler } from './audio-resampler.util';

describe('Audio Codecs & Resampling Utils', () => {
  describe('G711Codec', () => {
    it('deve codificar e decodificar u-law preservando o sinal de áudio', () => {
      const pcmInput = Buffer.alloc(160); // 80 amostras PCM 16-bit
      for (let i = 0; i < 80; i++) {
        const val = Math.round(Math.sin((i / 80) * 2 * Math.PI) * 10000);
        pcmInput.writeInt16LE(val, i * 2);
      }

      const ulaw = G711Codec.encodeUlaw(pcmInput);
      expect(ulaw.length).toBe(80);

      const pcmDecoded = G711Codec.decodeUlaw(ulaw);
      expect(pcmDecoded.length).toBe(160);

      // G.711 é compressão lossy logarítmica, mas a aproximação deve ser próxima
      for (let i = 0; i < 80; i++) {
        const orig = pcmInput.readInt16LE(i * 2);
        const dec = pcmDecoded.readInt16LE(i * 2);
        expect(Math.abs(orig - dec)).toBeLessThan(1000);
      }
    });

    it('deve codificar e decodificar a-law com precisão', () => {
      const pcmInput = Buffer.alloc(160);
      for (let i = 0; i < 80; i++) {
        const val = Math.round(Math.sin((i / 80) * 2 * Math.PI) * 10000);
        pcmInput.writeInt16LE(val, i * 2);
      }

      const alaw = G711Codec.encodeAlaw(pcmInput);
      expect(alaw.length).toBe(80);

      const pcmDecoded = G711Codec.decodeAlaw(alaw);
      expect(pcmDecoded.length).toBe(160);

      for (let i = 0; i < 80; i++) {
        const orig = pcmInput.readInt16LE(i * 2);
        const dec = pcmDecoded.readInt16LE(i * 2);
        expect(Math.abs(orig - dec)).toBeLessThan(1000);
      }
    });
  });

  describe('AudioResampler', () => {
    it('deve fazer upsampling de 8kHz para 16kHz (dobro de amostras)', () => {
      const pcm8k = Buffer.alloc(160); // 80 amostras @ 8kHz (10ms)
      for (let i = 0; i < 80; i++) {
        pcm8k.writeInt16LE(i * 100, i * 2);
      }

      const pcm16k = AudioResampler.telephonyToGemini(pcm8k);
      expect(pcm16k.length).toBe(320); // 160 amostras @ 16kHz (10ms)
    });

    it('deve fazer downsampling de 24kHz para 8kHz (1/3 de amostras)', () => {
      const pcm24k = Buffer.alloc(480); // 240 amostras @ 24kHz (10ms)
      for (let i = 0; i < 240; i++) {
        pcm24k.writeInt16LE(i * 50, i * 2);
      }

      const pcm8k = AudioResampler.geminiToTelephony(pcm24k);
      expect(pcm8k.length).toBe(160); // 80 amostras @ 8kHz (10ms)
    });
  });
});
