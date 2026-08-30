import type {
  AgentMessage,
  AgentInput,
  AgentOutput,
} from '../types/agent-message.types';
import type { AgentCapabilities } from '../types/capabilities.types';

export interface ChatParams {
  systemPrompt: string;
  userMessage: string;
  history: { role: string; content: string }[];
  publicTools: any[];
  allToolsList: any[];
  executeExternalApiCallback: (params: {
    functionName: string;
    args: Record<string, unknown>;
    toolsList: any[];
  }) => Promise<any>;
}

export interface AgentChatParams {
  systemPrompt: string;
  input: AgentInput;
  history: AgentMessage[];
  capabilities: AgentCapabilities;
  tools: ToolDefinition[];
  agentConfig: {
    model?: string;
    temperature?: number;
    citation_policy?: string;
  };
  ragContext?: string;
  webSearchResults?: string;
  onToolCall: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type?: 'native' | 'api';
}

export interface ProviderCapabilities {
  text: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
}

export interface LLMProvider {
  chat(params: ChatParams): Promise<{
    text: string;
    action: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  }>;
  chatWithParts?(params: AgentChatParams): Promise<AgentOutput>;
  chatWithPartsStream?(
    params: AgentChatParams,
    onToken: (chunk: string) => void,
  ): Promise<AgentOutput>;
  getCapabilities?(): ProviderCapabilities;
}
