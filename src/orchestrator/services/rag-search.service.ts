import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProviderKeyResolverService } from './provider-key-resolver.service';
import type { AgentConfig } from '../types/capabilities.types';

@Injectable()
export class RagSearchService {
  private readonly logger = new Logger(RagSearchService.name);
  private readonly embeddingModel =
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeyResolver: ProviderKeyResolverService,
  ) {}

  async buildRagContext(
    agentConfig: AgentConfig,
    query: string,
    clientId: string,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ): Promise<string | undefined> {
    if (
      !agentConfig.capabilities.rag ||
      agentConfig.allowed_knowledge_base_ids.length === 0
    ) {
      return undefined;
    }

    const results = await this.searchRag(
      agentConfig,
      query,
      clientId,
      5,
      agentRunId,
      conversationId,
      messageId,
      companyId,
      requestId,
    );

    if (!results.length) return undefined;

    return results
      .map(
        (item, index) =>
          `[${index + 1}] ${item.document_title || item.document_id}\n${item.content}`,
      )
      .join('\n\n');
  }

  async searchRag(
    agentConfig: AgentConfig,
    query: string,
    clientId: string,
    limit: number,
    agentRunId: string,
    conversationId: string,
    messageId: string,
    companyId: string,
    requestId?: string,
  ) {
    if (agentConfig.allowed_knowledge_base_ids.length === 0) {
      return [];
    }

    // Resolve todos os provedores viáveis que possuem chaves configuradas
    const providersToTry: { name: string; apiKey: string }[] = [];
    const preferred =
      (agentConfig as any).llmProvider || (agentConfig as any).provider;

    const candidates = [
      preferred,
      'openai',
      'openrouter',
      'groq',
      'gemini',
    ].filter(Boolean) as string[];
    const uniqueCandidates = Array.from(new Set(candidates));

    for (const provider of uniqueCandidates) {
      const apiKey = await this.providerKeyResolver.resolveApiKey(
        clientId,
        provider,
      );
      if (apiKey) {
        providersToTry.push({ name: provider, apiKey });
      }
    }

    if (providersToTry.length === 0) {
      this.logger.warn(
        { clientId },
        'Nenhum provedor de embedding configurado com chave de API.',
      );
      return [];
    }

    const startedAt = Date.now();
    const toolCall = await this.prisma.tool_calls.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        conversation_id: conversationId,
        message_id: messageId,
        agent_run_id: agentRunId,
        request_id: requestId || null,
        tool_name: 'rag.search',
        tool_type: 'native',
        arguments: { query, limit } as any,
        status: 'running',
      },
    });

    let lastError: Error | null = null;

    for (const providerConfig of providersToTry) {
      try {
        let embedding: string;

        if (providerConfig.name === 'gemini') {
          const genAI = new GoogleGenerativeAI(providerConfig.apiKey);
          const genAIModel = genAI.getGenerativeModel({
            model: 'text-embedding-004',
          });
          this.logger.log(
            `Tentando obter embedding com o provedor: gemini, modelo: text-embedding-004`,
          );
          const embeddingResponse = await genAIModel.embedContent(query);
          embedding = `[${embeddingResponse.embedding.values.join(',')}]`;
        } else {
          let client: OpenAI;
          let model: string;

          if (providerConfig.name === 'openai') {
            client = new OpenAI({ apiKey: providerConfig.apiKey });
            model = this.embeddingModel;
          } else if (providerConfig.name === 'openrouter') {
            client = new OpenAI({
              baseURL: 'https://openrouter.ai/api/v1',
              apiKey: providerConfig.apiKey,
              defaultHeaders: {
                'HTTP-Referer': 'https://github.com/antigravity',
                'X-Title': 'Synexa',
              },
            });
            model =
              process.env.RAG_EMBEDDING_MODEL ||
              'openai/text-embedding-3-small';
          } else if (providerConfig.name === 'groq') {
            client = new OpenAI({
              baseURL: 'https://api.groq.com/openai/v1',
              apiKey: providerConfig.apiKey,
            });
            model = 'nomic-embed-text-v1.5';
          } else {
            continue;
          }

          this.logger.log(
            `Tentando obter embedding com o provedor: ${providerConfig.name}, modelo: ${model}`,
          );
          const embeddingResponse = await client.embeddings.create({
            model,
            input: query,
          });
          embedding = `[${embeddingResponse.data[0].embedding.join(',')}]`;
        }

        const results = await this.prisma.$queryRawUnsafe<
          Array<{
            id: string;
            document_id: string;
            document_title: string;
            content: string;
            page: number | null;
            score: number;
          }>
        >(
          `
          SELECT
            kc.id,
            kc.document_id,
            kd.title AS document_title,
            kc.content,
            kc.page,
            1 - (ke.embedding <=> $1::vector) AS score
          FROM knowledge_embeddings ke
          JOIN knowledge_chunks kc ON kc.id = ke.chunk_id
          JOIN knowledge_documents kd ON kd.id = kc.document_id
          WHERE ke.client_id = $2::uuid
            AND ke.knowledge_base_id = ANY($3::uuid[])
          ORDER BY ke.embedding <=> $1::vector
          LIMIT $4
          `,
          embedding,
          clientId,
          agentConfig.allowed_knowledge_base_ids,
          Math.min(Math.max(limit || 5, 1), 10),
        );

        await this.prisma.tool_calls.update({
          where: { id: toolCall.id },
          data: {
            status: 'success',
            latency_ms: Date.now() - startedAt,
            result: {
              count: results.length,
              chunks: results.map((r) => ({ id: r.id, score: r.score })),
              provider_used: providerConfig.name,
            } as any,
            completed_at: new Date(),
          },
        });
        return results;
      } catch (error) {
        this.logger.warn(
          { provider: providerConfig.name, error: (error as Error).message },
          'Falha na chamada de embedding do provedor. Tentando próximo...',
        );
        lastError = error as Error;
      }
    }

    // Se todos os provedores de embedding externos falharem, executa busca híbrida textual/semântica de contingência
    try {
      this.logger.log(
        `Executando busca textual de contingência para a query: "${query}"`,
      );
      const words = query
        .toLowerCase()
        .replace(/[^\w\s\u00C0-\u00FF]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3);

      const searchPattern = `%${query.trim()}%`;
      const wordPatterns =
        words.length > 0 ? words.map((w) => `%${w}%`) : [searchPattern];

      const fallbackResults = await this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          document_id: string;
          document_title: string;
          content: string;
          page: number | null;
          score: number;
        }>
      >(
        `
        SELECT
          kc.id,
          kc.document_id,
          kd.title AS document_title,
          kc.content,
          kc.page,
          0.88::float8 AS score
        FROM knowledge_chunks kc
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE kc.client_id = $1::uuid
          AND kc.knowledge_base_id = ANY($2::uuid[])
          AND (
            kc.content ILIKE $3
            OR kd.title ILIKE $3
            OR EXISTS (
              SELECT 1 FROM unnest($4::text[]) w
              WHERE kc.content ILIKE w OR kd.title ILIKE w
            )
          )
        LIMIT $5
        `,
        clientId,
        agentConfig.allowed_knowledge_base_ids,
        searchPattern,
        wordPatterns,
        Math.min(Math.max(limit || 5, 1), 10),
      );

      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'success',
          latency_ms: Date.now() - startedAt,
          result: {
            count: fallbackResults.length,
            chunks: fallbackResults.map((r) => ({ id: r.id, score: r.score })),
            provider_used: 'hybrid_text_fallback',
          } as any,
          completed_at: new Date(),
        },
      });

      return fallbackResults;
    } catch (fallbackError) {
      this.logger.warn(
        { error: (fallbackError as Error).message },
        'Falha na busca textual de contingência',
      );
    }

    // Se todos falharem:
    await this.prisma.tool_calls.update({
      where: { id: toolCall.id },
      data: {
        status: 'failed',
        latency_ms: Date.now() - startedAt,
        error_message: lastError
          ? lastError.message
          : 'All embedding providers failed',
        completed_at: new Date(),
      },
    });

    return [];
  }

  ragToolDefinition() {
    return {
      name: 'rag.search',
      type: 'native' as const,
      description:
        'Busca informacoes nas bases de conhecimento autorizadas para este agente.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca' },
          limit: { type: 'number', description: 'Maximo de resultados (1-10)' },
        },
        required: ['query'],
      },
    };
  }
}
