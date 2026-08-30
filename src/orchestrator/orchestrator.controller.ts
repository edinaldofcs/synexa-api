import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Logger,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/auth/public.decorator';
import { CompatibilityService } from './compatibility.service';
import { OrchestratorService } from './orchestrator.service';
import { TestChatService } from './test-chat.service';
import { ClearTestChatDto, TestChatDto } from './dto/test-chat.dto';
import {
  ChatRequestDto,
  WebhookMessageDto,
  DeleteSessionDto,
} from './dto/chat-request.dto';
import { DevOnlyGuard } from '../common/auth/dev-only.guard';
import { ListModelsDto } from './dto/list-models.dto';

@Controller('orchestrator')
export class OrchestratorController {
  private readonly logger = new Logger(OrchestratorController.name);

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly compatibilityService: CompatibilityService,
    private readonly testChatService: TestChatService,
  ) {}

  @Post('test-chat')
  async testChat(@Body() dto: TestChatDto) {
    try {
      this.logger.log({ provider: dto.provider, model: dto.model }, 'TestChat');
      return await this.testChatService.send(dto);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'TestChat error');
      return { error: error.message };
    }
  }

  @Post('test-chat/stream')
  async testChatStream(@Body() dto: TestChatDto, @Res() res: Response) {
    if (process.env.LLM_STREAMING_ENABLED === 'false') {
      return res.status(404).json({ error: 'Streaming desabilitado' });
    }

    this.logger.log({ provider: dto.provider, model: dto.model }, 'TestChatStream');
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await this.testChatService.send(dto, (chunk) =>
        send('token', { token: chunk }),
      );
      send('done', {
        text: result.text,
        agentName: result.agentName,
        transcription: result.transcription,
        debug: result.debug,
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'TestChatStream error');
      send('error', { error: error.message });
      send('done', { error: error.message });
    } finally {
      if (!closed) {
        closed = true;
        res.end();
      }
    }
  }

  @Delete('test-chat')
  async clearTestChat(@Body() dto: ClearTestChatDto) {
    try {
      return await this.testChatService.clear(dto);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Clear test chat error');
      return { error: error.message };
    }
  }

  @Post('list-models')
  async listModels(@Body() body: ListModelsDto) {
    try {
      const models = await this.testChatService.listModels(
        body.provider,
        body.apiKey,
        body.clientId,
      );
      return { models };
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'ListModels error');
      return { error: error.message, models: [] };
    }
  }

  @Public()
  @Get('health')
  health() {
    return this.orchestratorService.health();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(DevOnlyGuard)
  @Post('chat')
  async chat(@Body() body: ChatRequestDto, @Res() res: Response) {
    this.logger.warn(
      { route: '/chat' },
      '[DEPRECATED] /orchestrator/chat chamado',
    );

    res.setHeader('X-Deprecated', 'true');
    res.setHeader(
      'X-Deprecated-Message',
      'Use POST /api/public/messages no lugar',
    );
    res.setHeader('Sunset', 'Sat, 30 Aug 2026 23:59:59 GMT');

    const {
      cellPhone,
      to,
      transcript,
      client_phone,
      company_phone,
      message: oldMessage,
    } = body;

    const finalClientPhone = cellPhone || client_phone;
    const finalCompanyPhone = to || company_phone;
    const finalMessage = transcript || oldMessage;

    if (!finalClientPhone || !finalCompanyPhone || !finalMessage) {
      return res.json({
        error:
          'cellPhone (ou client_phone), to (ou company_phone) e transcript (ou message) sao obrigatorios',
      });
    }

    try {
      const result = await this.compatibilityService.processChat(
        finalClientPhone,
        finalCompanyPhone,
        finalMessage,
      );
      return res.json(result);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Erro no /chat compat');
      return res.json({ error: 'Erro interno do servidor' });
    }
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @UseGuards(DevOnlyGuard)
  @Post('webhook/painel_message')
  async webhookMessage(@Body() body: WebhookMessageDto, @Res() res: Response) {
    this.logger.warn(
      { route: '/webhook/painel_message' },
      '[DEPRECATED] /orchestrator/webhook/painel_message chamado',
    );

    res.setHeader('X-Deprecated', 'true');
    res.setHeader(
      'X-Deprecated-Message',
      'Use POST /api/public/messages no lugar',
    );
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
