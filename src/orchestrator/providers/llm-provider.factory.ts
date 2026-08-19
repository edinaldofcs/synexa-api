import { Logger } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { OpenRouterProvider } from './openrouter.provider';
import { llmConfig } from './llm-config';
import type { LLMProvider } from './llm-provider.interface';

const logger = new Logger('LLMProviderFactory');

export function getLLMProvider(
  providerName?: string,
  apiKey?: string,
): LLMProvider {
  const name = (providerName || llmConfig.provider).toLowerCase();
  logger.log(`Inicializando LLM Provider: ${name}`);

  if (name === 'groq' || name === 'openai') return new GroqProvider(apiKey);
  if (name === 'openrouter') return new OpenRouterProvider(apiKey);

  return new GeminiProvider(apiKey);
}
