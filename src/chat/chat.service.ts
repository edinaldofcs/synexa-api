import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private prisma: PrismaService) {}

  private async getUserCompanyId(userId: string): Promise<string> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { company_id: true },
    });
    if (!user?.company_id) {
      throw new ForbiddenException('Usuário sem empresa vinculada');
    }
    return user.company_id;
  }

  async getConversations(userId: string) {
    const companyId = await this.getUserCompanyId(userId);

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

  async createConversation(dto: CreateConversationDto, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
    return this.prisma.conversations.create({
      data: {
        company_id: companyId,
        assigned_to: dto.assignedTo,
        status: 'active',
      },
    });
  }

  async getConversation(id: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
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

  async getMessages(conversationId: string, userId: string) {
    const companyId = await this.getUserCompanyId(userId);
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
    userId: string,
  ) {
    const companyId = await this.getUserCompanyId(userId);
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
    try {
      await fetch('https://prd.naldofcs-ai.com/webhook/receptor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this.logger.log('Triggering webhook with payload:', payload);
    } catch (error) {
      this.logger.error('Error triggering webhook:', error);
    }
  }
}
