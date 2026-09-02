import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Logger,
  Res,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/auth/public.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { RedisService } from '../common/redis/redis.service';
import { CompatibilityService } from './compatibility.service';
import { OrchestratorService } from './orchestrator.service';
import { TestChatService, type TestChatUserContext } from './test-chat.service';
import { ClearTestChatDto, TestChatDto } from './dto/test-chat.dto';
import {
  ChatRequestDto,
  WebhookMessageDto,
  DeleteSessionDto,
} from './dto/chat-request.dto';
import { DevOnlyGuard } from '../common/auth/dev-only.guard';
import { ListModelsDto } from './dto/list-models.dto';
import {
  acquireSseStream,
  releaseSseStream,
  parseMaxConcurrentStreams,
  SSE_STREAM_DEADLINE_MS,
} from './utils/sse-stream-counter.util';

@Controller('orchestrator')
export class OrchestratorController {
  private readonly logger = new Logger(OrchestratorController.name);

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly compatibilityService: CompatibilityService,
    private readonly testChatService: TestChatService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * S02: extrai o contexto do token para o tenant check no service.
   * Sem user (uso interno/testes) retorna undefined e o service mantem o
   * comportamento atual.
   */
  private toUserContext(user: any): TestChatUserContext | undefined {
    if (!user) return undefined;
    const id = user.id || user.sub;
    if (!id) return undefined;
    return {
      id,
      company_id: user.company_id || null,
      role: user.role || 'operator',
    };
  }

  private maxConcurrentStreams(): number {
    return parseMaxConcurrentStreams(process.env.LLM_MAX_CONCURRENT_STREAMS);
  }

  private async tryAcquireStreamSlot(
    userCtx: TestChatUserContext | undefined,
  ): Promise<{ allowed: boolean; active: number | null }> {
    if (!userCtx) return { allowed: true, active: null };
    try {
      const active = await acquireSseStream(
        this.redisService.getClient(),
        userCtx.id,
      );
      if (active > this.maxConcurrentStreams()) {
        await releaseSseStream(this.redisService.getClient(), userCtx.id);
        return { allowed: false, active };
      }
      return { allowed: true, active };
    } catch (error: any) {
      // Redis indisponivel: fail-open (a rota tem Throttle proprio e deadline)
      this.logger.warn(
        { error: error.message },
        'TestChatStream: falha ao checar contador de streams concorrentes',
      );
      return { allowed: true, active: null };
    }
  }

  private async releaseStreamSlot(userCtx: TestChatUserContext | undefined) {
    if (!userCtx) return;
    await releaseSseStream(this.redisService.getClient(), userCtx.id);
  }

  @Post('test-chat')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async testChat(@CurrentUser() user: any, @Body() dto: TestChatDto) {
    const userCtx = this.toUserContext(user);
    try {
      this.logger.log({ provider: dto.provider, model: dto.model }, 'TestChat');
      return await this.testChatService.send(dto, undefined, userCtx);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'TestChat error');
      return { error: error.message };
    }
  }

  @Post('test-chat/stream')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async testChatStream(
    @CurrentUser() user: any,
    @Body() dto: TestChatDto,
    @Res() res: Response,
  ) {
    if (process.env.LLM_STREAMING_ENABLED === 'false') {
      return res.status(404).json({ error: 'Streaming desabilitado' });
    }

    const userCtx = this.toUserContext(user);
    const slot = await this.tryAcquireStreamSlot(userCtx);
    if (!slot.allowed) {
      this.logger.warn(
        {
          userId: userCtx?.id,
          active: slot.active,
          max: this.maxConcurrentStreams(),
        },
        'TestChatStream: cap de streams concorrentes atingido',
      );
      return res
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .json({ error: 'Too many concurrent streams' });
    }

    this.logger.log(
      { provider: dto.provider, model: dto.model },
      'TestChatStream',
    );
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    // S05: deadline de 120s - nenhum write acontece apos o limite
    const startedAt = Date.now();
    const send = (event: string, data: unknown) => {
      if (closed) return;
      if (Date.now() - startedAt > SSE_STREAM_DEADLINE_MS) {
        this.logger.warn(
          { userId: userCtx?.id },
          'TestChatStream: deadline de 120s excedido, stream abortado',
        );
        closed = true;
        try {
          res.end();
        } catch {
          // resposta ja encerrada
        }
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await this.testChatService.send(
        dto,
        (chunk) => send('token', { token: chunk }),
        userCtx,
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
      await this.releaseStreamSlot(userCtx);
    }
  }

  @Delete('test-chat')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async clearTestChat(@CurrentUser() user: any, @Body() dto: ClearTestChatDto) {
    try {
      return await this.testChatService.clear(dto, this.toUserContext(user));
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Clear test chat error');
      return { error: error.message };
    }
  }

  @Post('list-models')
  async listModels(@Body() body: ListModelsDto) {
    try {
      let apiKey = body.apiKey;
      // S43: em production a apiKey do body e ignorada (egress para validar
      // chaves roubadas); usa apenas a credencial registrada via
      // provider-key-resolver.
      if (process.env.ENVIRONMENT === 'production' && apiKey) {
        this.logger.warn(
          { provider: body.provider },
          'ListModels: apiKey no body ignorada em production',
        );
        apiKey = undefined;
      }
      const models = await this.testChatService.listModels(
        body.provider,
        apiKey,
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
