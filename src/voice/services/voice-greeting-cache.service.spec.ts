import { VoiceGreetingCacheService } from './voice-greeting-cache.service';
import { RedisService } from '../../common/redis/redis.service';
import { TtsSynthesizerFactory } from './synthesizers/tts-synthesizer.factory';

describe('VoiceGreetingCacheService', () => {
  let service: VoiceGreetingCacheService;
  let mockRedis: jest.Mocked<RedisService>;
  let mockSynthesizerFactory: jest.Mocked<TtsSynthesizerFactory>;
  let mockSynthesizer: { synthesize: jest.Mock; providerName: string };

  beforeEach(() => {
    const mockClient = {
      keys: jest.fn(),
      del: jest.fn(),
    };

    mockRedis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      expire: jest.fn().mockResolvedValue(undefined),
      getClient: jest.fn().mockReturnValue(mockClient),
    } as any;

    mockSynthesizer = {
      providerName: 'cartesia',
      synthesize: jest
        .fn()
        .mockResolvedValue(Buffer.from('fake-pcm-buffer-data')),
    };

    mockSynthesizerFactory = {
      get: jest.fn().mockReturnValue(mockSynthesizer),
      has: jest.fn().mockReturnValue(true),
    } as any;

    service = new VoiceGreetingCacheService(mockRedis, mockSynthesizerFactory);
  });

  describe('buildCacheKey', () => {
    it('deve gerar chave determinística com provedor, voz, template e nome sanitizado', () => {
      const key = service.buildCacheKey({
        companyId: 'comp-123',
        agentId: 'ag-456',
        provider: 'cartesia',
        voiceId: 'cb2694c3',
        template: 'Olá, falo com {{primeiro_nome}}?',
        customerName: 'EDINALDO DA SILVA',
      });

      expect(key).toContain(
        'voice:greeting:comp-123:ag-456:cartesia:cb2694c3:',
      );
      expect(key).toContain(':edinaldo');
    });

    it('deve normalizar anon quando cliente não possuir nome', () => {
      const key = service.buildCacheKey({
        provider: 'google',
        voiceId: 'Aoede',
        template: 'Olá, tudo bem?',
      });

      expect(key).toContain('voice:greeting:global:default:google:aoede:');
      expect(key.endsWith(':anon')).toBe(true);
    });
  });

  describe('getGreetingAudio', () => {
    it('deve retornar Buffer quando o áudio estiver em cache no Redis (HIT)', async () => {
      const samplePcm = Buffer.from('audio-pcm-16bit');
      mockRedis.get.mockResolvedValueOnce(samplePcm.toString('base64'));

      const result = await service.getGreetingAudio({
        provider: 'cartesia',
        voiceId: 'sofia',
        template: 'Olá {{primeiro_nome}}',
        customerName: 'Edinaldo',
      });

      expect(result).toEqual(samplePcm);
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
    });

    it('deve retornar null quando o áudio não existir no Redis (MISS)', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await service.getGreetingAudio({
        provider: 'cartesia',
        voiceId: 'sofia',
        template: 'Olá {{primeiro_nome}}',
        customerName: 'Edinaldo',
      });

      expect(result).toBeNull();
    });
  });

  describe('resolveOrSynthesizeGreeting', () => {
    it('deve retornar áudio do cache com fromCache=true em caso de HIT (0ms)', async () => {
      const samplePcm = Buffer.from('audio-em-cache');
      mockRedis.get.mockResolvedValueOnce(samplePcm.toString('base64'));

      const res = await service.resolveOrSynthesizeGreeting({
        provider: 'cartesia',
        voiceId: 'sofia',
        template: 'Olá {{primeiro_nome}}, tudo bem?',
        customerName: 'Edinaldo da Silva',
        apiKey: 'fake-api-key',
      });

      expect(res.fromCache).toBe(true);
      expect(res.audioBuffer).toEqual(samplePcm);
      expect(res.sanitizedName).toBe('Edinaldo');
      expect(res.text).toBe('Olá Edinaldo, tudo bem?');
      expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
    });

    it('deve sintetizar via provedor e salvar no Redis em caso de MISS', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const freshlyGeneratedPcm = Buffer.from('audio-novo-sintetizado');
      mockSynthesizer.synthesize.mockResolvedValueOnce(freshlyGeneratedPcm);

      const res = await service.resolveOrSynthesizeGreeting({
        provider: 'cartesia',
        voiceId: 'sofia',
        template: 'Olá, falo com {{primeiro_nome}}?',
        customerName: 'Carlos Eduardo',
        apiKey: 'fake-api-key',
      });

      expect(res.fromCache).toBe(false);
      expect(res.audioBuffer).toEqual(freshlyGeneratedPcm);
      expect(res.sanitizedName).toBe('Carlos');
      expect(mockSynthesizerFactory.get).toHaveBeenCalledWith('cartesia');
      expect(mockSynthesizer.synthesize).toHaveBeenCalledTimes(1);
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('prewarmGreetings', () => {
    it('deve pré-aquecer lista de nomes distintos com controle de concorrência', async () => {
      mockRedis.get.mockResolvedValue(null);

      const names = [
        'Edinaldo da Silva',
        'EDINALDO',
        'Maria Clara',
        'João Pedro',
        'Sr. Carlos',
      ];

      const result = await service.prewarmGreetings({
        provider: 'cartesia',
        voiceId: 'sofia',
        template: 'Olá {{primeiro_nome}}',
        names,
        apiKey: 'fake-key',
        concurrency: 2,
      });

      // 4 nomes distintos após sanitização: Edinaldo, Maria Clara, Joao Pedro, Carlos
      expect(result.total).toBe(4);
      expect(result.synthesized).toBe(4);
      expect(result.failed).toBe(0);
    });
  });

  describe('invalidateAgentGreetings', () => {
    it('deve remover todas as chaves do agente', async () => {
      const client = mockRedis.getClient();
      (client.keys as jest.Mock).mockResolvedValueOnce([
        'voice:greeting:comp:ag1:cartesia:v1:hash:edinaldo',
        'voice:greeting:comp:ag1:cartesia:v1:hash:maria',
      ]);
      (client.del as jest.Mock).mockResolvedValueOnce(2);

      const count = await service.invalidateAgentGreetings('comp', 'ag1');
      expect(count).toBe(2);
      expect(client.del).toHaveBeenCalledTimes(1);
    });
  });
});
