import { Controller, Get, Post, Param, Body, Logger, UseGuards, Query } from '@nestjs/common';
import { Public } from '../common/auth/public.decorator';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { RequiresApiKey } from '../common/auth/api-key.decorator';
import { ChannelsService, InboundResult } from './services/channels.service';
import { SendMessageDto } from './dto/send-message.dto';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller()
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(
    private readonly channelsService: ChannelsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('channels')
  async listChannels(@Query('client_id') clientId?: string) {
    const where: any = {};
    if (clientId) where.client_id = clientId;
    return this.prisma.channel_connections.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  @Get('channels/:id')
  async getChannel(@Param('id') id: string) {
    return this.prisma.channel_connections.findUnique({ where: { id } });
  }

  @Public()
  @UseGuards(ApiKeyGuard)
  @RequiresApiKey()
  @Post('api/public/messages')
  async receiveMessage(@Body() body: SendMessageDto): Promise<InboundResult> {
    this.logger.log({ client_id: body.client_id, origin_channel: body.origin_channel }, 'Inbound message received');
    return this.channelsService.processInbound(body);
  }
}
