import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import type { HandoffRequestDto } from './dto/find-or-create.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(@Query('client_id') clientId?: string) {
    return this.conversationsService.listByClient(clientId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.conversationsService.getConversation(id);
  }

  @Post(':id/handoff')
  requestHandoff(@Param('id') id: string, @Body() dto: HandoffRequestDto) {
    return this.conversationsService.requestHandoff(id, dto);
  }

  @Post(':id/release-handoff')
  releaseHandoff(@Param('id') id: string) {
    return this.conversationsService.releaseHandoff(id);
  }

  @Get('handoff/queue')
  handoffQueue(@Query('client_id') clientId?: string) {
    return this.conversationsService.listHandoffQueue(clientId);
  }
}
