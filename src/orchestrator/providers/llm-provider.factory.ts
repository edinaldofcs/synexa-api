import { Logger } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { OpenRouterProvider } from './openrouter.provider';
import { llmConfig } from './llm-config';
import type { LLMProvider } from './llm-provider.interface';

const logger = new Logger('LLMProviderFactory');

export function getLLMProvider(): LLMProvider {
  const providerName = llmConfig.provider.toLowerCase();
  logger.log(`Inicializando LLM Provider: ${providerName}`);

  if (providerName === 'groq' || providerName === 'openai')
    return new GroqProvider();
  if (providerName === 'openrouter') return new OpenRouterProvider();

  return new GeminiProvider();
}
