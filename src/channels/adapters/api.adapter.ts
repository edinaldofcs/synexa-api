import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChannelAdapter,
  NormalizedMessage,
  OutboundMessage,
  ChannelConnectionConfig,
  DeliveryResult,
} from './channel-adapter.interface';
import { validateWebhookUrl } from '../../common/utils/ssrf-guard';

@Injectable()
export class ApiAdapter implements ChannelAdapter {
  readonly channelType = 'api';
  private readonly logger = new Logger(ApiAdapter.name);
  private readonly allowLocalInDev: boolean;

  constructor(private readonly configService: ConfigService) {
    this.allowLocalInDev =
      configService.get<string>('ENVIRONMENT', 'development') === 'development';
  }

  normalize(
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): NormalizedMessage {
    return {
      client_id: payload.client_id as string,
      company_id: (payload.company_id as string) || '',
      origin_channel: 'api',
      external_user_id: payload.external_user_id as string,
      conversation_key: (payload.conversation_key as string) || undefined,
      message: {
        type:
          ((payload.message as Record<string, unknown>)?.type as string) ||
          'text',
        text:
          ((payload.message as Record<string, unknown>)?.text as string) ||
          undefined,
        parts:
          ((payload.message as Record<string, unknown>)?.parts as any[]) ||
          undefined,
      },
      idempotency_key: (payload.idempotency_key as string) || undefined,
      metadata: (payload.metadata as Record<string, unknown>) || undefined,
    };
  }

  async send(
    connection: ChannelConnectionConfig,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    const returnUrl = message.metadata?.return_webhook_url as string;

    if (!returnUrl) {
      this.logger.warn(
        { connectionId: connection.id },
        'API channel has no return_webhook_url to deliver response',
      );
      return { success: true };
    }

    try {
      await validateWebhookUrl(returnUrl, this.allowLocalInDev);

      const response = await fetch(returnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Channel-Connection-Id': connection.id,
        },
        body: JSON.stringify({
          event: 'message.completed',
          origin_channel: 'api',
          external_user_id: message.to,
          text: message.text,
          metadata: message.metadata,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return { success: false, error: `Webhook returned ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      this.logger.error({ error, returnUrl }, 'API webhook delivery failed');
      return { success: false, error: (error as Error).message };
    }
  }

  validateSignature(
    connection: ChannelConnectionConfig,
    signature: string,
    payload: unknown,
  ): boolean {
    return true;
  }
}
