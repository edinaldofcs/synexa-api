export interface WebhookCallbackPayload {
  event: string;
  conversation_id: string;
  inbound_message_id: string;
  response_message_id?: string;
  origin_channel: string;
  external_user_id: string;
  response: {
    type: string;
    text?: string;
    parts?: Array<{ type: string; text?: string }>;
    citations?: Array<{ document: string; page?: number; text?: string }>;
  };
  status: string;
  contact?: {
    id?: string;
    name?: string;
    phone?: string;
    document_number?: string;
    email?: string;
    custom_attributes?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}
