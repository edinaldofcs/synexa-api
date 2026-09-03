import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as fs from 'fs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConversationsRepository } from './repositories/conversations.repository';
import { OperatorPresenceService } from './operator-presence.service';
import { HandoffDistributorService } from './handoff-distributor.service';
import {
  FindOrCreateConversationDto,
  AddMessageDto,
  ConversationResult,
  HandoffRequestDto,
} from './dto/find-or-create.dto';
import {
  InboundDataMapperService,
  InboundMappingConfig,
} from '../common/services/inbound-data-mapper.service';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly HANDOFF_SCAN_THROTTLE_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly presenceService: OperatorPresenceService,
    private readonly distributorService: HandoffDistributorService,
    private readonly inboundDataMapper: InboundDataMapperService,
    private readonly redisService: RedisService,
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

    try {
      conversation = await this.conversationsRepo.create({
        company_id: dto.company_id,
        client_id: dto.client_id,
        channel_connection_id: dto.channel_connection_id,
        end_user_id: dto.end_user_id,
        origin_channel: dto.origin_channel,
        external_conversation_key: dto.conversation_key,
        metadata: dto.metadata,
      });
    } catch (err: any) {
      // Corrida no find-or-create: a constraint única (client_id,
      // external_conversation_key) indica que outra requisição criou a conversa
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        dto.conversation_key
      ) {
        const existing = await this.conversationsRepo.findByExternalKey(
          dto.client_id,
          dto.conversation_key,
        );
        if (!existing) throw err;
        conversation = existing;
        this.logger.warn(
          { conversation_id: conversation.id },
          'Race no find-or-create: reaproveitando conversa criada concorrentemente',
        );
        return this.mapResult(conversation);
      }
      throw err;
    }

    // Mapeia variáveis de entrada (CRM, Webhook, API, Discador) para o estado da sessão
    try {
      let inboundConfig: InboundMappingConfig | undefined;
      if (dto.client_id) {
        const client = await this.prisma.painel_clients.findUnique({
          where: { id: dto.client_id },
          select: { metadata: true },
        });
        const meta = (client?.metadata as Record<string, unknown>) || {};
        inboundConfig = meta.inbound_variable_mapping as InboundMappingConfig;
      }

      const rawMetadata = (dto.metadata as Record<string, unknown>) || {};
      const mappedInitialState = this.inboundDataMapper.mapInboundData(
        rawMetadata,
        inboundConfig,
        dto.origin_channel || 'webchat',
      );

      if (Object.keys(mappedInitialState).length > 0) {
        await this.prisma.conversation_state.upsert({
          where: { conversation_id: conversation.id },
          create: {
            conversation_id: conversation.id,
            state: mappedInitialState as any,
          },
          update: {
            state: mappedInitialState as any,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `Erro ao inicializar estado mapeado da conversa: ${err.message}`,
      );
    }

    this.logger.log(
      { conversation_id: conversation.id },
      'Created new conversation',
    );
    return this.mapResult(conversation);
  }

  async addMessage(dto: AddMessageDto) {
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messages.create({
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

      await this.addMessageParts(created.id, dto, tx);

      await tx.message_events.create({
        data: {
          company_id: dto.company_id,
          client_id: dto.client_id || null,
          conversation_id: dto.conversation_id,
          message_id: created.id,
          request_id: dto.request_id || null,
          event_type: 'message.created',
          status: created.status,
          payload: {
            direction: dto.direction,
            sender_type: dto.sender_type,
            channel: dto.channel,
            message_type: created.message_type,
          } as any,
        },
      });

      return created;
    });

    await this.conversationsRepo.updateLastMessage(
      dto.conversation_id,
      dto.direction,
    );

    return message;
  }

  private async assertConversationInTenant(
    conversationId: string,
    companyId?: string,
  ) {
    if (!companyId) return;
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { id: true, company_id: true },
    });
    // 404 (e não 403) para não revelar existência de conversa de outro tenant
    if (!conversation || conversation.company_id !== companyId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }

  async getConversation(id: string, companyId?: string) {
    if (companyId) await this.assertConversationInTenant(id, companyId);
    const conversation = await this.conversationsRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  async getMessages(
    conversationId: string,
    companyId?: string,
    query?: { limit?: number; before?: string; offset?: number },
  ) {
    if (companyId)
      await this.assertConversationInTenant(conversationId, companyId);

    const where: any = { conversation_id: conversationId };
    if (query?.before) {
      where.created_at = { lt: new Date(query.before) };
    }

    const limit = query?.limit ? Number(query.limit) : undefined;
    const offset = query?.offset ? Number(query.offset) : undefined;

    if (limit) {
      const messages = await this.prisma.messages.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
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

      return messages.reverse();
    }

    return this.prisma.messages.findMany({
      where,
      orderBy: { created_at: 'asc' },
      take: 100,
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
    companyId?: string,
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { company_id: true, origin_channel: true, status: true },
    });
    if (!conversation || (companyId && conversation.company_id !== companyId)) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.status === 'closed') {
      throw new BadRequestException('Conversation is closed');
    }

    const message = await this.prisma.messages.create({
      data: {
        company_id: conversation.company_id,
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
    companyId?: string,
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || (companyId && conversation.company_id !== companyId)) {
      throw new NotFoundException('Conversation not found');
    }

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
    // (throttle: no máximo 1 varredura por minuto por empresa)
    if (companyId) {
      try {
        const scanLockKey = `handoff:scan:${companyId}`;
        const claimed = await this.redisService.acquireLock(
          scanLockKey,
          this.HANDOFF_SCAN_THROTTLE_SECONDS,
        );
        if (claimed) {
          await this.distributorService.checkAndRedistributeAbandoned(
            companyId,
          );
        }
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
        end_users: {
          select: {
            id: true,
            name: true,
            metadata: true,
          },
        },
        users: { select: { id: true, name: true, email: true } },
        painel_clients: { select: { id: true, company_name: true } },
        conversation_state: { select: { state: true, updated_at: true } },
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

  async requestHandoff(
    conversationId: string,
    dto: HandoffRequestDto,
    companyId?: string,
  ) {
    await this.assertConversationInTenant(conversationId, companyId);
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

  async releaseHandoff(conversationId: string, companyId?: string) {
    await this.assertConversationInTenant(conversationId, companyId);
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
    await this.assertConversationInTenant(conversationId, companyId);
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

    const activeByOperator = new Map<string, number>();
    const loadRows = await this.prisma.conversations.groupBy({
      by: ['assigned_to'],
      where: {
        company_id: companyId,
        mode: 'manual',
        status: 'active',
        assigned_to: { in: operators.map((op) => op.id) },
      },
      _count: { assigned_to: true },
    });
    for (const row of loadRows) {
      if (row.assigned_to) {
        activeByOperator.set(row.assigned_to, row._count.assigned_to);
      }
    }

    const withLoads = operators.map((op) => {
      const presenceStatus = statusMap.get(op.id) || 'available';
      return {
        ...op,
        active_chats: activeByOperator.get(op.id) ?? 0,
        is_online: true,
        presence_status: presenceStatus,
      };
    });

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
        end_users: {
          select: {
            id: true,
            name: true,
            metadata: true,
          },
        },
        painel_clients: { select: { id: true, company_name: true } },
        conversation_state: { select: { state: true, updated_at: true } },
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

  private async addMessageParts(
    messageId: string,
    dto: AddMessageDto,
    tx: Prisma.TransactionClient,
  ) {
    const parts = dto.parts?.length
      ? dto.parts
      : dto.content
        ? [{ type: 'text', text: dto.content }]
        : [];

    const rows: {
      message_id: string;
      part_type: string;
      text_content: string | null;
      media_asset_id: string | null;
      order_index: number;
      metadata: any;
    }[] = [];

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

        const mediaAsset = await tx.media_assets.create({
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

      rows.push({
        message_id: messageId,
        part_type: part.type,
        text_content: part.text || null,
        media_asset_id: mediaAssetId,
        order_index: orderIndex,
        metadata: (part.metadata || {}) as any,
      });
    }

    if (rows.length > 0) {
      await tx.message_parts.createMany({ data: rows });
    }
  }

  async generateSummary(
    conversationId: string,
    companyId: string,
  ): Promise<{
    summary: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    key_points: string[];
    suggested_action: string;
  }> {
    const conv = await this.prisma.conversations.findFirst({
      where: { id: conversationId, company_id: companyId },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
          take: 50,
        },
        end_users: true,
      },
    });

    if (!conv) {
      throw new NotFoundException('Conversa não encontrada');
    }

    const messages = conv.messages || [];
    if (messages.length === 0) {
      return {
        summary: 'Conversa iniciada sem mensagens registradas.',
        sentiment: 'neutral',
        key_points: ['Conversa aberta'],
        suggested_action: 'Aguardar mensagem do cliente ou iniciar contato',
      };
    }

    const clientMsgs = messages.filter((m) => m.sender_type === 'user');
    const aiMsgs = messages.filter(
      (m) => m.sender_type === 'ai' || m.sender_type === 'agent',
    );
    const totalMsgs = messages.length;

    // Análise semântica de sentimento
    const fullText = messages
      .map((m) => m.content || '')
      .join(' ')
      .toLowerCase();
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
    if (
      fullText.includes('obrigado') ||
      fullText.includes('excelente') ||
      fullText.includes('perfeito') ||
      fullText.includes('fechado') ||
      fullText.includes('acordo') ||
      fullText.includes('ótimo')
    ) {
      sentiment = 'positive';
    } else if (
      fullText.includes('ruim') ||
      fullText.includes('péssimo') ||
      fullText.includes('processo') ||
      fullText.includes('reclamação') ||
      fullText.includes('erro') ||
      fullText.includes('cancelar')
    ) {
      sentiment = 'negative';
    }

    const keyPoints: string[] = [];
    keyPoints.push(
      `Total de ${totalMsgs} mensagens (${clientMsgs.length} do cliente, ${aiMsgs.length} do assistente)`,
    );
    if (conv.origin_channel) {
      keyPoints.push(`Canal de origem: ${conv.origin_channel.toUpperCase()}`);
    }
    if (conv.mode === 'manual') {
      keyPoints.push('Conversa transferida para atendimento humano');
    }

    const lastClientMsg = clientMsgs[clientMsgs.length - 1]?.content || '';
    const summary = `Atendimento via canal ${conv.origin_channel || 'omnichannel'}. ${
      clientMsgs.length > 0
        ? `Cliente solicitou: "${lastClientMsg.slice(0, 100)}..."`
        : 'Sessão aberta sem interação direta do cliente.'
    } Status da conversa: ${conv.status}.`;

    const suggestedAction =
      conv.status === 'closed'
        ? 'Nenhuma ação necessária (conversa já encerrada)'
        : conv.mode === 'manual'
          ? 'Responder à última dúvida do cliente no chat thread'
          : 'Manter IA monitorando o fluxo automático';

    const result = {
      summary,
      sentiment,
      key_points: keyPoints,
      suggested_action: suggestedAction,
    };

    // Persiste no metadata da conversa
    const currentMeta = (conv.metadata as Record<string, any>) || {};
    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        metadata: {
          ...currentMeta,
          ai_summary: result,
          sentiment,
        },
      },
    });

    return result;
  }

  async generateSmartReply(
    conversationId: string,
    companyId: string,
  ): Promise<{ suggestions: string[] }> {
    const conv = await this.prisma.conversations.findFirst({
      where: { id: conversationId, company_id: companyId },
      include: {
        messages: {
          orderBy: { created_at: 'desc' },
          take: 5,
        },
        end_users: true,
      },
    });

    if (!conv) {
      throw new NotFoundException('Conversa não encontrada');
    }

    const userName = conv.end_users?.name || 'cliente';
    const lastMsg = conv.messages?.[0]?.content?.toLowerCase() || '';

    const suggestions: string[] = [];

    if (
      lastMsg.includes('preço') ||
      lastMsg.includes('valor') ||
      lastMsg.includes('quanto')
    ) {
      suggestions.push(
        `Olá ${userName}, nossos valores variam de acordo com o plano ideal para você. Gostaria que eu te apresentasse as opções?`,
      );
      suggestions.push(
        `Com certeza! Posso gerar uma proposta personalizada para você agora mesmo.`,
      );
      suggestions.push(
        `Vou consultar as condições especiais disponíveis para o seu cadastro, um instante.`,
      );
    } else if (
      lastMsg.includes('pix') ||
      lastMsg.includes('pagamento') ||
      lastMsg.includes('boleto')
    ) {
      suggestions.push(
        `Segue a chave PIX para pagamento: [chave-pix-da-empresa]. Assim que realizar, por favor envie o comprovante por aqui.`,
      );
      suggestions.push(
        `Gerei o seu link de pagamento seguro. Você pode efetuar via cartão ou PIX.`,
      );
    } else if (
      lastMsg.includes('humano') ||
      lastMsg.includes('atendente') ||
      lastMsg.includes('falar com')
    ) {
      suggestions.push(
        `Olá ${userName}, já estou com o seu histórico aberto. Como posso te ajudar agora?`,
      );
      suggestions.push(
        `Perfeito, sou o atendente responsável pelo seu caso. Em que posso ser útil hoje?`,
      );
    } else {
      suggestions.push(
        `Olá ${userName}, verifiquei a sua mensagem e já estou providenciando as informações.`,
      );
      suggestions.push(
        `Entendido! Precisa de mais algum detalhe sobre esse assunto?`,
      );
      suggestions.push(
        `Obrigado pelo contato! Se precisar de qualquer outra assistência, estou à disposição.`,
      );
    }

    return { suggestions };
  }

  async exportConversation(
    conversationId: string,
    companyId: string,
    format: 'txt' | 'json' = 'txt',
  ): Promise<{ contentType: string; filename: string; content: string }> {
    const conv = await this.prisma.conversations.findFirst({
      where: { id: conversationId, company_id: companyId },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
        },
        end_users: true,
        painel_clients: true,
      },
    });

    if (!conv) {
      throw new NotFoundException('Conversa não encontrada');
    }

    const filename = `conversa-${conv.id.slice(0, 8)}-${Date.now()}.${format}`;

    if (format === 'json') {
      return {
        contentType: 'application/json',
        filename,
        content: JSON.stringify(conv, null, 2),
      };
    }

    const userMeta = (conv.end_users?.metadata as Record<string, any>) || {};
    const contact = userMeta.phone || userMeta.email || 'Sem contato';

    // Formato TXT formatado
    let text = `====================================================\n`;
    text += `SYNEXA ENTERPRISE - REGISTRO DE ATENDIMENTO\n`;
    text += `ID da Conversa: ${conv.id}\n`;
    text += `Data de Início: ${conv.created_at ? new Date(conv.created_at).toLocaleString('pt-BR') : 'n/d'}\n`;
    text += `Canal: ${(conv.origin_channel || 'Web').toUpperCase()}\n`;
    text += `Cliente/Lead: ${conv.end_users?.name || 'Não identificado'} (${contact})\n`;
    text += `Assistente/Empresa: ${conv.painel_clients?.company_name || 'Synexa'}\n`;
    text += `Status: ${conv.status.toUpperCase()}\n`;
    text += `====================================================\n\n`;
    text += `--- HISTÓRICO DE MENSAGENS ---\n\n`;

    for (const msg of conv.messages || []) {
      const time = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString('pt-BR')
        : '';
      const sender =
        msg.sender_type === 'user'
          ? conv.end_users?.name || 'Cliente'
          : msg.sender_type === 'agent'
            ? 'Atendente Humano'
            : 'IA Assistente';
      text += `[${time}] ${sender}: ${msg.content || '(Mídia/Ação)'}\n`;
    }

    text += `\n====================================================\n`;
    text += `Fim do Registro de Atendimento\n`;

    return {
      contentType: 'text/plain; charset=utf-8',
      filename,
      content: text,
    };
  }

  async streamRecording(
    conversationId: string,
    companyId: string,
    res: any,
  ): Promise<void> {
    const conv = await this.prisma.conversations.findFirst({
      where: { id: conversationId, company_id: companyId },
    });

    if (!conv) {
      throw new NotFoundException('Conversa não encontrada');
    }

    const rawMeta = (conv.metadata as Record<string, any>) || {};
    const contextVars =
      (rawMeta.context_variables as Record<string, any>) || {};
    const callId = rawMeta.call_id || rawMeta.callId;
    const channelId =
      rawMeta.channel_id ||
      rawMeta.channelId ||
      contextVars.channel_id ||
      contextVars.channelId;

    const possiblePaths = [
      `/app/uploads/recordings/${conversationId}.wav`,
      `/app/uploads/recordings/synexa-${conversationId}.wav`,
      `/var/spool/asterisk/monitor/synexa-${conversationId}.wav`,
      `/tmp/recordings/${conversationId}.wav`,
    ];

    if (callId) {
      possiblePaths.push(
        `/app/uploads/recordings/${callId}.wav`,
        `/app/uploads/recordings/synexa-${callId}.wav`,
        `/var/spool/asterisk/monitor/synexa-${callId}.wav`,
      );
    }
    if (channelId) {
      possiblePaths.push(
        `/app/uploads/recordings/${channelId}.wav`,
        `/app/uploads/recordings/synexa-${channelId}.wav`,
        `/var/spool/asterisk/monitor/synexa-${channelId}.wav`,
      );
    }

    let foundPath: string | null = null;
    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        foundPath = filePath;
        break;
      }
    }

    // Busca de fallback nos diretórios se o arquivo contiver o UUID
    if (!foundPath) {
      const searchDirs = [
        '/app/uploads/recordings',
        '/var/spool/asterisk/monitor',
      ];
      const targets = [conversationId, callId, channelId].filter(Boolean);

      for (const dir of searchDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              if (targets.some((target) => file.includes(target as string))) {
                foundPath = `${dir}/${file}`;
                break;
              }
            }
          } catch {
            // Ignora erro de leitura do dir
          }
        }
        if (foundPath) break;
      }
    }

    if (!foundPath) {
      throw new NotFoundException(
        'Arquivo de gravação não encontrado para esta chamada',
      );
    }

    const stat = fs.statSync(foundPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(foundPath).pipe(res);
  }

  private inferMimeType(partType: string) {
    if (partType === 'image') return 'image/*';
    if (partType === 'audio') return 'audio/*';
    return 'application/octet-stream';
  }
}
