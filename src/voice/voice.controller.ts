import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  NotFoundException,
} from '@nestjs/common';
import { VoiceService } from './voice.service';
import type { VoiceConfigResponse } from './voice.service';
import { VoiceGreetingCacheService } from './services/voice-greeting-cache.service';
import { ProviderKeyResolverService } from '../orchestrator/services/provider-key-resolver.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { Optional, Inject, forwardRef } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { resolveVoiceGreetingVariations } from './services/voice-runtime.util';
import { AudioSocketServerService } from './telephony/audiosocket-server.service';

export interface PrewarmGreetingsDto {
  agentId: string;
  names: string[];
}

@Controller('voice')
export class VoiceController {
  constructor(
    private readonly voiceService: VoiceService,
    private readonly greetingCacheService: VoiceGreetingCacheService,
    private readonly keyResolver: ProviderKeyResolverService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(forwardRef(() => AudioSocketServerService))
    private readonly audioSocketServerService?: AudioSocketServerService,
  ) {}

  @Get('config')
  getConfig(): VoiceConfigResponse {
    return this.voiceService.getConfig();
  }

  /**
   * Encerra chamadas de teste de telefonia ativas do Flow Studio (MicroSIP / Asterisk).
   */
  @Post('telephony/hangup')
  async hangupTestCall(@Body() body: { clientId?: string }) {
    if (this.audioSocketServerService) {
      await this.audioSocketServerService.hangupTestCall(body?.clientId);
    }
    return { ok: true };
  }

  /**
   * Pré-aquece saudações em lote com nomes distintos para um agente.
   * Ideal para ser chamado antes do início de campanhas em discadores.
   */
  @Post('greetings/prewarm')
  async prewarmGreetings(
    @Body() body: PrewarmGreetingsDto,
    @CurrentUser() user: { company_id: string },
  ) {
    const { agentId, names } = body;
    if (!agentId || !Array.isArray(names) || names.length === 0) {
      return { ok: false, error: 'agentId e lista de nomes são obrigatórios' };
    }

    const agent = await this.prisma.painel_agents.findFirst({
      where: {
        id: agentId,
        painel_clients: { company_id: user.company_id },
      },
    });

    if (!agent) {
      throw new NotFoundException('Agente não encontrado');
    }

    const transitions = (agent.transitions as any) || {};
    const capabilities = transitions.capabilities || {};
    const variations = resolveVoiceGreetingVariations(agent);

    if (variations.length === 0) {
      return {
        ok: false,
        message:
          'Agente não possui mensagem inicial configurada para pré-aquecer',
      };
    }

    const voiceEngine = (capabilities.voice_engine as string) || 'live_api';
    const isHybrid = voiceEngine === 'hybrid';
    const ttsProviderChoice =
      (agent.tts_provider as string) || (capabilities.tts_provider as string);
    const provider =
      isHybrid && ttsProviderChoice === 'custom'
        ? 'custom'
        : isHybrid
          ? 'cartesia'
          : 'google';

    let customTts: {
      baseUrl: string;
      apiKey?: string;
      voice?: string;
      sampleRate?: number;
      timeoutMs?: number;
    } | undefined;
    let apiKey = '';
    if (provider === 'custom') {
      const settings = await this.keyResolver.resolveProviderSettings(
        agent.client_id,
        'tts-custom',
      );
      const baseUrl = (settings.baseUrl || settings.base_url) as
        | string
        | undefined;
      if (!baseUrl) {
        return {
          ok: false,
          error:
            "TTS customizado não configurado: cadastre a URL em Provedores (BYOK) como 'tts-custom'",
        };
      }
      apiKey = await this.keyResolver.resolveApiKey(
        agent.client_id,
        'tts-custom',
      );
      customTts = {
        baseUrl: baseUrl,
        apiKey,
        voice: (settings.voice as string) || undefined,
        sampleRate: Number(settings.output_sample_rate) || undefined,
        timeoutMs: Number(settings.timeout_ms) || undefined,
      };
    } else {
      apiKey = await this.keyResolver.resolveApiKey(agent.client_id, provider);
    }

    if (!apiKey) {
      return {
        ok: false,
        error: `Chave de API não configurada para o provedor ${provider}`,
      };
    }

    const voiceId =
      provider === 'custom'
        ? customTts?.voice ||
          (capabilities.voice_name as string) ||
          'synexa-custom-voice'
        : (capabilities.voice_name as string) ||
          (isHybrid ? 'cb2694c3-715f-4da9-99f3-1c974fff2928' : 'Aoede');

    const totalStats = { total: 0, cached: 0, synthesized: 0, failed: 0 };
    for (const template of variations) {
      const res = await this.greetingCacheService.prewarmGreetings({
        companyId: user.company_id,
        agentId: agent.id,
        provider,
        voiceId,
        template,
        names,
        apiKey,
        customTts: provider === 'custom' ? customTts : undefined,
      });
      totalStats.total += res.total;
      totalStats.cached += res.cached;
      totalStats.synthesized += res.synthesized;
      totalStats.failed += res.failed;
    }

    return {
      ok: true,
      provider,
      voiceId,
      variationsCount: variations.length,
      stats: totalStats,
    };
  }

  /**
   * Invalida o cache de saudações de um agente no Redis.
   */
  @Delete('greetings/:agentId')
  async invalidateGreetings(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { company_id: string },
  ) {
    const invalidated =
      await this.greetingCacheService.invalidateAgentGreetings(
        user.company_id,
        agentId,
      );
    return { ok: true, agentId, invalidated };
  }
}
