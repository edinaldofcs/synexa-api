import {
  PromptContentBlock,
  resolveConditionalBlocks,
} from '../../common/utils/conditional-prompt.util';

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

const STRUCTURED_SECTIONS: Array<{ key: keyof PersonaBlocks; label: string }> = [
  { key: 'identidade_persona', label: 'Identidade da Persona' },
  { key: 'diretrizes_linguagem', label: 'Diretrizes de Linguagem & Sotaque' },
  { key: 'dados_sistema', label: 'Dados do Sistema / Catálogo' },
  { key: 'ofertas_disponiveis', label: 'Ofertas Disponíveis / Condições Comerciais' },
  { key: 'fluxo_conversa', label: 'Fluxo de Conversa (Roteiro Turno a Turno)' },
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

  if (blocks && typeof blocks === 'object') {
    const parts = STRUCTURED_SECTIONS
      .map(({ key, label }) => {
        const content = blocks[key];
        const value =
          typeof content === 'string'
            ? content.trim()
            : Array.isArray(content)
              ? resolveConditionalBlocks(content, state || {}).trim()
              : '';
        return value ? `## ${label}\n${value}` : '';
      })
      .filter((p) => p.length > 0);

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

      if (state) {
        for (const [tag, field] of Object.entries(customVars)) {
          if (tag && field && state[field] !== undefined && state[field] !== null) {
            const val =
              typeof state[field] === 'object'
                ? JSON.stringify(state[field])
                : String(state[field]);
            prompt = prompt.replaceAll(tag, val);
          }
        }

        // Substituições padrão {{key}}
        for (const [key, value] of Object.entries(state)) {
          if (value !== undefined && value !== null) {
            const valStr =
              typeof value === 'object' ? JSON.stringify(value) : String(value);
            prompt = prompt.replaceAll(`{{${key}}}`, valStr);
          }
        }
      }

      return prompt;
    }
  }

  let prompt = agent.system_prompt || '';
  if (state && prompt) {
    for (const [key, value] of Object.entries(state)) {
      if (value !== undefined && value !== null) {
        const valStr =
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        prompt = prompt.replaceAll(`{{${key}}}`, valStr);
      }
    }
  }

  return prompt;
}
