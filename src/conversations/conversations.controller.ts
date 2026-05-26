import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
