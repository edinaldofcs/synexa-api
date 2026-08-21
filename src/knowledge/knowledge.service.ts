import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../common/prisma/prisma.service';
import { decrypt } from '../common/utils/crypto.util';
import { QueueService } from '../queue/queue.service';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';

import { MockEmbeddingProvider } from './providers/mock-embedding.provider';

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;

@Injectable()
export class KnowledgeService {
  private readonly embeddingModel =
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
    private readonly mockEmbeddingProvider: MockEmbeddingProvider,
  ) {}

  async createBase(
    clientId: string,
    dto: CreateKnowledgeBaseDto,
    userId: string,
  ) {
    const companyId = await this.getAuthorizedCompanyId(clientId, userId);

    return this.prisma.knowledge_bases.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        name: dto.name,
        description: dto.description || null,
        settings: (dto.settings || {}) as any,
      },
    });
  }

  async listBases(clientId: string, userId: string) {
    await this.getAuthorizedCompanyId(clientId, userId);
    return this.prisma.knowledge_bases.findMany({
      where: { client_id: clientId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listAllBases(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) throw new ForbiddenException('User has no company');

    return this.prisma.knowledge_bases.findMany({
      where: { company_id: user.company_id },
      orderBy: { created_at: 'desc' },
    });
  }

  async createDocument(
    baseId: string,
    dto: CreateKnowledgeDocumentDto,
    userId: string,
  ) {
    const base = await this.getAuthorizedBase(baseId, userId);

    const document = await this.prisma.knowledge_documents.create({
      data: {
        company_id: base.company_id,
        client_id: base.client_id,
        knowledge_base_id: base.id,
        media_asset_id: dto.media_asset_id || null,
        title: dto.title,
        source_type: dto.source_type || 'text',
        source_url: dto.source_url || null,
        status: 'pending',
        metadata: {
          ...(dto.metadata || {}),
          raw_content: dto.content,
        } as any,
      },
    });

    await this.queueService.addKnowledgeJob({ document_id: document.id });
    return document;
  }

  async listDocuments(baseId: string, userId: string) {
    const base = await this.getAuthorizedBase(baseId, userId);
    return this.prisma.knowledge_documents.findMany({
      where: { knowledge_base_id: base.id },
      orderBy: { created_at: 'desc' },
    });
  }

  async search(baseId: string, dto: SearchKnowledgeDto, userId: string) {
    const base = await this.getAuthorizedBase(baseId, userId);
    const embedding = await this.createEmbedding(dto.query, base.client_id);
    const limit = dto.limit || 5;

    return this.prisma.$queryRawUnsafe(
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
      WHERE ke.knowledge_base_id = $2::uuid
        AND ke.client_id = $3::uuid
      ORDER BY ke.embedding <=> $1::vector
      LIMIT $4
      `,
      this.vectorLiteral(embedding),
      base.id,
      base.client_id,
      limit,
    );
  }

  async ingestDocument(documentId: string) {
    const document = await this.prisma.knowledge_documents.findUnique({
      where: { id: documentId },
    });
    if (!document) return;

    await this.prisma.knowledge_documents.update({
      where: { id: document.id },
      data: { status: 'processing', error_message: null },
    });

    try {
      const metadata = (document.metadata || {}) as Record<string, unknown>;
      const content = String(metadata.raw_content || '').trim();
      if (!content) throw new BadRequestException('Document content is empty');

      await this.prisma.knowledge_chunks.deleteMany({
        where: { document_id: document.id },
      });

      const chunks = this.chunkText(content);

      for (const [index, chunk] of chunks.entries()) {
        const createdChunk = await this.prisma.knowledge_chunks.create({
          data: {
            company_id: document.company_id,
            client_id: document.client_id,
            knowledge_base_id: document.knowledge_base_id,
            document_id: document.id,
            content: chunk,
            chunk_index: index,
          },
        });

        const embedding = await this.createEmbedding(chunk, document.client_id);
        await this.prisma.$executeRawUnsafe(
          `
          INSERT INTO knowledge_embeddings
            (id, company_id, client_id, knowledge_base_id, chunk_id, provider, model, dimensions, embedding, metadata)
          VALUES
            (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::vector, '{}'::jsonb)
          ON CONFLICT (chunk_id, provider, model)
          DO UPDATE SET embedding = EXCLUDED.embedding, dimensions = EXCLUDED.dimensions
          `,
          document.company_id,
          document.client_id,
          document.knowledge_base_id,
          createdChunk.id,
          'openai',
          this.embeddingModel,
          embedding.length,
          this.vectorLiteral(embedding),
        );
      }

      await this.prisma.knowledge_documents.update({
        where: { id: document.id },
        data: { status: 'ready' },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Knowledge ingestion failed';
      await this.prisma.knowledge_documents.update({
        where: { id: document.id },
        data: { status: 'failed', error_message: message },
      });
      throw error;
    }
  }

  private async getAuthorizedCompanyId(
    clientId: string,
    userId: string,
  ): Promise<string> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) throw new ForbiddenException('User has no company');

    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== user.company_id) {
      throw new NotFoundException('Client not found');
    }

    return user.company_id;
  }

  private async getAuthorizedBase(baseId: string, userId: string) {
    const base = await this.prisma.knowledge_bases.findUnique({
      where: { id: baseId },
    });
    if (!base) throw new NotFoundException('Knowledge base not found');

    const companyId = await this.getAuthorizedCompanyId(base.client_id, userId);
    if (base.company_id !== companyId) {
      throw new NotFoundException('Knowledge base not found');
    }

    return base;
  }

  private async createEmbedding(input: string, clientId: string) {
    const isMock =
      this.configService.get<string>('LLM_PROVIDER') === 'mock' ||
      this.configService.get<string>('ENVIRONMENT') === 'development';

    const openai = await this.getOpenAIForClient(clientId);
    if (!openai) {
      if (isMock) {
        return this.mockEmbeddingProvider.generateEmbedding(input);
      }
      throw new BadRequestException(
        'API Key para openai/openrouter nao configurada. Configure em Configuracoes > Provedores.',
      );
    }

    try {
      const response = await openai.embeddings.create({
        model: this.embeddingModel,
        input,
      });
      return response.data[0].embedding;
    } catch (err) {
      if (isMock) {
        return this.mockEmbeddingProvider.generateEmbedding(input);
      }
      throw err;
    }
  }

  private async getOpenAIForClient(clientId: string): Promise<OpenAI | null> {
    const apiKey =
      (await this.resolveClientApiKey(clientId, 'openai')) ||
      (await this.resolveClientApiKey(clientId, 'openrouter'));
    if (!apiKey) return null;
    return new OpenAI({ apiKey });
  }

  private async resolveClientApiKey(
    clientId: string,
    provider: string,
  ): Promise<string> {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const providers = (client?.metadata as any)?.llm_providers || {};
    const config = providers[provider];
    let apiKey = config?.apiKey || '';

    if (apiKey && typeof apiKey === 'string' && apiKey.startsWith('enc:')) {
      const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
      if (encryptionKey) {
        try {
          apiKey = decrypt(apiKey.slice(4), encryptionKey);
        } catch {
          apiKey = '';
        }
      }
    }

    return apiKey;
  }

  private chunkText(text: string) {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, text.length);
      chunks.push(text.slice(start, end).trim());
      start = Math.max(
        end - DEFAULT_CHUNK_OVERLAP,
        end === text.length ? end : 0,
      );
      if (end === text.length) break;
    }

    return chunks.filter(Boolean);
  }

  private vectorLiteral(values: number[]) {
    return `[${values.join(',')}]`;
  }

  async updateBase(
    baseId: string,
    dto: Partial<CreateKnowledgeBaseDto>,
    userId: string,
  ) {
    const base = await this.getAuthorizedBase(baseId, userId);

    return this.prisma.knowledge_bases.update({
      where: { id: base.id },
      data: {
        name: dto.name || undefined,
        description: dto.description || undefined,
        settings: dto.settings ? (dto.settings as any) : undefined,
        updated_at: new Date(),
      },
    });
  }

  async deleteBase(baseId: string, userId: string) {
    const base = await this.getAuthorizedBase(baseId, userId);

    return this.prisma.knowledge_bases.delete({
      where: { id: base.id },
    });
  }

  async deleteDocument(baseId: string, docId: string, userId: string) {
    const base = await this.getAuthorizedBase(baseId, userId);

    const document = await this.prisma.knowledge_documents.findFirst({
      where: {
        id: docId,
        knowledge_base_id: base.id,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found in this knowledge base');
    }

    return this.prisma.knowledge_documents.delete({
      where: { id: docId },
    });
  }
}
