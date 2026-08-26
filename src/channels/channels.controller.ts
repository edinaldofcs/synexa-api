import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Logger,
  UseGuards,
  Query,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../common/auth/public.decorator';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { RequiresApiKey } from '../common/auth/api-key.decorator';
import { ChannelsService, InboundResult } from './services/channels.service';
import { SendMessageDto } from './dto/send-message.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { extractTenantContext } from '../common/utils/tenant-access.helper';
import { sanitize } from '../common/utils/sanitize-log.util';
import { randomBytes } from 'crypto';

@Controller()
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(
    private readonly channelsService: ChannelsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('channels')
  async listChannels(
    @CurrentUser() user: any,
    @Query('client_id') clientId?: string,
  ) {
    const ctx = extractTenantContext(user);
    const where: any = {};
    if (clientId) where.client_id = clientId;
    if (ctx.companyId) where.company_id = ctx.companyId;
    return this.prisma.channel_connections.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  @Get('channels/:id')
  async getChannel(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = extractTenantContext(user);

    const connection = await this.prisma.channel_connections.findFirst({
      where: {
        id,
        company_id: ctx.companyId,
      },
    });

    if (!connection) {
      throw new NotFoundException('Channel connection not found');
    }

    return connection;
  }

  @Patch('channels/:id')
  async updateChannel(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    const ctx = extractTenantContext(user);

    // Verify ownership of the connection
    const connection = await this.prisma.channel_connections.findFirst({
      where: {
        id,
        company_id: ctx.companyId,
      },
    });

    if (!connection) {
      throw new NotFoundException('Channel connection not found');
    }

    return this.prisma.channel_connections.update({
      where: { id },
      data: {
        provider: body.provider,
        provider_account_id: body.provider_account_id,
        status: body.status,
        config: body.config !== undefined ? body.config : undefined,
        updated_at: new Date(),
      },
    });
  }

  @Delete('channels/:id')
  async deleteChannel(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ctx = extractTenantContext(user);

    // Verify ownership of the connection
    const connection = await this.prisma.channel_connections.findFirst({
      where: {
        id,
        company_id: ctx.companyId,
      },
    });

    if (!connection) {
      throw new NotFoundException('Channel connection not found');
    }

    // Clean up associated conversations first to satisfy foreign key constraints
    await this.prisma.conversations.updateMany({
      where: { channel_connection_id: id },
      data: { channel_connection_id: null },
    });

    // Clean up webhook endpoints referencing this connection
    await this.prisma.webhook_endpoints.updateMany({
      where: { channel_connection_id: id },
      data: { channel_connection_id: null },
    });

    return this.prisma.channel_connections.delete({
      where: { id },
    });
  }

  @Post('channels')
  async createChannel(@CurrentUser() user: any, @Body() body: any) {
    const ctx = extractTenantContext(user);

    // Validate that the client belongs to the user's company
    const client = await this.prisma.painel_clients.findFirst({
      where: {
        id: body.client_id,
        company_id: ctx.companyId,
      },
    });

    if (!client) {
      throw new UnauthorizedException('Client not found or access denied');
    }

    // Check if a connection for this client and channel_type already exists
    const existing = await this.prisma.channel_connections.findFirst({
      where: {
        client_id: body.client_id,
        channel_type: body.channel_type,
      },
    });

    if (existing) {
      throw new BadRequestException(
        'A connection of this type already exists for this client',
      );
    }

    const secret = 'whsec_' + randomBytes(24).toString('hex');

    return this.prisma.channel_connections.create({
      data: {
        company_id: ctx.companyId,
        client_id: body.client_id,
        channel_type: body.channel_type,
        provider: body.provider,
        provider_account_id: body.provider_account_id || null,
        status: body.status || 'active',
        inbound_secret_hash: secret,
        config: body.config || {},
      },
    });
  }

  @Public()
  @UseGuards(ApiKeyGuard)
  @RequiresApiKey()
  @Post('public/messages')
  async receiveMessage(@Body() body: SendMessageDto): Promise<InboundResult> {
    this.logger.log(
      {
        client_id: sanitize(body.client_id),
        origin_channel: body.origin_channel,
      },
      'Inbound message received',
    );
    return this.channelsService.processInbound(body);
  }
}
