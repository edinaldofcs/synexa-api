import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { TtsSynthesizerFactory } from './synthesizers/tts-synthesizer.factory';
import {
  sanitizeCustomerName,
  createGreetingTemplateHash,
  selectVoiceGreetingVariation,
} from './voice-runtime.util';
import { resolvePromptTemplateString } from '../../common/utils/prompt-variables.util';

export interface GreetingCacheKeyOptions {
  companyId?: string;
  agentId?: string;
  provider: string;
  voiceId: string;
  template: string;
  customerName?: string;
}

export interface ResolveGreetingAudioOptions extends GreetingCacheKeyOptions {
  apiKey: string;
  sampleRate?: number;
  language?: string;
  variables?: Record<string, unknown>;
  /** Config BYO obrigatória quando provider === 'custom'. */
  customTts?: {
    baseUrl: string;
    apiKey?: string;
    voice?: string;
    sampleRate?: number;
    timeoutMs?: number;
  };
}

export interface ResolveGreetingResult {
  audioBuffer: Buffer;
  text: string;
  fromCache: boolean;
  sanitizedName: string;
}

const GREETING_CACHE_TTL_SECONDS = 30 * 24 * 3600; // 30 dias

@Injectable()
export class VoiceGreetingCacheService {
  private readonly logger = new Logger(VoiceGreetingCacheService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly synthesizerFactory: TtsSynthesizerFactory,
  ) {}

  /**
   * Constrói a chave de cache determinística no Redis:
   * voice:greeting:{companyId}:{agentId}:{provider}:{voiceId}:{hash}:{sanitizedName}
   */
  public buildCacheKey(options: GreetingCacheKeyOptions): string {
    const company = options.companyId || 'global';
    const agent = options.agentId || 'default';
    const provider = (options.provider || 'cartesia').toLowerCase().trim();
    const voiceId = (options.voiceId || 'default').toLowerCase().trim();
    const templateHash = createGreetingTemplateHash(options.template || '');
    const sanitizedName = sanitizeCustomerName(options.customerName);
    const nameKey = sanitizedName
      ? sanitizedName.toLowerCase().replace(/\s+/g, '_')
      : 'anon';

    return `voice:greeting:${company}:${agent}:${provider}:${voiceId}:${templateHash}:${nameKey}`;
  }

