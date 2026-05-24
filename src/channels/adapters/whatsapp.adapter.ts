import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  NormalizedMessage,
  OutboundMessage,
  ChannelConnectionConfig,
  DeliveryResult,
} from './channel-adapter.interface';

@Injectable()
export class WhatsappAdapter implements ChannelAdapter {
  readonly channelType = 'whatsapp';
  private readonly logger = new Logger(WhatsappAdapter.name);

  normalize(payload: Record<string, unknown>, headers?: Record<string, string>): NormalizedMessage {
    const externalUserId = (payload.from as string) || (payload.phone as string);
    const text =
      (payload.message as string) ||
      (payload.text as string) ||
      (payload.body as string) ||
      (payload as any)?.message?.text;

    return {
      client_id: payload.client_id as string || (payload as any).clientId,
      company_id: payload.company_id as string || '',
      origin_channel: 'whatsapp',
      external_user_id: externalUserId,
      conversation_key: (payload.conversation_key as string) || undefined,
      message: {
        type: 'text',
        text,
      },
      idempotency_key: (payload.idempotency_key as string) || undefined,
      metadata: (payload.metadata as Record<string, unknown>) || undefined,
    };
  }

  async send(connection: ChannelConnectionConfig, message: OutboundMessage): Promise<DeliveryResult> {
    const provider = connection.provider || 'evolution';
    const config = (connection.config || {}) as Record<string, unknown>;

    try {
      switch (provider) {
        case 'evolution':
          return this.sendEvolution(config, message);
        case 'z-api':
          return this.sendZApi(config, message);
        default:
          return this.sendEvolution(config, message);
      }
    } catch (error) {
      this.logger.error({ error, provider, to: message.to }, 'WhatsApp send failed');
      return { success: false, error: (error as Error).message };
    }
  }

  private async sendEvolution(config: Record<string, unknown>, message: OutboundMessage): Promise<DeliveryResult> {
    const baseUrl = config.instanceUrl as string;
    const apiKey = config.apiKey as string;
    const instanceId = config.instanceId as string;

    if (!baseUrl || !apiKey) {
      return { success: false, error: 'Evolution config missing instanceUrl or apiKey' };
    }

    const url = `${baseUrl}/message/sendText/${instanceId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apiKey': apiKey,
      },
      body: JSON.stringify({
        number: message.to,
        text: message.text,
      }),
    });

    if (!response.ok) {
      return { success: false, error: `Evolution API error: ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return { success: true, externalMessageId: data.key as string };
  }

  private async sendZApi(config: Record<string, unknown>, message: OutboundMessage): Promise<DeliveryResult> {
    const clientToken = config.clientToken as string;
    const instanceId = config.instanceId as string;

    if (!clientToken || !instanceId) {
      return { success: false, error: 'Z-API config missing clientToken or instanceId' };
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${clientToken}/send-text`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: message.to, message: message.text }),
    });

    if (!response.ok) {
      return { success: false, error: `Z-API error: ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return { success: true, externalMessageId: data.zapiMessageId as string };
  }

  validateSignature(connection: ChannelConnectionConfig, signature: string, payload: unknown): boolean {
    return true;
  }
}
