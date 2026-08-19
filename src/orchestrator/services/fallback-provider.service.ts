import { Injectable, Logger } from '@nestjs/common';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import { ProviderCircuitBreakerService } from './circuit-breaker.service';

export interface FallbackCandidate {
  provider: string;
  model: string;
  apiKey: string;
}

export interface FallbackResolution {
  hasFallback: boolean;
  target?: FallbackCandidate;
  reason?: string;
}

@Injectable()
export class FallbackProviderService {
  private readonly logger = new Logger(FallbackProviderService.name);

  // Mapeamento padrão de substitutos de modelos por capacidade
  private readonly defaultFallbackMap: Record<
    string,
    Array<{ provider: string; model: string }>
  > = {
    groq: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
    ],
    gemini: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ],
    openrouter: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
    ],
  };

  constructor(
    private readonly providerKeyResolver: ProviderKeyResolverService,
    private readonly circuitBreaker: ProviderCircuitBreakerService,
  ) {}

  async resolveFallback(
    clientId: string,
    primaryProvider: string,
    primaryModel?: string,
  ): Promise<FallbackResolution> {
    const pLower = primaryProvider.toLowerCase().trim();
    const candidates = this.defaultFallbackMap[pLower] || [];

    for (const candidate of candidates) {
      const apiKey = await this.providerKeyResolver.resolveApiKey(
        clientId,
        candidate.provider,
      );

      if (!apiKey || apiKey.trim() === '') {
        continue;
      }

      // Verifica se o circuit breaker do fallback está saudável
      const canExecute = await this.circuitBreaker.canExecute(
        candidate.provider,
        clientId,
      );

      if (!canExecute) {
        this.logger.warn(
          { provider: candidate.provider, clientId },
          'Provedor candidato de fallback está com Circuit Breaker aberto, tentando próximo',
        );
        continue;
      }

      return {
        hasFallback: true,
        target: {
          provider: candidate.provider,
          model: candidate.model,
          apiKey,
        },
      };
    }

    return {
      hasFallback: false,
      reason: `Nenhum provedor de fallback com chave válida e circuito saudável encontrado para ${primaryProvider}`,
    };
  }
}
