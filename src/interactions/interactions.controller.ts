import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InteractionsService } from './interactions.service';
import { CreateInteractionDto } from './dto/create-interaction.dto';
import { UpdateInteractionDto } from './dto/update-interaction.dto';
import { AuthGuard } from '../common/auth/auth.guard';

@Controller('interactions')
@UseGuards(AuthGuard)
export class InteractionsController {
  constructor(private readonly interactionsService: InteractionsService) {}

  @Post()
  async createSession(@Body() dto: CreateInteractionDto) {
    return this.interactionsService.findOrCreateSession(dto);
  }

  @Post(':sessionId/messages')
  async appendMessage(
    @Param('sessionId') sessionId: string,
    @Body() message: any,
  ) {
    return this.interactionsService.appendMessage(sessionId, message);
  }

  @Post(':sessionId/barge-in')
  async recordBargeIn(
    @Param('sessionId') sessionId: string,
    @Body() body: { latencyMs?: number },
  ) {
    return this.interactionsService.recordBargeIn(sessionId, body?.latencyMs);
  }

  @Post(':sessionId/update')
  async updateSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateInteractionDto,
  ) {
    return this.interactionsService.updateSession(sessionId, dto);
  }

  @Post(':sessionId/finalize')
  async finalizeSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: Partial<UpdateInteractionDto>,
  ) {
    return this.interactionsService.finalizeSession(sessionId, dto);
  }

  @Get('client/:clientId')
  async listInteractions(
    @Param('clientId') clientId: string,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('disposition') disposition?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.interactionsService.listInteractions(clientId, {
      channel,
      status,
      disposition,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('client/:clientId/funnel-metrics')
  async getFunnelMetrics(
    @Param('clientId') clientId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.interactionsService.getFunnelMetrics(
      clientId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }
}
