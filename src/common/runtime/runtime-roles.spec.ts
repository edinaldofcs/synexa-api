import { MockLlmProvider } from '../../orchestrator/providers/mock.provider';
import { MockEmbeddingProvider } from '../../knowledge/providers/mock-embedding.provider';
import {
  validateEnv,
  ServiceRole,
  LlmProvider,
  VoiceProvider,
} from '../config/env.validation';

describe('Runtime Roles and Mock Providers Suite', () => {
  describe('Environment Validation', () => {
    it('should successfully validate default development environment', () => {
      const config = {
        ENVIRONMENT: 'development',
        NODE_ENV: 'development',
        SERVICE_ROLE: ServiceRole.API,
        DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/synexa_db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'test-secret-at-least-32-chars-key!!',
        LLM_PROVIDER: LlmProvider.MOCK,
        VOICE_PROVIDER: VoiceProvider.MOCK,
      };

      const validated = validateEnv(config);
      expect(validated.SERVICE_ROLE).toBe('api');
      expect(validated.LLM_PROVIDER).toBe('mock');
      expect(validated.VOICE_PROVIDER).toBe('mock');
    });

    it('should validate worker service roles', () => {
      const config = {
        SERVICE_ROLE: ServiceRole.WORKER_AGENT,
        ENVIRONMENT: 'development',
        DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/synexa_db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'test-secret-at-least-32-chars-key!!',
      };

      const validated = validateEnv(config);
      expect(validated.SERVICE_ROLE).toBe('worker-agent');
    });
  });

  describe('MockLlmProvider', () => {
    let mockLlm: MockLlmProvider;

    beforeEach(() => {
      mockLlm = new MockLlmProvider(0); // 0ms latency for fast tests
    });

    it('should return simulated text and token usage', async () => {
      const res = await mockLlm.chat({
        systemPrompt: 'System prompt',
        userMessage: 'Olá, gostaria de ajuda',
        history: [],
        publicTools: [],
        allToolsList: [],
        executeExternalApiCallback: async () => {},
      });

      expect(res.text).toContain('[Mock LLM Response]');
      expect(res.action).toBe('speak');
      expect(res.usage?.total_tokens).toBeGreaterThan(0);
    });

    it('should simulate transfer rules when keywords match', async () => {
      const res = await mockLlm.chat({
        systemPrompt:
          'Se o cliente precisar de suporte técnico, responda exatamente: "TRANSFERIR:suporte_tecnico"',
        userMessage: 'Estou com um problema técnico no meu sistema',
        history: [],
        publicTools: [],
        allToolsList: [],
        executeExternalApiCallback: async () => {},
      });

      expect(res.text).toBe('TRANSFERIR:suporte_tecnico');
    });

    it('should provide full capabilities', () => {
      const caps = mockLlm.getCapabilities();
      expect(caps.text).toBe(true);
      expect(caps.tools).toBe(true);
    });
  });

  describe('MockEmbeddingProvider', () => {
    let mockEmbedding: MockEmbeddingProvider;

    beforeEach(() => {
      mockEmbedding = new MockEmbeddingProvider();
    });

    it('should generate 1536-dimensional normalized vector', () => {
      const vec = mockEmbedding.generateEmbedding(
        'Texto de teste para RAG local',
      );
      expect(vec).toHaveLength(1536);
      expect(typeof vec[0]).toBe('number');

      // Check normalization (magnitude ~ 1)
      const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
      expect(norm).toBeCloseTo(1, 2);
    });

    it('should generate deterministic vectors for identical input', () => {
      const vec1 = mockEmbedding.generateEmbedding(
        'mesmo texto deterministico',
      );
      const vec2 = mockEmbedding.generateEmbedding(
        'mesmo texto deterministico',
      );
      expect(vec1).toEqual(vec2);
    });
  });
});
