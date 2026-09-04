import { ModelPricingService } from './model-pricing.service';

describe('ModelPricingService', () => {
  let service: ModelPricingService;

  beforeEach(() => {
    service = new ModelPricingService();
  });

  it('should calculate cost accurately for gemini-2.5-flash', () => {
    const cost = service.calculateTokenCost({
      model: 'gemini-2.5-flash',
      inputTokens: 1000,
      outputTokens: 500,
    });

    // 1000 * (0.075 / 1M) = 0.000075
    // 500 * (0.30 / 1M) = 0.00015
    // Total = 0.000225
    expect(cost).toBeCloseTo(0.000225, 6);
  });

  it('should calculate cost with fallback for unknown model', () => {
    const cost = service.calculateTokenCost({
      model: 'unknown-custom-model',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    // Default: 0.10 + 0.40 = 0.50
    expect(cost).toBeCloseTo(0.5, 4);
  });

  it('should calculate audio transcription cost for Groq Whisper', () => {
    const cost = service.calculateAudioCost(60); // 60 segundos
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.005, 3);
  });

  it('should calculate Gemini Live voice interactive session cost', () => {
    const cost = service.calculateVoiceLiveCost({
      durationSeconds: 120, // 2 minutos
      inputTokens: 400,
      outputTokens: 200,
    });

    // 120 * 0.0005 = 0.060 USD
    expect(cost).toBeGreaterThanOrEqual(0.06);
  });

  it('should calculate Hybrid voice cascade session cost (Groq + Flash Lite + Cartesia Sonic)', () => {
    const cost = service.calculateHybridVoiceCost({
      durationSeconds: 60, // 1 minuto
      inputTokens: 1000,
      outputTokens: 500,
      ttsCharacters: 900,
    });

    expect(cost).toBeGreaterThan(0);
    // STT: ~0.005, Cartesia: 900/1M * 35 = 0.0315, LLM: 1000*0.0375/1M + 500*0.15/1M = ~0.0001
    // Total deve ficar em torno de ~0.036 USD por minuto
    expect(cost).toBeCloseTo(0.0366, 3);
  });

  it('should calculate billable price with 25% default markup and BRL exchange rate', () => {
    const rawCostUsd = 1.0; // 1 USD
    const billable = service.calculateBillable(rawCostUsd, false);

    expect(billable.rawCostUsd).toBe(1.0);
    expect(billable.markupPercent).toBe(25);
    expect(billable.billableCostUsd).toBe(1.25);
    expect(billable.billableCostBrl).toBeCloseTo(1.25 * 5.8, 2);
  });

  it('should calculate billable price with 0% markup for BYOK accounts', () => {
    const rawCostUsd = 1.0;
    const billable = service.calculateBillable(rawCostUsd, true);

    expect(billable.markupPercent).toBe(0);
    expect(billable.billableCostUsd).toBe(1.0);
    expect(billable.billableCostBrl).toBeCloseTo(1.0 * 5.8, 2);
  });
});
