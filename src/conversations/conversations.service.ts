import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConversationsRepository } from './repositories/conversations.repository';
import { FindOrCreateConversationDto, AddMessageDto, ConversationResult, HandoffRequestDto } from './dto/find-or-create.dto';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsRepo: ConversationsRepository,
  ) {}

  async findOrCreate(dto: FindOrCreateConversationDto): Promise<ConversationResult> {
    let conversation: any;

    if (dto.conversation_key) {
      conversation = await this.conversationsRepo.findByExternalKey(dto.client_id, dto.conversation_key);
    } else {
      conversation = await this.conversationsRepo.findActiveByEndUser(
        dto.client_id,
        dto.origin_channel,
        dto.external_user_id,
      );
    }

    if (conversation) {
      this.logger.log({ conversation_id: conversation.id }, 'Reusing active conversation');
      return this.mapResult(conversation);
    }

    conversation = await this.conversationsRepo.create({
      company_id: dto.company_id,
      client_id: dto.client_id,
      channel_connection_id: dto.channel_connection_id,
      end_user_id: dto.end_user_id,
      origin_channel: dto.origin_channel,
      external_conversation_key: dto.conversation_key,
      metadata: dto.metadata,
    });

    this.logger.log({ conversation_id: conversation.id }, 'Created new conversation');
    return this.mapResult(conversation);
  }

  async addMessage(dto: AddMessageDto) {
    const message = await this.prisma.messages.create({
      data: {
        conversation_id: dto.conversation_id,
        company_id: dto.company_id,
        sender_type: dto.sender_type,
        channel: dto.channel,
        direction: dto.direction,
        message_type: dto.message_type || 'text',
        content: dto.content || null,
        idempotency_key: dto.idempotency_key || null,
        request_id: dto.request_id || null,
        raw_payload: dto.raw_payload as any || null,
        metadata: dto.metadata as any || null,
        status: 'received',
      },
    });

    await this.conversationsRepo.updateLastMessage(dto.conversation_id, dto.direction);

    await this.addMessageParts(message.id, dto);
    await this.prisma.message_events.create({
      data: {
        company_id: dto.company_id,
        client_id: dto.client_id || null,
        conversation_id: dto.conversation_id,
        message_id: message.id,
        request_id: dto.request_id || null,
        event_type: 'message.created',
        status: message.status,
        payload: {
          direction: dto.direction,
          sender_type: dto.sender_type,
          channel: dto.channel,
          message_type: message.message_type,
        } as any,
      },
    });

    return message;
  }

  async getConversation(id: string) {
    const conversation = await this.conversationsRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  async updateState(conversationId: string, state: Record<string, unknown>) {
    await this.prisma.conversation_state.upsert({
      where: { conversation_id: conversationId },
      update: {
        state: state as any,
        version: { increment: 1 },
      },
      create: {
        conversation_id: conversationId,
        state: state as any,
      },
    });
  }

  async listByClient(clientId?: string) {
    const where: any = {};
    if (clientId) where.client_id = clientId;

    return this.prisma.conversations.findMany({
      where,
      orderBy: { last_message_at: 'desc' },
      take: 100,
      include: {
        end_users: { select: { name: true } },
        messages: {
          take: 1,
          orderBy: { created_at: 'desc' },
          select: { content: true, created_at: true, sender_type: true },
        },
      },
    });
  }

  async getState(conversationId: string): Promise<Record<string, unknown>> {
    const cs = await this.prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
    });
    return (cs?.state as Record<string, unknown>) || {};
  }

  async requestHandoff(conversationId: string, dto: HandoffRequestDto) {
    const conversation = await this.conversationsRepo.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.mode === 'manual') {
      throw new BadRequestException('Conversation is already in manual mode');
    }

    const updated = await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        mode: 'manual',
        assigned_to: dto.assigned_to || conversation.assigned_to,
      },
    });

    await this.prisma.message_events.create({
      data: {
        company_id: updated.company_id,
        client_id: updated.client_id,
        conversation_id: conversationId,
        event_type: 'handoff.requested',
        status: 'manual',
        payload: {
          assigned_to: dto.assigned_to,
          reason: dto.reason || null,
          requested_by: dto.requested_by || 'system',
        } as any,
      },
    });

    this.logger.log({ conversation_id: conversationId, assigned_to: dto.assigned_to }, 'Handoff requested');
    return updated;
  }

  async releaseHandoff(conversationId: string) {
    const conversation = await this.conversationsRepo.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.mode !== 'manual') {
      throw new BadRequestException('Conversation is not in manual mode');
    }

    const updated = await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        mode: 'auto',
        assigned_to: null,
      },
    });

    await this.prisma.message_events.create({
      data: {
        company_id: updated.company_id,
        client_id: updated.client_id,
        conversation_id: conversationId,
        event_type: 'handoff.released',
        status: 'auto',
        payload: {} as any,
      },
    });

    this.logger.log({ conversation_id: conversationId }, 'Handoff released');
    return updated;
  }

  async listHandoffQueue(clientId?: string) {
    const where: any = {
      mode: 'manual',
      status: 'active',
    };
    if (clientId) where.client_id = clientId;

    return this.prisma.conversations.findMany({
      where,
      orderBy: { last_inbound_at: 'asc' },
      include: {
        end_users: { select: { name: true } },
        messages: {
          take: 1,
          orderBy: { created_at: 'desc' },
          select: { content: true, created_at: true, sender_type: true },
        },
      },
    });
  }

  private mapResult(c: any): ConversationResult {
    return {
      id: c.id,
      company_id: c.company_id,
      client_id: c.client_id,
      status: c.status,
      mode: c.mode,
      end_user_id: c.end_user_id,
      origin_channel: c.origin_channel,
      external_conversation_key: c.external_conversation_key,
      created_at: c.created_at,
    };
  }

  private async addMessageParts(messageId: string, dto: AddMessageDto) {
    const parts = dto.parts?.length
      ? dto.parts
      : dto.content
        ? [{ type: 'text', text: dto.content }]
        : [];

    for (const [orderIndex, part] of parts.entries()) {
      let mediaAssetId: string | null = null;

      if (['image', 'audio', 'file'].includes(part.type)) {
        if (!dto.client_id) {
          this.logger.warn({ messageId, partType: part.type }, 'Skipping media part without client_id');
          continue;
        }

        const mediaAsset = await this.prisma.media_assets.create({
          data: {
            company_id: dto.company_id,
            client_id: dto.client_id,
            message_id: messageId,
            source_url: part.url || null,
            mime_type: part.mime_type || this.inferMimeType(part.type),
            file_size: part.file_size || null,
            checksum: part.checksum || null,
            status: part.url ? 'pending' : 'stored',
            metadata: (part.metadata || {}) as any,
          },
        });
        mediaAssetId = mediaAsset.id;
      }

      await this.prisma.message_parts.create({
        data: {
          message_id: messageId,
          part_type: part.type,
          text_content: part.text || null,
          media_asset_id: mediaAssetId,
          order_index: orderIndex,
          metadata: (part.metadata || {}) as any,
        },
      });
    }
  }

  private inferMimeType(partType: string) {
    if (partType === 'image') return 'image/*';
    if (partType === 'audio') return 'audio/*';
    return 'application/octet-stream';
  }
}
