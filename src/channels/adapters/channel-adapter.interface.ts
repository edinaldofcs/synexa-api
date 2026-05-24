export interface NormalizedMessage {
  client_id: string;
  company_id: string;
  origin_channel: string;
  external_user_id: string;
  conversation_key?: string;
  message: {
    type: string;
    text?: string;
    parts?: NormalizedMessagePart[];
    attachment?: unknown;
  };
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedMessagePart {
  type: string;
  text?: string;
  url?: string;
  mime_type?: string;
  file_size?: number;
  checksum?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  to: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channelType: string;
  normalize(payload: unknown, headers?: Record<string, string>): NormalizedMessage;
  send(connection: ChannelConnectionConfig, message: OutboundMessage): Promise<DeliveryResult>;
  validateSignature(connection: ChannelConnectionConfig, signature: string, payload: unknown): boolean;
}

export interface ChannelConnectionConfig {
  id: string;
  client_id: string;
  company_id: string;
  channel_type: string;
  provider: string | null;
  provider_account_id: string | null;
  config: Record<string, unknown> | null;
  inbound_secret_hash: string | null;
}

export interface DeliveryResult {
  success: boolean;
  externalMessageId?: string;
  error?: string;
}
