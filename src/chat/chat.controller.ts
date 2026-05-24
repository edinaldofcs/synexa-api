import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ChatService } from './chat.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('conversations')
  async getConversations(@CurrentUser() user: { id: string }) {
    return this.chatService.getConversations(user.id);
  }

  @Post('conversations')
  async createConversation(
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.chatService.createConversation(dto, user.id);
  }

  @Get('conversations/:id')
  async getConversation(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.chatService.getConversation(id, user.id);
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.chatService.getMessages(id, user.id);
  }

  @Post('conversations/:id/messages')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.chatService.sendMessage(id, dto, user.id);
  }
}
