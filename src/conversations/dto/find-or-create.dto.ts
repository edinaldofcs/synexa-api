export interface FindOrCreateConversationDto {
  company_id: string;
  client_id: string;
  channel_connection_id: string;
  origin_channel: string;
  external_user_id: string;
  conversation_key?: string;
  end_user_id: string;
  metadata?: Record<string, unknown>;
}

export interface AddMessageDto {
  conversation_id: string;
  company_id: string;
  client_id?: string;
  sender_type: string;
  channel: string;
  direction: string;
  message_type?: string;
  content?: string;
  idempotency_key?: string;
  request_id?: string;
  raw_payload?: Record<string, unknown>;
  parts?: AddMessagePartDto[];
  metadata?: Record<string, unknown>;
}

export interface AddMessagePartDto {
  type: string;
  text?: string;
  url?: string;
  mime_type?: string;
  file_size?: number;
  checksum?: string;
  metadata?: Record<string, unknown>;
}

export interface HandoffRequestDto {
  assigned_to?: string;
  reason?: string;
  requested_by?: string;
}

export interface ConversationResult {
  id: string;
  company_id: string;
  client_id: string | null;
  status: string;
  mode: string | null;
  end_user_id: string | null;
  origin_channel: string | null;
  external_conversation_key: string | null;
  created_at: Date | null;
}
