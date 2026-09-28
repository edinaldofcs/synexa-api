import { SearchConversationsDto } from './dto/search-conversations.dto';
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseUUIDPipe,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConversationsService } from './conversations.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';
import { BrandId } from '../common/config/branding';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
    @Query('status') status?: string,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.listByClient({
      clientId,
      companyId: ctx.companyId,
      status,
    });
  }

  @Get('search')
  search(@CurrentUser() user: any, @Query() query: SearchConversationsDto) {
    return this.conversationsService.searchConversations(
      extractTenantContext(user).companyId,
      query,
    );
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
    @Body() dto: { status?: string },
    @CurrentUser() user: any,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.updateConversation(id, dto, ctx.companyId);
  }

  @Get(':id/export')
  export(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Query('format') format?: 'txt' | 'json',
    @Query(
      'brand',
      new DefaultValuePipe(BrandId.Synexa),
      new ParseEnumPipe(BrandId),
    )
    brand?: BrandId,
  ) {
    const ctx = extractTenantContext(user);
    return this.conversationsService.exportConversation(
      id,
      ctx.companyId,
      format || 'txt',
      brand,
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
