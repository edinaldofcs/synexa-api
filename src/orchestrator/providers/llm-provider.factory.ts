import { Logger } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { OpenRouterProvider } from './openrouter.provider';
import { MockLlmProvider } from './mock.provider';
import { llmConfig } from './llm-config';
import type { LLMProvider } from './llm-provider.interface';

const logger = new Logger('LLMProviderFactory');

export function getLLMProvider(
  providerName?: string,
  apiKey?: string,
): LLMProvider {
  const name = (
    providerName ||
    process.env.LLM_PROVIDER ||
    llmConfig.provider ||
    'mock'
  ).toLowerCase();

  logger.log(`Inicializando LLM Provider: ${name}`);

  if (name === 'mock') return new MockLlmProvider();
  if (name === 'groq' || name === 'openai') return new GroqProvider(apiKey);
  if (name === 'openrouter') return new OpenRouterProvider(apiKey);
  if (name === 'gemini') return new GeminiProvider(apiKey);

  // Fallback seguro em desenvolvimento: se não houver chave real configurada, usa Mock
  if (
    !apiKey &&
    !process.env.GEMINI_API_KEY &&
    process.env.ENVIRONMENT === 'development'
  ) {
    logger.warn(
      'Nenhuma chave de API detectada. Utilizando MockLlmProvider como fallback local.',
    );
    return new MockLlmProvider();
  }

  return new GeminiProvider(apiKey);
}
