import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;

@Injectable()
export class KnowledgeService {
  private readonly openai: OpenAI | null;
  private readonly embeddingModel =
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {
    this.openai = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null;
  }

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
    const embedding = await this.createEmbedding(dto.query);
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

        const embedding = await this.createEmbedding(chunk);
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

  private async createEmbedding(input: string) {
    if (!this.openai) {
      throw new BadRequestException(
        'OPENAI_API_KEY is required for RAG embeddings',
      );
    }

    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input,
    });

    return response.data[0].embedding;
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
}
