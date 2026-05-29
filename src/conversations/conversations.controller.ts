import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import type { HandoffRequestDto } from './dto/find-or-create.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: any, @Query('client_id') clientId?: string) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listByClient(clientId, ctx.companyId);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversationsService.getConversation(id);
  }

  @Get(':id/messages')
  getMessages(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversationsService.getMessages(id);
  }

  @Post(':id/messages')
  sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { content: string; sender_type?: string },
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.sendMessage(id, dto, ctx.companyId);
  }

  @Patch(':id')
  updateConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { status?: string; mode?: string },
  ) {
    return this.conversationsService.updateConversation(id, dto);
  }

  @Post(':id/handoff')
  requestHandoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HandoffRequestDto,
  ) {
    return this.conversationsService.requestHandoff(id, dto);
  }

  @Post(':id/release-handoff')
  releaseHandoff(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversationsService.releaseHandoff(id);
  }

  @Get('handoff/queue')
  handoffQueue(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listHandoffQueue(clientId, ctx.companyId);
  }
}
