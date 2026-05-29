import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AgentConfig } from '../types/capabilities.types';

@Injectable()
export class RagSearchService {
  private readonly logger = new Logger(RagSearchService.name);
  private readonly openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
  private readonly embeddingModel =
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';

  constructor(private readonly prisma: PrismaService) {}

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
    if (!this.openai || agentConfig.allowed_knowledge_base_ids.length === 0) {
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

    try {
      const embeddingResponse = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: query,
      });
      const embedding = `[${embeddingResponse.data[0].embedding.join(',')}]`;

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
          } as any,
          completed_at: new Date(),
        },
      });
      return results;
    } catch (error) {
      await this.prisma.tool_calls.update({
        where: { id: toolCall.id },
        data: {
          status: 'failed',
          latency_ms: Date.now() - startedAt,
          error_message:
            error instanceof Error ? error.message : 'RAG search failed',
          completed_at: new Date(),
        },
      });
      throw error;
    }
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
