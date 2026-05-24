import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { Public } from '../common/auth/public.decorator';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { RequiresApiKey } from '../common/auth/api-key.decorator';
import { ChannelsService, InboundResult } from './services/channels.service';
import { SendMessageDto } from './dto/send-message.dto';

@UseGuards(ApiKeyGuard)
@Controller('api/public')
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(private readonly channelsService: ChannelsService) {}

  @Public()
  @RequiresApiKey()
  @Post('messages')
  async receiveMessage(@Body() body: SendMessageDto): Promise<InboundResult> {
    this.logger.log({ client_id: body.client_id, origin_channel: body.origin_channel }, 'Inbound message received');
    return this.channelsService.processInbound(body);
  }
}
