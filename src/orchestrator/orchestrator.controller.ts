import { Controller, Post, Delete, Get, Body, Logger, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/auth/public.decorator';
import { CompatibilityService } from './compatibility.service';
import { OrchestratorService } from './orchestrator.service';
import { ChatRequestDto, WebhookMessageDto, DeleteSessionDto } from './dto/chat-request.dto';

@Controller('orchestrator')
export class OrchestratorController {
  private readonly logger = new Logger(OrchestratorController.name);

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly compatibilityService: CompatibilityService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return this.orchestratorService.health();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('chat')
  async chat(@Body() body: ChatRequestDto, @Res() res: Response) {
    this.logger.warn({ route: '/chat' }, '[DEPRECATED] /orchestrator/chat chamado');

    res.setHeader('X-Deprecated', 'true');
    res.setHeader('X-Deprecated-Message', 'Use POST /api/public/messages no lugar');
    res.setHeader('Sunset', 'Sat, 30 Aug 2026 23:59:59 GMT');

    const { cellPhone, to, transcript, client_phone, company_phone, message: oldMessage } = body;

    const finalClientPhone = cellPhone || client_phone;
    const finalCompanyPhone = to || company_phone;
    const finalMessage = transcript || oldMessage;

    if (!finalClientPhone || !finalCompanyPhone || !finalMessage) {
      return res.json({ error: 'cellPhone (ou client_phone), to (ou company_phone) e transcript (ou message) sao obrigatorios' });
    }

    try {
      const result = await this.compatibilityService.processChat(
        finalClientPhone!,
        finalCompanyPhone!,
        finalMessage!,
      );
      return res.json(result);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Erro no /chat compat');
      return res.json({ error: 'Erro interno do servidor' });
    }
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Post('webhook/painel_message')
  async webhookMessage(@Body() body: WebhookMessageDto, @Res() res: Response) {
    this.logger.warn({ route: '/webhook/painel_message' }, '[DEPRECATED] /orchestrator/webhook/painel_message chamado');

    res.setHeader('X-Deprecated', 'true');
    res.setHeader('X-Deprecated-Message', 'Use POST /api/public/messages no lugar');
    res.setHeader('Sunset', 'Sat, 30 Aug 2026 23:59:59 GMT');

    const { message, client_id, phone, request_origin } = body;

    if (!message || !client_id || !phone) {
      return res.json({ error: 'message, client_id e phone sao obrigatorios' });
    }

    try {
      const result = await this.compatibilityService.processWebhook(
        message,
        client_id,
        phone,
        request_origin,
      );
      return res.json(result);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Erro no webhook compat');
      return res.json({ error: 'Erro interno do servidor' });
    }
  }

  @Delete('session')
  async deleteSession(@Body() body: DeleteSessionDto) {
    const { client_phone, company_phone } = body;

    if (!client_phone) {
      return { error: 'client_phone é obrigatório' };
    }

    try {
      const deleted = await this.orchestratorService.deleteSession(
        client_phone,
        company_phone || client_phone,
      );
      return { deleted };
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Erro ao deletar sessão');
      return { error: 'Erro interno do servidor' };
    }
  }
}
