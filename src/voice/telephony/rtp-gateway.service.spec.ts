import { RtpGatewayService } from './rtp-gateway.service';

describe('RtpGatewayService', () => {
  let service: RtpGatewayService;

  beforeEach(() => {
    service = new RtpGatewayService();
  });

  describe('Audio transcode & resampling', () => {
    it('should decode µ-law and upsample 8kHz to 16kHz PCM16 (4x buffer size)', () => {
      const g711Buffer = Buffer.alloc(160, 0xff); // 160 bytes = 20ms at 8kHz
      const pcm16 = RtpGatewayService.decodeMuLawAndUpsampleTo16(g711Buffer);

      expect(pcm16.length).toBe(160 * 4); // 640 bytes = 20ms at 16kHz PCM16
    });

    it('should decode A-law and upsample 8kHz to 16kHz PCM16', () => {
      const g711Buffer = Buffer.alloc(160, 0x55);
      const pcm16 = RtpGatewayService.decodeALawAndUpsampleTo16(g711Buffer);

      expect(pcm16.length).toBe(160 * 4);
    });

    it('should downsample 24kHz PCM16 to 8kHz and encode to µ-law', () => {
      const pcm24 = Buffer.alloc(480 * 2); // 480 samples = 20ms at 24kHz
      for (let i = 0; i < 480; i++) {
        pcm24.writeInt16LE(1000, i * 2);
      }

      const encoded = RtpGatewayService.downsampleTo8AndEncode(
        pcm24,
        'ulaw',
        24000,
      );
      expect(encoded.length).toBe(160); // 160 bytes = 20ms at 8kHz
    });
  });

  describe('RtpChannelSession instantiation', () => {
    it('should instantiate session with callbacks', () => {
      const session = service.createSession({
        onPcmAudioIn: jest.fn(),
      });
      expect(session).toBeDefined();
      expect(session.codec).toBe('ulaw');
    });
  });

  describe('RtpChannelSession remote pinning (S09)', () => {
    it('fixa o remote esperado no setup e aceita apenas pacotes dele', () => {
      const session = service.createSession({
        onPcmAudioIn: jest.fn(),
      });

      session.setExpectedRemote('10.0.0.5', 10000);

      expect(session.remoteIp).toBe('10.0.0.5');
      expect(session.remotePort).toBe(10000);
      expect(session.shouldAcceptPeer('10.0.0.5')).toBe(true);
      expect(session.shouldAcceptPeer('::ffff:10.0.0.5')).toBe(true);
      expect(session.shouldAcceptPeer('203.0.113.7')).toBe(false);
    });

    it('sem remote esperado, aceita o primeiro pacote (first-packet)', () => {
      const session = service.createSession({
        onPcmAudioIn: jest.fn(),
      });
      expect(session.shouldAcceptPeer('198.51.100.1')).toBe(true);
      expect(session.remoteIp).toBe('');
      expect(session.remotePort).toBe(0);
    });
  });
});
