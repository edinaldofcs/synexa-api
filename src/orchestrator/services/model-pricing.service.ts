import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ModelPrice {
  inputPerMillion: number; // USD per 1,000,000 input tokens
  outputPerMillion: number; // USD per 1,000,000 output tokens
}

export interface BillableCalculation {
  rawCostUsd: number;
  billableCostUsd: number;
  billableCostBrl: number;
  markupPercent: number;
  exchangeRate: number;
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
    'gemini-3.1-flash-live-preview': {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    },

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

  // Gemini Live Multimodal API: ~$0.0005/segundo (~$0.030/minuto de voz interativa)
  private readonly geminiLiveAudioPricePerSecond = 0.0005;

  constructor(private readonly configService?: ConfigService) {}

  getMarkupPercent(): number {
    return (
      this.configService?.get<number>('BILLING_AI_MARKUP_PERCENT', 25) ?? 25
    );
  }

  getExchangeRate(): number {
    return this.configService?.get<number>('USD_BRL_RATE', 5.8) ?? 5.8;
  }

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

  calculateVoiceLiveCost(params: {
    durationSeconds: number;
    inputTokens?: number;
    outputTokens?: number;
  }): number {
    const durationCost =
      (params.durationSeconds || 0) * this.geminiLiveAudioPricePerSecond;
    const tokenCost = this.calculateTokenCost({
      model: 'gemini-3.1-flash-live-preview',
      inputTokens: params.inputTokens || 0,
      outputTokens: params.outputTokens || 0,
    });
    return Number((durationCost + tokenCost).toFixed(6));
  }

  calculateHybridVoiceCost(params: {
    durationSeconds: number;
    inputTokens?: number;
    outputTokens?: number;
    ttsCharacters?: number;
  }): number {
    const duration = params.durationSeconds || 0;
    const sttCost = this.calculateAudioCost(duration);
    // Cartesia Sonic: $35 por 1M caracteres (~15 chars/seg de fala ativa)
    const ttsChars = params.ttsCharacters ?? Math.round(duration * 15);
    const cartesiaCost = (ttsChars / 1_000_000) * 35;
    const llmCost = this.calculateTokenCost({
      model: 'gemini-2.5-flash-lite',
      inputTokens: params.inputTokens || 0,
      outputTokens: params.outputTokens || 0,
    });
    return Number((sttCost + cartesiaCost + llmCost).toFixed(6));
  }

  calculateBillable(rawCostUsd: number, isByok = false): BillableCalculation {
    const markupPercent = isByok ? 0 : this.getMarkupPercent();
    const exchangeRate = this.getExchangeRate();
    const multiplier = 1 + markupPercent / 100;
    const billableCostUsd = Number((rawCostUsd * multiplier).toFixed(6));
    const billableCostBrl = Number((billableCostUsd * exchangeRate).toFixed(4));

    return {
      rawCostUsd,
      billableCostUsd,
      billableCostBrl,
      markupPercent,
      exchangeRate,
    };
  }
}
