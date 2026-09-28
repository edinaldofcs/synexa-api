import { openWebhookSecret } from './webhook-secret';
import { publicFetch } from '../../common/utils/public-http';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
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
    private readonly queueService: QueueService,
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

    const results = await Promise.allSettled(
      endpoints.map((endpoint) =>
        this.deliverToEndpoint(
          endpoint.id,
          endpoint.retry_policy as any,
          payload,
        ),
      ),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.error(
          {
            client_id: clientId,
            event: payload.event,
            endpoint_id: endpoints[index]?.id,
            error: (result.reason as Error)?.message,
          },
          'Webhook delivery rejected',
        );
      }
    }
  }

  private async deliverToEndpoint(
    endpointId: string,
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

    await this.processRetry(delivery.id);
  }

  async sweep(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.webhook_deliveries.findMany({
      where: {
        OR: [
          {
            status: 'pending',
            OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
          },
          {
            status: 'processing',
            OR: [{ lease_until: null }, { lease_until: { lt: now } }],
          },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: 50,
      select: { id: true },
    });
    for (const row of rows)
      await this.queueService.addWebhookJob({ delivery_id: row.id });
    // Terminal payloads expire only when the operator explicitly configures retention.
    const days = Number(
      this.configService.get('WEBHOOK_HISTORY_RETENTION_DAYS'),
    );
    if (Number.isFinite(days) && days >= 1) {
      await this.prisma.webhook_deliveries.updateMany({
        where: {
          status: { in: ['delivered', 'cancelled'] },
          completed_at: { lt: new Date(Date.now() - days * 86400000) },
        },
        data: { payload: {}, response_body: null, error_message: null },
      });
    }
  }

  async processRetry(deliveryId: string): Promise<void> {
    const now = new Date();
    const delivery = await this.prisma.webhook_deliveries.findUnique({
      where: { id: deliveryId },
      include: { webhook_endpoints: true },
    });
    if (!delivery || !['pending', 'processing'].includes(delivery.status))
      return;
    if (
      delivery.status === 'processing' &&
      delivery.lease_until &&
      delivery.lease_until > now
    )
      return;
    if (delivery.next_retry_at && delivery.next_retry_at > now) return;
    const token = randomUUID();
    const claimed = await this.prisma.webhook_deliveries.updateMany({
      where: {
        id: deliveryId,
        attempt: delivery.attempt,
        next_retry_at: delivery.next_retry_at,
        OR: [
          { status: 'pending' },
          {
            status: 'processing',
            OR: [{ lease_until: null }, { lease_until: { lt: now } }],
          },
        ],
      },
      data: {
        status: 'processing',
        lease_token: token,
        lease_until: new Date(Date.now() + 60000),
      },
    });
    if (!claimed.count) return;
    let result: DeliveryResult;
    try {
      result = await this.trySend(
        delivery.webhook_endpoints.url,
        delivery.payload as unknown as WebhookCallbackPayload,
        openWebhookSecret(delivery.webhook_endpoints.signing_secret_enc),
        delivery.id,
      );
    } catch {
      result = { success: false, error: 'signing_secret_unavailable' };
    }
    const retry = !result.success && delivery.attempt < delivery.max_attempts;
    const delay = Math.min(1000 * 2 ** delivery.attempt, 30000);
    const updated = await this.prisma.webhook_deliveries.updateMany({
      where: { id: delivery.id, lease_token: token },
      data: {
        status: result.success ? 'delivered' : retry ? 'pending' : 'dead',
        attempt: retry ? delivery.attempt + 1 : delivery.attempt,
        http_status: result.httpStatus,
        response_body: null,
        error_message: result.error || null,
        next_retry_at: retry ? new Date(Date.now() + delay) : null,
        completed_at: retry ? null : new Date(),
        lease_until: null,
        lease_token: null,
      },
    });
    if (updated.count && retry)
      await this.queueService.addWebhookJob(
        { delivery_id: delivery.id },
        delay,
      );
  }

  private async trySend(
    url: string,
    payload: WebhookCallbackPayload,
    secret?: string | null,
    eventId?: string,
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

      const response = await publicFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Synexa-Webhook/1.0',
          'X-Synexa-Event': payload.event,
          ...(eventId ? { 'X-Synexa-Event-Id': eventId } : {}),
          'X-Synexa-Timestamp': timestamp,
          ...(signature ? { 'X-Synexa-Signature': `sha256=${signature}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      await response.body?.cancel();

      return {
        success: response.ok,
        httpStatus: response.status,
        error: response.ok ? undefined : `http_${response.status}`,
      };
    } catch (error) {
      return {
        success: false,
        error: 'delivery_failed',
      };
    }
  }
}
