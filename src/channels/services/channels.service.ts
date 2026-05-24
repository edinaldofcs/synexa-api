import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WebhooksService } from '../../webhooks/services/webhooks.service';
import { QueueService } from '../../queue/queue.service';
import { ChannelAdapter, NormalizedMessage, ChannelConnectionConfig, OutboundMessage } from '../adapters/channel-adapter.interface';
import { WhatsappAdapter } from '../adapters/whatsapp.adapter';
import { ApiAdapter } from '../adapters/api.adapter';
import { SendMessageDto } from '../dto/send-message.dto';

export interface InboundResult {
  request_id: string;
  inbound_event_id: string;
  conversation_id: string;
  message_id: string;
  status: string;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly adapters: Map<string, ChannelAdapter> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
    private readonly queueService: QueueService,
    whatsappAdapter: WhatsappAdapter,
    apiAdapter: ApiAdapter,
  ) {
    this.adapters.set(whatsappAdapter.channelType, whatsappAdapter);
    this.adapters.set(apiAdapter.channelType, apiAdapter);
  }

  async processInbound(dto: SendMessageDto): Promise<InboundResult> {
    const adapter = this.adapters.get(dto.origin_channel);
    if (!adapter) {
      throw new BadRequestException(`Unsupported channel: ${dto.origin_channel}`);
    }

    const connection = await this.resolveConnection(dto.client_id, dto.origin_channel);
    if (!connection) {
      throw new NotFoundException(`No active channel connection for client ${dto.client_id} / ${dto.origin_channel}`);
    }

    const normalized = adapter.normalize(dto as unknown as Record<string, unknown>);
    normalized.company_id = connection.company_id;

    if (dto.idempotency_key) {
      const existing = await this.prisma.inbound_events.findFirst({
        where: {
          client_id: dto.client_id,
          channel_type: dto.origin_channel,
          idempotency_key: dto.idempotency_key,
        },
      });
      if (existing) {
        throw new BadRequestException('Duplicate idempotency_key');
      }
    }

    const requestId = uuidv4();

    const inboundEvent = await this.prisma.inbound_events.create({
      data: {
        company_id: connection.company_id,
        client_id: dto.client_id,
        channel_connection_id: connection.id,
        channel_type: dto.origin_channel,
        raw_payload: dto as unknown as Prisma.InputJsonValue,
        status: 'received',
        idempotency_key: dto.idempotency_key || null,
        request_id: requestId,
      },
    });

    const text = dto.message?.text || '';

    await this.queueService.addIngestionJob({
      inbound_event_id: inboundEvent.id,
      client_id: dto.client_id,
      company_id: connection.company_id,
      channel_connection_id: connection.id,
      origin_channel: dto.origin_channel,
      external_user_id: dto.external_user_id,
      conversation_key: dto.conversation_key,
      message_type: dto.message?.type || 'text',
      text,
      parts: dto.message?.parts,
      idempotency_key: dto.idempotency_key,
      request_id: requestId,
      raw_payload: dto as unknown as Record<string, unknown>,
      metadata: dto.metadata,
    });

    return {
      request_id: requestId,
      inbound_event_id: inboundEvent.id,
      conversation_id: '',
      message_id: '',
      status: 'queued',
    };
  }

  async sendOutbound(
    connectionId: string,
    to: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const connection = await this.prisma.channel_connections.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException(`Channel connection ${connectionId} not found`);
    }

    if (connection.channel_type === 'api') {
      const returnUrl = metadata?.return_webhook_url as string;
      if (returnUrl) {
        await this.webhooksService.deliver(connection.client_id, {
          event: 'message.completed',
          conversation_id: metadata?.conversation_id as string || '',
          inbound_message_id: metadata?.inbound_message_id as string || '',
          response_message_id: metadata?.response_message_id as string || '',
          origin_channel: 'api',
          external_user_id: to,
          response: { type: 'text', text },
          status: 'completed',
          metadata,
        });
      }
      return;
    }

    const adapter = this.adapters.get(connection.channel_type);
    if (!adapter) {
      throw new BadRequestException(`No adapter for channel type: ${connection.channel_type}`);
    }

    const config: ChannelConnectionConfig = {
      id: connection.id,
      client_id: connection.client_id,
      company_id: connection.company_id,
      channel_type: connection.channel_type,
      provider: connection.provider,
      provider_account_id: connection.provider_account_id,
      config: connection.config as Record<string, unknown> | null,
      inbound_secret_hash: connection.inbound_secret_hash,
    };

    const message: OutboundMessage = { to, text, metadata };
    const result = await adapter.send(config, message);

    if (!result.success) {
      this.logger.error({ connectionId, to, error: result.error }, 'Outbound delivery failed');
    }
  }

  private async resolveEndUser(
    connection: ChannelConnectionConfig,
    dto: SendMessageDto,
  ): Promise<string> {
    let identity = await this.prisma.channel_identities.findFirst({
      where: {
        client_id: dto.client_id,
        channel_type: dto.origin_channel,
        external_user_id: dto.external_user_id,
      },
      include: { end_users: true },
    });

    if (identity) return identity.end_user_id;

    const endUser = await this.prisma.end_users.create({
      data: {
        company_id: connection.company_id,
        client_id: dto.client_id,
        metadata: dto.metadata as any || {},
      },
    });

    await this.prisma.channel_identities.create({
      data: {
        company_id: connection.company_id,
        client_id: dto.client_id,
        end_user_id: endUser.id,
        channel_type: dto.origin_channel,
        external_user_id: dto.external_user_id,
        normalized_phone: dto.origin_channel === 'whatsapp' ? dto.external_user_id : null,
      },
    });

    return endUser.id;
  }

  private async resolveConnection(clientId: string, channelType: string): Promise<ChannelConnectionConfig | null> {
    const connection = await this.prisma.channel_connections.findUnique({
      where: {
        client_id_channel_type: {
          client_id: clientId,
          channel_type: channelType,
        },
      },
    });

    if (!connection || connection.status !== 'active') return null;

    return {
      id: connection.id,
      client_id: connection.client_id,
      company_id: connection.company_id,
      channel_type: connection.channel_type,
      provider: connection.provider,
      provider_account_id: connection.provider_account_id,
      config: connection.config as Record<string, unknown> | null,
      inbound_secret_hash: connection.inbound_secret_hash,
    };
  }
}
