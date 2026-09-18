import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceGreetingCacheService } from './services/voice-greeting-cache.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('VoiceController', () => {
  let controller: VoiceController;
  let mockVoiceService: jest.Mocked<VoiceService>;
  let mockGreetingCache: jest.Mocked<VoiceGreetingCacheService>;
  let mockKeyResolver: jest.Mocked<ProviderKeyResolverService>;
  let mockPrisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    mockVoiceService = {
      getConfig: jest.fn().mockReturnValue({
        defaultModel: 'gemini-2.5-flash',
        defaultVoice: 'Aoede',
        hasApiKey: true,
      }),
    } as any;

    mockGreetingCache = {
      prewarmGreetings: jest.fn().mockResolvedValue({
        total: 2,
        cached: 1,
        synthesized: 1,
        failed: 0,
      }),
      invalidateAgentGreetings: jest.fn().mockResolvedValue(3),
    } as any;

    mockKeyResolver = {
      resolveApiKey: jest.fn().mockResolvedValue('test-api-key'),
    } as any;

    mockPrisma = {
      painel_agents: {
        findFirst: jest.fn(),
      },
    } as any;

    controller = new VoiceController(
      mockVoiceService,
      mockGreetingCache,
      mockKeyResolver,
      mockPrisma,
    );
  });

  describe('getConfig', () => {
    it('deve retornar a configuracao de voz da aplicacao', () => {
      const config = controller.getConfig();
      expect(config.defaultModel).toBe('gemini-2.5-flash');
      expect(mockVoiceService.getConfig).toHaveBeenCalled();
    });
  });

  describe('prewarmGreetings', () => {
    it('deve retornar erro se agentId ou lista de nomes estiverem vazios', async () => {
      const res = await controller.prewarmGreetings(
        { agentId: '', names: [] },
        { company_id: 'comp-1' },
      );
      expect(res.ok).toBe(false);
    });

    it('deve lançar NotFoundException se o agente nao existir', async () => {
      (mockPrisma.painel_agents.findFirst as jest.Mock).mockResolvedValueOnce(
        null,
      );

      await expect(
        controller.prewarmGreetings(
          { agentId: 'ag-inexistente', names: ['Edinaldo'] },
          { company_id: 'comp-1' },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve executar o prewarm com sucesso para as variações do agente', async () => {
      (mockPrisma.painel_agents.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'ag-1',
        client_id: 'cli-1',
        transitions: {
          capabilities: {
            greeting_message: 'Olá {{nome}}!\n---\nOi {{nome}}!',
            voice_engine: 'hybrid',
            voice_name: 'sofia',
          },
        },
      });

      const res = await controller.prewarmGreetings(
        { agentId: 'ag-1', names: ['Edinaldo', 'Carlos'] },
        { company_id: 'comp-1' },
      );

      expect(res.ok).toBe(true);
      expect(res.provider).toBe('cartesia');
      expect(res.variationsCount).toBe(2);
      expect(res.stats?.total).toBe(4);
      expect(mockGreetingCache.prewarmGreetings).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateGreetings', () => {
    it('deve chamar invalidateAgentGreetings e retornar o total de chaves removidas', async () => {
      const res = await controller.invalidateGreetings('ag-1', {
        company_id: 'comp-1',
      });
      expect(res.ok).toBe(true);
      expect(res.invalidated).toBe(3);
      expect(mockGreetingCache.invalidateAgentGreetings).toHaveBeenCalledWith(
        'comp-1',
        'ag-1',
      );
    });
  });
});
