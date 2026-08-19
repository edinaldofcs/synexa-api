import { Test, TestingModule } from '@nestjs/testing';
import { FallbackProviderService } from './fallback-provider.service';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import { ProviderCircuitBreakerService } from './circuit-breaker.service';

describe('FallbackProviderService', () => {
  let service: FallbackProviderService;
  let providerKeyResolver: {
    resolveApiKey: jest.Mock;
  };
  let circuitBreaker: {
    canExecute: jest.Mock;
  };

  beforeEach(async () => {
    providerKeyResolver = {
      resolveApiKey: jest.fn(),
    };
    circuitBreaker = {
      canExecute: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FallbackProviderService,
        {
          provide: ProviderKeyResolverService,
          useValue: providerKeyResolver,
        },
        {
          provide: ProviderCircuitBreakerService,
          useValue: circuitBreaker,
        },
      ],
    }).compile();

    service = module.get<FallbackProviderService>(FallbackProviderService);
  });

  it('retorna fallback para gemini quando groq falha e gemini tem chave cadastrada', async () => {
    providerKeyResolver.resolveApiKey.mockImplementation(
      async (clientId, prov) => {
        if (prov === 'gemini') return 'AIzaSy123456';
        return '';
      },
    );

    const res = await service.resolveFallback(
      'client-1',
      'groq',
      'llama-3.3-70b-versatile',
    );

    expect(res.hasFallback).toBe(true);
    expect(res.target?.provider).toBe('gemini');
    expect(res.target?.model).toBe('gemini-2.5-flash');
    expect(res.target?.apiKey).toBe('AIzaSy123456');
  });

  it('pula candidato de fallback se o Circuit Breaker estiver aberto e escolhe o próximo', async () => {
    providerKeyResolver.resolveApiKey.mockImplementation(
      async (clientId, prov) => {
        if (prov === 'gemini') return 'AIzaSy123456';
        if (prov === 'openrouter') return 'sk-or-v1-123456';
        return '';
      },
    );

    circuitBreaker.canExecute.mockImplementation(async (prov) => {
      if (prov === 'gemini') return false; // Gemini com circuito aberto
      return true; // OpenRouter saudável
    });

    const res = await service.resolveFallback('client-1', 'groq');

    expect(res.hasFallback).toBe(true);
    expect(res.target?.provider).toBe('openrouter');
    expect(res.target?.apiKey).toBe('sk-or-v1-123456');
  });

  it('retorna hasFallback: false se nenhum provedor tiver chave cadastrada', async () => {
    providerKeyResolver.resolveApiKey.mockResolvedValue('');

    const res = await service.resolveFallback('client-1', 'groq');

    expect(res.hasFallback).toBe(false);
    expect(res.target).toBeUndefined();
  });
});
