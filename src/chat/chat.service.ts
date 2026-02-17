import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { log } from 'console';

@Injectable()
export class ChatService {
    constructor(private prisma: PrismaService) { }

    async getConversations(companyId?: string, userId?: string) {
        if (!companyId && userId) {
            const user = await this.prisma.users.findUnique({ where: { id: userId } });
            if (user) companyId = user.company_id;
        }

        if (!companyId) return [];

        return this.prisma.conversations.findMany({
            where: { company_id: companyId },
            include: {
                person: true,
                messages: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            },
            orderBy: { last_message_at: 'desc' }
        });
    }

    async createConversation(dto: CreateConversationDto) {
        return this.prisma.conversations.create({
            data: {
                company_id: dto.companyId,
                person_id: dto.personId,
                debt_id: dto.debtId,
                assigned_to: dto.assignedTo,
                status: 'active'
            }
        });
    }

    async getConversation(id: string) {
        const conversation = await this.prisma.conversations.findUnique({
            where: { id },
            include: {
                person: true,
                debts: true,
                messages: {
                    orderBy: { created_at: 'asc' }
                }
            }
        });

        if (!conversation) throw new NotFoundException('Conversation not found');
        return conversation;
    }

    async getMessages(conversationId: string) {
        return this.prisma.messages.findMany({
            where: { conversation_id: conversationId },
            orderBy: { created_at: 'asc' }
        });
    }

    async sendMessage(conversationId: string, dto: CreateMessageDto) {
        // 1. Create message
        const message = await this.prisma.messages.create({
            data: {
                company_id: dto.companyId,
                conversation_id: conversationId,
                content: dto.content,
                sender_type: dto.senderType,
                channel: dto.channel,
                attachments: dto.attachments,
                delivery_status: 'sent'
            }
        });

        // 2. Update conversation last_message_at
        await this.prisma.conversations.update({
            where: { id: conversationId },
            data: {
                last_message_at: new Date()
            }
        });

        if (dto.senderType === 'human') {
            this.triggerWebhook({
                conversation_id: conversationId,
                sender:'human'
            });
        }

        return message;
    }

    private async triggerWebhook(payload: any) {
        try {
            await fetch('https://prd.naldofcs-ai.com/webhook/receptor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            console.log('Triggering webhook with payload:', payload);
        } catch (error) {
            console.error('Error triggering webhook:', error);
        }
    }
}
