import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MockEmbeddingProvider {
  private readonly logger = new Logger(MockEmbeddingProvider.name);
  private readonly vectorDimension = 1536;

  generateEmbedding(text: string): number[] {
    this.logger.log(
      `🧬 [MockEmbeddingProvider] Gerando vetor sintético para texto (${text.length} chars)`,
    );

    const vector = new Array<number>(this.vectorDimension).fill(0);
    let hash = 0;

    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }

    // Gerar vetor determinístico normalizado
    let norm = 0;
    for (let i = 0; i < this.vectorDimension; i++) {
      const val = Math.sin((hash + i * 1337) % 100000);
      vector[i] = val;
      norm += val * val;
    }

    norm = Math.sqrt(norm) || 1;
    return vector.map((v) => Number((v / norm).toFixed(6)));
  }
}
