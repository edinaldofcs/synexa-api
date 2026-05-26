import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByEndUser(
    clientId: string,
    originChannel: string,
    externalUserId: string,
  ) {
    return this.prisma.conversations.findFirst({
      where: {
        client_id: clientId,
        origin_channel: originChannel,
        end_users: {
          channel_identities: {
            some: {
              channel_type: originChannel,
              external_user_id: externalUserId,
            },
          },
        },
        status: { not: 'closed' },
      },
      include: {
        end_users: true,
        channel_connections: true,
        conversation_state: true,
      },
    });
  }

  async findByExternalKey(clientId: string, externalKey: string) {
    return this.prisma.conversations.findFirst({
      where: {
        client_id: clientId,
        external_conversation_key: externalKey,
        status: { not: 'closed' },
      },
      include: {
        end_users: true,
        channel_connections: true,
        conversation_state: true,
      },
    });
  }

  async create(data: {
    company_id: string;
    client_id: string;
    channel_connection_id: string;
    end_user_id: string;
    origin_channel: string;
    external_conversation_key?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.conversations.create({
      data: {
        company_id: data.company_id,
        client_id: data.client_id,
        channel_connection_id: data.channel_connection_id,
        end_user_id: data.end_user_id,
        origin_channel: data.origin_channel,
        external_conversation_key: data.external_conversation_key || null,
        status: 'active',
        mode: 'auto',
        metadata: (data.metadata || {}) as any,
      },
      include: { end_users: true, channel_connections: true },
    });
  }

  async findById(id: string) {
    return this.prisma.conversations.findUnique({
      where: { id },
      include: {
        end_users: true,
        channel_connections: true,
        conversation_state: true,
        messages: {
          orderBy: { created_at: 'asc' },
          take: 50,
        },
      },
    });
  }

  async updateLastMessage(id: string, direction: string) {
    const now = new Date();
    return this.prisma.conversations.update({
      where: { id },
      data: {
        last_message_at: now,
        ...(direction === 'inbound'
          ? { last_inbound_at: now }
          : { last_outbound_at: now }),
      },
    });
  }
}
