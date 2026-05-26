export type PartType =
  | 'text'
  | 'image'
  | 'audio'
  | 'file'
  | 'tool_result'
  | 'rag_context'
  | 'citation';

export interface MessagePart {
  type: PartType;
  text?: string;
  media_url?: string;
  media_asset_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_result?: unknown;
  rag_chunks?: RagChunk[];
  citation?: CitationSource;
  order_index: number;
}

export interface RagChunk {
  document_id: string;
  document_name: string;
  text: string;
  score: number;
  page?: number;
}

export interface CitationSource {
  document: string;
  page?: number;
  position?: number;
  text: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export interface AgentInput {
  text?: string;
  parts?: Omit<MessagePart, 'order_index'>[];
  media_urls?: string[];
}

export interface AgentOutput {
  text: string;
  parts?: MessagePart[];
  action?: string;
  citations?: CitationSource[];
}
