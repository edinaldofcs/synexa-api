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
import { TabulationService } from './services/tabulation.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly tabulationService: TabulationService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('mode') mode?: string,
    @Query('status') status?: string,
    @Query('track_id') trackId?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listByClient({
      clientId,
      companyId: ctx.companyId,
      mode,
      status,
      track_id: trackId,
    });
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

  @Post(':id/tabulate')
  manualTabulate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('track_id', ParseUUIDPipe) trackId: string,
    @Body('notes') notes: string,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.tabulationService.manualTabulate(
      id,
      trackId,
      notes,
      user?.id,
      ctx.companyId,
    );
  }

  @Post(':id/re-tabulate')
  reTabulate(@Param('id', ParseUUIDPipe) id: string) {
    return this.tabulationService.tabulateConversation(id);
  }

  @Patch('clients/:clientId/tabulation-config')
  updateTabulationConfig(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body('inactivity_minutes') inactivityMinutes: number,
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.updateTabulationConfig(
      clientId,
      Number(inactivityMinutes) || 30,
      ctx.companyId,
    );
  }
}
