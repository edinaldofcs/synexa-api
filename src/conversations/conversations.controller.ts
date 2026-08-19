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
  list(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('mode') mode?: string,
    @Query('assigned_to') assignedTo?: string,
    @Query('unassigned') unassigned?: string,
    @Query('status') status?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listByClient({
      clientId,
      companyId: ctx.companyId,
      mode,
      assigned_to: assignedTo,
      unassigned: unassigned === 'true',
      status,
    });
  }

  @Post('operator/heartbeat')
  operatorHeartbeat(
    @CurrentUser() user: any,
    @Body('status') status?: 'available' | 'finishing',
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.operatorHeartbeat(
      user.id,
      ctx.companyId,
      status,
    );
  }

  @Post('operator/status')
  setOperatorStatus(
    @CurrentUser() user: any,
    @Body('status') status: 'available' | 'finishing',
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.setOperatorStatus(
      user.id,
      ctx.companyId,
      status,
    );
  }

  @Post('operator/go-offline')
  operatorGoOffline(@CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.operatorGoOffline(user.id, ctx.companyId);
  }

  @Get('operator/online')
  listOnlineOperators(@CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listOnlineOperators(ctx.companyId);
  }

  @Get('handoff/queue')
  handoffQueue(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listHandoffQueue(clientId, ctx.companyId);
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

  @Post(':id/reassign')
  reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('operator_id') operatorId: string,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.reassignConversation(
      id,
      operatorId,
      ctx.companyId,
    );
  }
}