  /**
   * Busca o áudio da saudação no Redis. Retorna Buffer PCM ou null.
   */
  public async getGreetingAudio(
    options: GreetingCacheKeyOptions,
  ): Promise<Buffer | null> {
    try {
      const key = this.buildCacheKey(options);
      const base64 = await this.redis.get<string>(key);
      if (!base64) return null;

      // Renova o TTL no hit de cache (LRU extendido)
      void this.redis.expire(key, GREETING_CACHE_TTL_SECONDS).catch(() => {});

      return Buffer.from(base64, 'base64');
    } catch (err: any) {
      this.logger.warn(
        `⚠️ [VoiceGreetingCache] Erro ao buscar cache de áudio: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Armazena o áudio da saudação no Redis em formato base64.
   */
  public async setGreetingAudio(
    options: GreetingCacheKeyOptions,
    audioBuffer: Buffer,
    ttlSeconds = GREETING_CACHE_TTL_SECONDS,
  ): Promise<void> {
    try {
      const key = this.buildCacheKey(options);
      await this.redis.set(key, audioBuffer.toString('base64'), ttlSeconds);
      this.logger.debug(
        `💾 [VoiceGreetingCache] Áudio em cache gravado com sucesso: ${key} (${audioBuffer.length} bytes)`,
      );
    } catch (err: any) {
      this.logger.warn(
        `⚠️ [VoiceGreetingCache] Erro ao gravar cache de áudio: ${err.message}`,
      );
    }
  }

  /**
   * Orquestra a resolução do áudio de saudação:
   * 1. Interpola o nome e variáveis na frase.
   * 2. Consulta o Redis (Cache HIT -> 0ms).
   * 3. Em caso de Cache MISS, sintetiza via TtsSynthesizerFactory e armazena em background.
   */
  public async resolveOrSynthesizeGreeting(
    options: ResolveGreetingAudioOptions,
  ): Promise<ResolveGreetingResult> {
    const sanitizedName = sanitizeCustomerName(
      options.customerName ||
        options.variables?.nome ||
        options.variables?.nome_cliente,
    );

    const mergedVariables: Record<string, unknown> = {
      ...(options.variables || {}),
      nome: sanitizedName || options.variables?.nome || '',
      nome_cliente: sanitizedName || options.variables?.nome_cliente || '',
      primeiro_nome: sanitizedName || '',
    };

    let text = options.template;
    try {
      text = resolvePromptTemplateString(text, mergedVariables);
    } catch {
      // Interpolação falhou: mantém o texto original
    }

    const keyOptions: GreetingCacheKeyOptions = {
      companyId: options.companyId,
      agentId: options.agentId,
      provider: options.provider,
      voiceId: options.voiceId,
      template: options.template,
      customerName: sanitizedName,
    };

    // 1. Tentativa de HIT no Cache
    const cachedBuffer = await this.getGreetingAudio(keyOptions);
    if (cachedBuffer && cachedBuffer.length > 0) {
      this.logger.log(
        `⚡ [VoiceGreetingCache] HIT! Áudio de abertura servido do cache (0ms) | Provedor: ${options.provider} | Nome: "${sanitizedName || 'anon'}"`,
      );
      return {
        audioBuffer: cachedBuffer,
        text,
        fromCache: true,
        sanitizedName,
      };
    }

    // 2. Cache MISS: Síntese sob demanda com o provedor correto
    this.logger.log(
      `🎙️ [VoiceGreetingCache] MISS. Sintetizando nova saudação via ${options.provider} | Voz: ${options.voiceId} | Texto: "${text}"`,
    );

    const synth = this.synthesizerFactory.get(options.provider);
    const audioBuffer = await synth.synthesize(text, {
      apiKey: options.apiKey,
      voiceId: options.voiceId,
      sampleRate: options.sampleRate || 24000,
      language: options.language || 'pt',
      customTts: options.customTts,
    });

    // 3. Salva no cache assincronamente (não bloqueia a resposta da chamada)
    void this.setGreetingAudio(keyOptions, audioBuffer).catch((err) =>
      this.logger.warn(`Falha assíncrona ao cachear áudio: ${err.message}`),
    );

    return {
      audioBuffer,
      text,
      fromCache: false,
      sanitizedName,
    };
  }

  /**
   * Pré-aquece o cache para uma lista de nomes distintos (ex.: mailing de campanha).
   */
  public async prewarmGreetings(options: {
    companyId?: string;
    agentId?: string;
    provider: string;
    voiceId: string;
    template: string;
    names: string[];
    apiKey: string;
    sampleRate?: number;
    concurrency?: number;
    customTts?: {
      baseUrl: string;
      apiKey?: string;
      voice?: string;
      sampleRate?: number;
      timeoutMs?: number;
    };
  }): Promise<{
    total: number;
    cached: number;
    synthesized: number;
    failed: number;
  }> {
    const rawNames = Array.from(new Set(options.names || []));
    const distinctNames = Array.from(
      new Set(rawNames.map((n) => sanitizeCustomerName(n)).filter(Boolean)),
    );

    let cached = 0;
    let synthesized = 0;
    let failed = 0;
    const concurrency = options.concurrency || 5;

    this.logger.log(
      `🔥 [VoiceGreetingCache] Iniciando pré-aquecimento de ${distinctNames.length} nomes para agente ${options.agentId || 'default'}...`,
    );

    // Processa em lotes com concorrência controlada para respeitar limites de API
    for (let i = 0; i < distinctNames.length; i += concurrency) {
      const batch = distinctNames.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (name) => {
          try {
            const res = await this.resolveOrSynthesizeGreeting({
              companyId: options.companyId,
              agentId: options.agentId,
              provider: options.provider,
              voiceId: options.voiceId,
              template: options.template,
              customerName: name,
              apiKey: options.apiKey,
              sampleRate: options.sampleRate,
              customTts: options.customTts,
            });
            if (res.fromCache) {
              cached++;
            } else {
              synthesized++;
            }
          } catch (err: any) {
            this.logger.error(
              `❌ Falha ao pré-aquecer saudação para nome "${name}": ${err.message}`,
            );
            failed++;
          }
        }),
      );
    }

    this.logger.log(
      `✅ [VoiceGreetingCache] Pré-aquecimento concluído. Total: ${distinctNames.length} | Já em cache: ${cached} | Sintetizados: ${synthesized} | Falhas: ${failed}`,
    );

    return {
      total: distinctNames.length,
      cached,
      synthesized,
      failed,
    };
  }

  /**
   * Invalida as saudações em cache de um agente quando seu prompt ou voz forem atualizados.
   */
  public async invalidateAgentGreetings(
    companyId: string,
    agentId: string,
  ): Promise<number> {
    try {
      const pattern = `voice:greeting:${companyId}:${agentId}:*`;
      const client = this.redis.getClient();
      if (!client || typeof client.keys !== 'function') return 0;

      const keys = await client.keys(pattern);
      if (!keys || keys.length === 0) return 0;

      await client.del(...keys);
      this.logger.log(
        `🧹 [VoiceGreetingCache] ${keys.length} saudações em cache invalidadas para agente ${agentId}`,
      );
      return keys.length;
    } catch (err: any) {
      this.logger.warn(
        `⚠️ Erro ao invalidar saudações de voz do agente ${agentId}: ${err.message}`,
      );
      return 0;
    }
  }
}
