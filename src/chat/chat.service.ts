import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { sanitize } from '../common/utils/sanitize-log.util';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async getConversations(companyId: string) {
    return this.prisma.conversations.findMany({
      where: { company_id: companyId },
      include: {
        messages: {
          take: 1,
          orderBy: { created_at: 'desc' },
        },
      },
      orderBy: { last_message_at: 'desc' },
    });
  }

  async createConversation(dto: CreateConversationDto, companyId: string) {
    return this.prisma.conversations.create({
      data: {
        company_id: companyId,
        assigned_to: dto.assignedTo,
        status: 'active',
      },
    });
  }

  async getConversation(id: string, companyId: string) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.company_id !== companyId) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  async getMessages(conversationId: string, companyId: string) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { company_id: true },
    });
    if (!conversation || conversation.company_id !== companyId) {
      throw new NotFoundException('Conversation not found');
    }
    return this.prisma.messages.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'asc' },
    });
  }

  async sendMessage(
    conversationId: string,
    dto: CreateMessageDto,
    companyId: string,
  ) {
    const conversation = await this.prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { company_id: true },
    });
    if (!conversation || conversation.company_id !== companyId) {
      throw new NotFoundException('Conversation not found');
    }

    const message = await this.prisma.messages.create({
      data: {
        company_id: companyId,
        conversation_id: conversationId,
        content: dto.content,
        sender_type: dto.senderType,
        channel: dto.channel,
        attachments: dto.attachments,
        delivery_status: 'sent',
      },
    });

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        last_message_at: new Date(),
      },
    });

    if (dto.senderType === 'human') {
      void this.triggerWebhook({
        conversation_id: conversationId,
        sender: 'human',
      });
    }

    return message;
  }

  private async triggerWebhook(payload: Record<string, unknown>) {
    const webhookUrl = this.configService.get<string>(
      'CHAT_FORWARD_WEBHOOK_URL',
      '',
    );
    if (!webhookUrl) return;

    try {
      const body = JSON.stringify(payload);
      const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (encryptionKey) {
        headers['x-synexa-signature'] = createHmac('sha256', encryptionKey)
          .update(body)
          .digest('hex');
      }
      await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body,
      });
      this.logger.log(`Webhook forwarded with payload: ${JSON.stringify(sanitize(payload))}`);
    } catch (error) {
      this.logger.error('Error triggering webhook:', error);
    }
  }
}
