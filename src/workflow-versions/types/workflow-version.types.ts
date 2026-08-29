export interface WorkflowSnapshot {
  agents: Array<{
    id: string;
    model: string | null;
    service_step: string | null;
    execution_order: number | null;
    system_prompt: string | null;
    version?: number;
    is_active: boolean;
    is_initial: boolean;
    activation_conditions: any;
    activation_mode: string | null;
    transitions: any;
    allowed_tool_names: any;
  }>;
  subagents: Array<{
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    llm_provider: string | null;
    model: string | null;
    allowed_tool_names: any;
    allowed_knowledge_base_ids: any;
    temperature: number | null;
    is_active: boolean;
  }>;
  apis: Array<{
    id: string;
    agent_id: string | null;
    name: string;
    description: string | null;
    method: string | null;
    url: string | null;
    headers: any;
    body: any;
    parameters: any;
    extract_data: any;
    visible_to_agent: boolean;
    active: boolean;
    next_tool: string | null;
    execution_order: number | null;
  }>;
  tracks: Array<{
    id: string;
    code: string;
    label: string;
    description: string;
    category?: string | null;
    icon?: string | null;
    color?: string | null;
    examples?: string[] | null;
    agent_id?: string | null;
    display_order?: number;
    is_active: boolean;
  }>;
}

export interface DiffItem<T = any> {
  item: T;
  changes?: Record<string, { from: any; to: any }>;
}

export interface WorkflowDiffResult {
  hasChanges: boolean;
  agents: {
    added: any[];
    removed: any[];
    modified: DiffItem[];
  };
  subagents: {
    added: any[];
    removed: any[];
    modified: DiffItem[];
  };
  apis: {
    added: any[];
    removed: any[];
    modified: DiffItem[];
  };
  tracks: {
    added: any[];
    removed: any[];
    modified: DiffItem[];
  };
}
