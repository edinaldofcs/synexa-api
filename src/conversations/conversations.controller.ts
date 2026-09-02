import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.getConversation(id, ctx.companyId);
  }

  @Get(':id/messages')
  getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('offset') offset?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.getMessages(id, ctx.companyId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      before,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
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
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.updateConversation(id, dto, ctx.companyId);
  }

  @Post(':id/handoff')
  requestHandoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HandoffRequestDto,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.requestHandoff(id, dto, ctx.companyId);
  }

  @Post(':id/release-handoff')
  releaseHandoff(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.releaseHandoff(id, ctx.companyId);
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

  @Post(':id/summary')
  generateSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.generateSummary(id, ctx.companyId);
  }

  @Post(':id/smart-reply')
  generateSmartReply(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.generateSmartReply(id, ctx.companyId);
  }

  @Get(':id/export')
  export(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Query('format') format?: 'txt' | 'json',
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.exportConversation(
      id,
      ctx.companyId,
      format || 'txt',
    );
  }

  @Get(':id/recording')
  getRecording(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.streamRecording(id, ctx.companyId, res);
  }
}
