import { Controller, Get, Post, Body, Param, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { ChatService } from './chat.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    @Get('conversations')
    async getConversations(@Query('companyId') companyId?: string, @Query('userId') userId?: string) {
        if (!companyId && !userId) return { success: false, message: 'Company ID or User ID is required' };
        return this.chatService.getConversations(companyId, userId);
    }

    @Post('conversations')
    async createConversation(@Body() dto: CreateConversationDto) {
        return this.chatService.createConversation(dto);
    }

    @Get('conversations/:id')
    async getConversation(@Param('id') id: string) {
        return this.chatService.getConversation(id);
    }

    @Get('conversations/:id/messages')
    async getMessages(@Param('id') id: string) {
        return this.chatService.getMessages(id);
    }

    @Post('conversations/:id/messages')
    async sendMessage(@Param('id') id: string, @Body() dto: CreateMessageDto) {
        return this.chatService.sendMessage(id, dto);
    }
}
