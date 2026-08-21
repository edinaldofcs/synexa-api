import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConversationsRepository } from './repositories/conversations.repository';
import { OperatorPresenceService } from './operator-presence.service';
import { HandoffDistributorService } from './handoff-distributor.service';
import {
  FindOrCreateConversationDto,
  AddMessageDto,
  ConversationResult,
  HandoffRequestDto,
} from './dto/find-or-create.dto';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly presenceService: OperatorPresenceService,
    private readonly distributorService: HandoffDistributorService,
  ) {}

  async findOrCreate(
    dto: FindOrCreateConversationDto,
  ): Promise<ConversationResult> {
    let conversation: any;

    if (dto.conversation_key) {
      conversation = await this.conversationsRepo.findByExternalKey(
        dto.client_id,
        dto.conversation_key,
      );
    } else {
      conversation = await this.conversationsRepo.findActiveByEndUser(
        dto.client_id,
        dto.origin_channel,
        dto.external_user_id,
      );
    }

    if (conversation) {
      this.logger.log(
        { conversation_id: conversation.id },
        'Reusing active conversation',
      );
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

    this.logger.log(
      { conversation_id: conversation.id },
      'Created new conversation',
    );
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
        raw_payload: (dto.raw_payload as any) || null,
        metadata: (dto.metadata as any) || null,
        status: 'received',
      },
    });

    await this.conversationsRepo.updateLastMessage(
      dto.conversation_id,
      dto.direction,
    );

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

  async getMessages(conversationId: string) {
    return this.prisma.messages.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
      include: {
        message_parts: {
          orderBy: { order_index: 'asc' },
          include: {
            media_assets: {
              select: {
                id: true,
                mime_type: true,
                file_size: true,
                storage_bucket: true,
                storage_path: true,
                source_url: true,
                transcript: true,
                ocr_text: true,
                status: true,
              },
            },
          },
        },
      },
    });
  }

  async sendMessage(
    conversationId: string,
    dto: { content: string; sender_type?: string },
    companyId: string,
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { company_id: true, origin_channel: true, status: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.status === 'closed') {
      throw new BadRequestException('Conversation is closed');
    }

    const message = await this.prisma.messages.create({
      data: {
        company_id: companyId,
        conversation_id: conversationId,
        content: dto.content,
        sender_type: dto.sender_type || 'human',
        channel: conversation.origin_channel || 'api',
        direction: 'outbound',
        delivery_status: 'sent',
      },
    });

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        last_message_at: new Date(),
        last_outbound_at: new Date(),
      },
    });

    return message;
  }

  async updateConversation(
    conversationId: string,
    dto: { status?: string; mode?: string },
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const data: any = {};
    if (dto.status) data.status = dto.status;
    if (dto.mode) data.mode = dto.mode;
    if (dto.status === 'closed') {
      data.closed_at = new Date();
    }

    return this.prisma.conversations.update({
      where: { id: conversationId },
      data,
    });
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

  async listByClient(options?: {
    clientId?: string;
    companyId?: string | null;
    mode?: string;
    assigned_to?: string;
    unassigned?: boolean;
    status?: string;
  }) {
    const { clientId, companyId, mode, assigned_to, unassigned, status } =
      options || {};

    // Verifica e redistribui atendimentos órfãos de operadores offline > 5min
    if (companyId) {
      try {
        await this.distributorService.checkAndRedistributeAbandoned(companyId);
      } catch (err) {
        this.logger.error(
          `Erro ao verificar atendimentos abandonados: ${err?.message}`,
        );
      }
    }

    const where: any = {};
    if (clientId) where.client_id = clientId;
    if (companyId) where.company_id = companyId;
    if (status) where.status = status;
    if (mode) where.mode = mode;

    if (unassigned) {
      where.assigned_to = null;
    } else if (assigned_to) {
      where.assigned_to = assigned_to;
    }

    return this.prisma.conversations.findMany({
      where,
      orderBy: { last_message_at: 'desc' },
      take: 150,
      include: {
        end_users: { select: { id: true, name: true } },
        users: { select: { id: true, name: true, email: true } },
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

  async mergeVariables(
    conversationId: string,
    variables: Record<string, unknown>,
  ) {
    const currentState = await this.getState(conversationId);
    await this.updateState(conversationId, {
      ...currentState,
      ...variables,
    });
  }

  async requestHandoff(conversationId: string, dto: HandoffRequestDto) {
    const conversation = await this.conversationsRepo.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.mode === 'manual') {
      throw new BadRequestException('Conversation is already in manual mode');
    }

    let targetOperatorId = dto.assigned_to || conversation.assigned_to;

    const updated = await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        mode: 'manual',
        assigned_to: targetOperatorId || null,
      },
    });

    // Se nenhum operador foi fixado explicitamente, executa distribuição automática
    if (!targetOperatorId) {
      targetOperatorId = await this.distributorService.distribute(
        conversationId,
        updated.company_id,
        updated.client_id,
      );
    }

    await this.prisma.message_events.create({
      data: {
        company_id: updated.company_id,
        client_id: updated.client_id,
        conversation_id: conversationId,
        event_type: 'handoff.requested',
        status: 'manual',
        payload: {
          assigned_to: targetOperatorId || null,
          reason: dto.reason || null,
          requested_by: dto.requested_by || 'system',
        } as any,
      },
    });

    this.logger.log(
      { conversation_id: conversationId, assigned_to: targetOperatorId },
      'Handoff requested e distribuído',
    );

    return this.prisma.conversations.findUnique({
      where: { id: conversationId },
      include: {
        end_users: { select: { id: true, name: true } },
        users: { select: { id: true, name: true, email: true } },
      },
    });
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

  async reassignConversation(
    conversationId: string,
    newOperatorId: string,
    companyId: string,
  ) {
    const conversation = await this.conversationsRepo.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    const operator = await this.prisma.users.findFirst({
      where: { id: newOperatorId, company_id: companyId },
      select: { id: true, name: true },
    });
    if (!operator) throw new NotFoundException('Operador não encontrado');

    const updated = await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        mode: 'manual',
        assigned_to: newOperatorId,
      },
      include: {
        end_users: { select: { id: true, name: true } },
        users: { select: { id: true, name: true, email: true } },
      },
    });

    await this.prisma.message_events.create({
      data: {
        company_id: companyId,
        client_id: conversation.client_id,
        conversation_id: conversationId,
        event_type: 'handoff.reassigned',
        status: 'manual',
        payload: {
          previous_operator_id: conversation.assigned_to,
          new_operator_id: newOperatorId,
          operator_name: operator.name,
        } as any,
      },
    });

    return updated;
  }

  async operatorHeartbeat(
    userId: string,
    companyId: string,
    status: 'available' | 'finishing' = 'available',
  ) {
    await this.presenceService.heartbeat(userId, companyId, status);
    // Se o operador está disponível, tenta escoar conversas sem operador na fila
    if (status === 'available') {
      await this.distributorService.redistributeQueue(companyId);
    }
    return { status, timestamp: new Date().toISOString() };
  }

  async setOperatorStatus(
    userId: string,
    companyId: string,
    status: 'available' | 'finishing',
  ) {
    await this.presenceService.setStatus(userId, companyId, status);
    if (status === 'available') {
      await this.distributorService.redistributeQueue(companyId);
    }
    return { status, timestamp: new Date().toISOString() };
  }

  async operatorGoOffline(userId: string, companyId: string) {
    await this.presenceService.setOffline(userId, companyId);
    return { status: 'offline', timestamp: new Date().toISOString() };
  }

  async listOnlineOperators(companyId: string) {
    const onlineIds = await this.presenceService.listOnline(companyId);
    if (!onlineIds || onlineIds.length === 0) return [];

    const statusMap =
      await this.presenceService.listOnlineWithStatus(companyId);

    const operators = await this.prisma.users.findMany({
      where: { id: { in: onlineIds }, company_id: companyId },
      select: { id: true, name: true, email: true, role: true },
    });

    const withLoads = await Promise.all(
      operators.map(async (op) => {
        const activeChats = await this.prisma.conversations.count({
          where: {
            company_id: companyId,
            mode: 'manual',
            status: 'active',
            assigned_to: op.id,
          },
        });
        const presenceStatus = statusMap.get(op.id) || 'available';
        return {
          ...op,
          active_chats: activeChats,
          is_online: true,
          presence_status: presenceStatus,
        };
      }),
    );

    return withLoads;
  }

  async listHandoffQueue(clientId?: string, companyId?: string | null) {
    const where: any = {
      mode: 'manual',
      status: 'active',
      assigned_to: null,
    };
    if (clientId) where.client_id = clientId;
    if (companyId) where.company_id = companyId;

    return this.prisma.conversations.findMany({
      where,
      orderBy: { last_inbound_at: 'asc' },
      include: {
        end_users: { select: { id: true, name: true } },
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
          this.logger.warn(
            { messageId, partType: part.type },
            'Skipping media part without client_id',
          );
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
