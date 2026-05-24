export interface AgentCapabilities {
  text: boolean;
  vision: boolean;
  audio_in: boolean;
  audio_out: boolean;
  rag: boolean;
  web_search: boolean;
  tools: boolean;
}

export const DEFAULT_CAPABILITIES: AgentCapabilities = {
  text: true,
  vision: false,
  audio_in: false,
  audio_out: false,
  rag: false,
  web_search: false,
  tools: true,
};

export interface CitationPolicy {
  policy: 'required' | 'optional' | 'disabled';
}

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  capabilities: AgentCapabilities;
  citation_policy: CitationPolicy;
  allowed_knowledge_base_ids: string[];
  allowed_tool_names: string[];
  web_search_allowed: boolean;
  web_search_domains_allowed: string[];
  web_search_domains_blocked: string[];
  temperature?: number;
}
