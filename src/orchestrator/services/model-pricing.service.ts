import { Injectable, Logger } from '@nestjs/common';

export interface ModelPrice {
  inputPerMillion: number; // USD per 1,000,000 input tokens
  outputPerMillion: number; // USD per 1,000,000 output tokens
}

@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);

  // Preços de referência oficiais (USD por 1M tokens)
  private readonly pricingTable: Record<string, ModelPrice> = {
    // Google Gemini
    'gemini-2.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    'gemini-2.5-flash-lite': {
      inputPerMillion: 0.0375,
      outputPerMillion: 0.15,
    },
    'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.0 },

    // Groq (Llama / Mistral)
    'llama-3.3-70b-versatile': {
      inputPerMillion: 0.59,
      outputPerMillion: 0.79,
    },
    'llama-3.1-70b-versatile': {
      inputPerMillion: 0.59,
      outputPerMillion: 0.79,
    },
    'llama-3.1-8b-instant': { inputPerMillion: 0.05, outputPerMillion: 0.08 },
    'llama-3.2-11b-vision-preview': {
      inputPerMillion: 0.18,
      outputPerMillion: 0.18,
    },
    'openai/gpt-oss-120b': { inputPerMillion: 0.5, outputPerMillion: 0.7 },

    // OpenRouter / OpenAI standard estimates
    'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    'anthropic/claude-3.5-sonnet': {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
    },
    'openai/gpt-5.4-nano:nitro': {
      inputPerMillion: 0.05,
      outputPerMillion: 0.1,
    },
  };

  // Preço por segundo de áudio (Whisper Groq: ~$0.000083/seg ≈ $0.005/minuto)
  private readonly audioTranscriptionPricePerSecond = 0.0000833;

  calculateTokenCost(params: {
    provider?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
  }): number {
    const { model, inputTokens, outputTokens } = params;
    const normalizedModel = (model || '').toLowerCase().trim();

    let price = this.pricingTable[normalizedModel];

    if (!price) {
      // Procura por correspondência parcial
      const matchKey = Object.keys(this.pricingTable).find((key) =>
        normalizedModel.includes(key),
      );
      price = matchKey
        ? this.pricingTable[matchKey]
        : { inputPerMillion: 0.1, outputPerMillion: 0.4 }; // default conservador
    }

    const inputCost = (inputTokens / 1_000_000) * price.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * price.outputPerMillion;
    const totalCost = inputCost + outputCost;

    return Number(totalCost.toFixed(6));
  }

  calculateAudioCost(durationSeconds: number): number {
    if (!durationSeconds || durationSeconds <= 0) return 0;
    return Number(
      (durationSeconds * this.audioTranscriptionPricePerSecond).toFixed(6),
    );
  }
}
