import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WebhookCallbackPayload } from '../dto/webhook-payload.dto';
import { validateWebhookUrl } from '../../common/utils/ssrf-guard';

interface DeliveryResult {
  success: boolean;
  httpStatus?: number;
  responseBody?: string;
  error?: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly allowLocalInDev: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.allowLocalInDev =
      configService.get<string>('ENVIRONMENT', 'development') === 'development';
  }

  async deliver(
    clientId: string,
    payload: WebhookCallbackPayload,
  ): Promise<void> {
    const endpoints = await this.prisma.webhook_endpoints.findMany({
      where: {
        client_id: clientId,
        enabled: true,
        events: { array_contains: payload.event },
      },
    });

    if (endpoints.length === 0) {
      this.logger.log(
        { client_id: clientId, event: payload.event },
        'No webhook endpoints configured for event',
      );
      return;
    }

    for (const endpoint of endpoints) {
      await this.deliverToEndpoint(
        endpoint.id,
        endpoint.url,
        endpoint.secret_hash,
        endpoint.retry_policy as any,
        payload,
      );
    }
  }

  private async deliverToEndpoint(
    endpointId: string,
    url: string,
    secret: string | null,
    retryPolicy: Record<string, unknown> | null,
    payload: WebhookCallbackPayload,
  ): Promise<void> {
    const maxAttempts = (retryPolicy?.max_retries as number) || 3;

    const delivery = await this.prisma.webhook_deliveries.create({
      data: {
        webhook_endpoint_id: endpointId,
        event: payload.event,
        conversation_id: payload.conversation_id,
        inbound_message_id: payload.inbound_message_id,
        response_message_id: payload.response_message_id,
        payload: payload as any,
        attempt: 1,
        max_attempts: maxAttempts,
        status: 'pending',
      },
    });

    const result = await this.trySend(url, payload, secret);

    if (result.success) {
      await this.prisma.webhook_deliveries.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          http_status: result.httpStatus,
          response_body: result.responseBody,
          completed_at: new Date(),
        },
      });
      return;
    }

    const initialStatus = maxAttempts <= 1 ? 'dead' : 'failed';

    await this.prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: {
        status: initialStatus,
        http_status: result.httpStatus,
        error_message: result.error,
      },
    });

    if (maxAttempts > 1) {
      await this.scheduleRetry(endpointId, url, payload, 2, maxAttempts);
    }
  }

  private async scheduleRetry(
    originalEndpointId: string,
    url: string,
    payload: WebhookCallbackPayload,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    const nextRetryAt = new Date(Date.now() + delayMs);

    const retry = await this.prisma.webhook_deliveries.create({
      data: {
        webhook_endpoint_id: originalEndpointId,
        event: payload.event,
        conversation_id: payload.conversation_id,
        inbound_message_id: payload.inbound_message_id,
        response_message_id: payload.response_message_id,
        payload: payload as any,
        attempt,
        max_attempts: maxAttempts,
        status: 'pending',
        next_retry_at: nextRetryAt,
      },
    });

    this.logger.log(
      { delivery_id: retry.id, attempt, next_retry_at: nextRetryAt },
      'Webhook delivery scheduled for retry',
    );

    setTimeout(() => {
      this.processRetry(retry.id).catch((err) => {
        this.logger.error(
          { delivery_id: retry.id, error: err },
          'Retry processing failed',
        );
      });
    }, delayMs);
  }

  async processRetry(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhook_deliveries.findUnique({
      where: { id: deliveryId },
      include: { webhook_endpoints: true },
    });

    if (!delivery || delivery.status !== 'pending') return;

    if (delivery.next_retry_at && delivery.next_retry_at > new Date()) return;

    const result = await this.trySend(
      delivery.webhook_endpoints.url,
      delivery.payload as unknown as WebhookCallbackPayload,
      delivery.webhook_endpoints.secret_hash,
    );

    if (result.success) {
      await this.prisma.webhook_deliveries.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          http_status: result.httpStatus,
          response_body: result.responseBody,
          completed_at: new Date(),
        },
      });
      return;
    }

    const nextAttempt = delivery.attempt + 1;
    if (nextAttempt <= delivery.max_attempts) {
      await this.scheduleRetry(
        delivery.webhook_endpoint_id,
        delivery.webhook_endpoints.url,
        delivery.payload as unknown as WebhookCallbackPayload,
        nextAttempt,
        delivery.max_attempts,
      );
    }

    const status = nextAttempt > delivery.max_attempts ? 'dead' : 'failed';

    await this.prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: {
        status,
        http_status: result.httpStatus,
        error_message: result.error,
      },
    });
  }

  private async trySend(
    url: string,
    payload: WebhookCallbackPayload,
    secret?: string | null,
  ): Promise<DeliveryResult> {
    try {
      await validateWebhookUrl(url, this.allowLocalInDev);

      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = secret
        ? createHmac('sha256', secret)
            .update(`${timestamp}.${body}`)
            .digest('hex')
        : undefined;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Synexa-Webhook/1.0',
          'X-Synexa-Event': payload.event,
          'X-Synexa-Timestamp': timestamp,
          ...(signature ? { 'X-Synexa-Signature': `sha256=${signature}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      const responseBody = await response.text();

      return {
        success: response.ok,
        httpStatus: response.status,
        responseBody,
        error: response.ok
          ? undefined
          : `HTTP ${response.status}: ${responseBody.slice(0, 500)}`,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }
}
