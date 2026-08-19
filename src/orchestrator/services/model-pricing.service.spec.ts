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
});
