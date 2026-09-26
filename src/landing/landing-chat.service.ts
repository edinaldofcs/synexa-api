import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { RedisService } from '../common/redis/redis.service';
import { LandingChatDto } from './landing-chat.dto';
import { LANDING_KNOWLEDGE } from './landing-knowledge';

@Injectable()
export class LandingChatService {
  private readonly logger = new Logger(LandingChatService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async reply(body: LandingChatDto) {
    const message = body.message.trim();
    if (!message) throw new BadRequestException('Escreva uma mensagem.');
    const key =
      this.config.get<string>('LANDING_CHAT_API_KEY') ||
      this.config.get<string>('GROQ_API_KEY');
    if (!key)
      throw new ServiceUnavailableException(
        'O assistente está temporariamente indisponível.',
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Shared budget bounds public usage even across instances/IPs. Fail closed.
      const limits = await Promise.race([
        Promise.all([
          this.redis.checkRateLimit('landing-chat:minute', 20, 60),
          this.redis.checkRateLimit('landing-chat:day', 300, 86400),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('budget_unavailable')),
            2000,
          );
        }),
      ]);
      if (limits.some((limit) => !limit.allowed))
        throw new HttpException(
          'O assistente atingiu o limite temporário de uso. Tente mais tarde.',
          429,
        );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn({ event: 'landing_chat_budget_unavailable' });
      throw new ServiceUnavailableException(
        'O assistente está temporariamente indisponível.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const client = new OpenAI({
      apiKey: key,
      baseURL: 'https://api.groq.com/openai/v1',
      timeout: 20000,
      maxRetries: 0,
    });
    try {
      const result = await client.chat.completions.create({
        model:
          this.config.get<string>('LANDING_CHAT_MODEL') ||
          this.config.get<string>('GROQ_MODEL') ||
          'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: LANDING_KNOWLEDGE },
          ...(body.history || []),
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        max_completion_tokens: 500,
      });
      const text = result.choices[0]?.message?.content?.trim();
      if (!text) throw new Error('empty_response');
      this.logger.log({
        event: 'landing_chat_replied',
        tokens: result.usage?.total_tokens,
      });
      return { text: text.slice(0, 2400) };
    } catch (error) {
      // Provider errors can contain requests/credentials: never serialize them.
      this.logger.warn({
        event: 'landing_chat_provider_failed',
        status:
          typeof (error as { status?: unknown })?.status === 'number'
            ? (error as { status: number }).status
            : null,
      });
      throw new ServiceUnavailableException(
        'Não consegui responder agora. Tente novamente em instantes.',
      );
    }
  }
}
