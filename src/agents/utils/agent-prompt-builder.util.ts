import {
  PromptContentBlock,
  resolveConditionalBlocks,
  resolveConditionalString,
} from '../../common/utils/conditional-prompt.util';
import { resolvePromptTemplateString } from '../../common/utils/prompt-variables.util';

export interface PersonaBlocks {
  identidade_persona?: string | PromptContentBlock[];
  diretrizes_linguagem?: string | PromptContentBlock[];
  dados_sistema?: string | PromptContentBlock[];
  ofertas_disponiveis?: string | PromptContentBlock[];
  fluxo_conversa?: string | PromptContentBlock[];
  regras_output?: string | PromptContentBlock[];
  guardrails?: string | PromptContentBlock[];
  variaveis_customizadas?: Record<string, string> | string;
}

const STRUCTURED_SECTIONS: Array<{ key: keyof PersonaBlocks; label: string }> =
  [
    { key: 'identidade_persona', label: 'Identidade da Persona' },
    { key: 'diretrizes_linguagem', label: 'Diretrizes de Linguagem & Sotaque' },
    { key: 'dados_sistema', label: 'Dados do Sistema / Catálogo' },
    {
      key: 'ofertas_disponiveis',
      label: 'Ofertas Disponíveis / Condições Comerciais',
    },
    {
      key: 'fluxo_conversa',
      label: 'Fluxo de Conversa (Roteiro Turno a Turno)',
    },
    { key: 'regras_output', label: 'Regras de Output & Formatação' },
    { key: 'guardrails', label: 'Guardrails & Regras de Segurança' },
  ];

export function buildAgentPromptFromBlocks(
  agent: {
    system_prompt?: string | null;
    persona_blocks?: PersonaBlocks | Record<string, any> | null;
  },
  state?: Record<string, any>,
): string {
  const blocks = agent.persona_blocks as PersonaBlocks | null | undefined;
  const mergedState: Record<string, any> = { ...(state || {}) };

  // Normaliza aliases comuns
  if (mergedState.agent_name && !mergedState.nome_agente) {
    mergedState.nome_agente = mergedState.agent_name;
  } else if (mergedState.nome_agente && !mergedState.agent_name) {
    mergedState.agent_name = mergedState.nome_agente;
  }
  // nome_empresa = nome da empresa/tenant (company_name); NUNCA o nome da
  // pessoa que está na linha
  if (mergedState.company_name && !mergedState.nome_empresa) {
    mergedState.nome_empresa = mergedState.company_name;
  }
  if (mergedState.company_name && !mergedState.empresa) {
    mergedState.empresa = mergedState.company_name;
  }
  // nome_cliente = nome da PESSOA na linha (vem de caller_name, mapeamento
  // inbound ou set_session_variable) — não tem relação com company_name

  if (blocks && typeof blocks === 'object') {
    const parts = STRUCTURED_SECTIONS.map(({ key, label }) => {
      const content = blocks[key];
      const value =
        typeof content === 'string'
          ? resolveConditionalString(content.trim(), mergedState)
          : Array.isArray(content)
            ? resolveConditionalBlocks(content, mergedState).trim()
            : '';
      return value ? `## ${label}\n${value}` : '';
    }).filter((p) => p.length > 0);

    if (parts.length > 0) {
      let prompt = parts.join('\n\n');

      // Substituição de variáveis customizadas
      let customVars: Record<string, string> = {};
      if (blocks.variaveis_customizadas) {
        if (typeof blocks.variaveis_customizadas === 'string') {
          try {
            customVars = JSON.parse(blocks.variaveis_customizadas);
          } catch {
            customVars = {};
          }
        } else if (typeof blocks.variaveis_customizadas === 'object') {
          customVars = blocks.variaveis_customizadas as Record<string, string>;
        }
      }

      for (const [tag, field] of Object.entries(customVars)) {
        if (
          tag &&
          field &&
          mergedState[field] !== undefined &&
          mergedState[field] !== null
        ) {
          const val =
            typeof mergedState[field] === 'object'
              ? JSON.stringify(mergedState[field])
              : String(mergedState[field]);
          prompt = prompt.replaceAll(tag, val);
        }
      }

      // 1. Resolve blocos condicionais [SE ...] [SENÃO] [FIM SE]
      prompt = resolveConditionalString(prompt, mergedState);
      // 2. Substituições padrão {{key}} e dinâmicas
      prompt = resolvePromptTemplateString(prompt, mergedState);

      return prompt;
    }
  }

  let prompt = agent.system_prompt || '';
  if (prompt) {
    // 1. Resolve blocos condicionais [SE ...] [SENÃO] [FIM SE]
    prompt = resolveConditionalString(prompt, mergedState);
    // 2. Substituições padrão {{key}} e variáveis dinâmicas
    prompt = resolvePromptTemplateString(prompt, mergedState);
  }

  return prompt;
}

export function buildRawAgentPrompt(agent: {
  system_prompt?: string | null;
  persona_blocks?: PersonaBlocks | Record<string, any> | null;
  prompt?: string | null;
}): string {
  if (!agent) return '';
  const blocks = agent.persona_blocks as PersonaBlocks | null | undefined;
  if (blocks && typeof blocks === 'object') {
    const parts = STRUCTURED_SECTIONS.map(({ key, label }) => {
      const content = blocks[key];
      const value =
        typeof content === 'string'
          ? content.trim()
          : Array.isArray(content)
            ? content
                .map((c) =>
                  typeof c === 'string' ? c : (c as any)?.text || '',
                )
                .join('\n')
                .trim()
            : '';
      return value ? `## ${label}\n${value}` : '';
    }).filter((p) => p.length > 0);

    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }

  return agent.system_prompt || agent.prompt || '';
}
