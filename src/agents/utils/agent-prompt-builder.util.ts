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
  regras_output_canais?: Record<string, string | PromptContentBlock[]>;
  guardrails?: string | PromptContentBlock[];
  variaveis_customizadas?: Record<string, string> | string;
}

export function normalizeChannelKey(channel?: string): string {
  if (!channel) return '';
  const c = String(channel).toLowerCase().trim();
  if (
    [
      'voice',
      'telephony',
      'fastagi',
      'callflex',
      'sip',
      'audiosocket',
      'webrtc',
      'telefone',
      'voz',
    ].includes(c)
  ) {
    return 'voice';
  }
  if (['whatsapp', 'wpp', 'evolution', 'zap'].includes(c)) return 'whatsapp';
  if (['sms'].includes(c)) return 'sms';
  if (['webchat', 'chat', 'widget', 'navegador', 'web'].includes(c)) return 'webchat';
  if (['api', 'integracao', 'webhook'].includes(c)) return 'api';
  return c;
}

export const CHANNEL_LABELS: Record<string, string> = {
  voice: 'Voz / Telefonia',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  webchat: 'WebChat',
  api: 'API / Integração',
};

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

  // Normaliza canal
  const rawChannel = (mergedState.canal ||
    mergedState.origin_channel ||
    mergedState.channel) as string | undefined;
  if (rawChannel) {
    const normalized = normalizeChannelKey(rawChannel);
    if (!mergedState.canal) mergedState.canal = normalized;
    if (!mergedState.origin_channel) mergedState.origin_channel = rawChannel;
    if (!mergedState.channel) mergedState.channel = rawChannel;
  }

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
  if (mergedState.client_name && !mergedState.nome_cliente) {
    mergedState.nome_cliente = mergedState.client_name;
  } else if (mergedState.nome_cliente && !mergedState.client_name) {
    mergedState.client_name = mergedState.nome_cliente;
  }

  // contrato
  if (mergedState.contract_id && !mergedState.contrato) {
    mergedState.contrato = mergedState.contract_id;
  } else if (mergedState.contrato && !mergedState.contract_id) {
    mergedState.contract_id = mergedState.contrato;
  }

  if (blocks && typeof blocks === 'object') {
    const parts = STRUCTURED_SECTIONS.map(({ key, label }) => {
      let value = '';

      if (key === 'regras_output') {
        const baseContent = blocks.regras_output;
        const baseValue =
          typeof baseContent === 'string'
            ? resolveConditionalString(baseContent.trim(), mergedState)
            : Array.isArray(baseContent)
              ? resolveConditionalBlocks(baseContent, mergedState).trim()
              : '';

        let channelValue = '';
        if (
          blocks.regras_output_canais &&
          typeof blocks.regras_output_canais === 'object'
        ) {
          const activeKey = normalizeChannelKey(
            (mergedState.canal as string) ||
              (mergedState.origin_channel as string) ||
              (mergedState.channel as string),
          );

          const rawChannelContent =
            (activeKey && blocks.regras_output_canais[activeKey]) ||
            (activeKey === 'api' && blocks.regras_output_canais['webchat']) ||
            (activeKey === 'webchat' && blocks.regras_output_canais['api']) ||
            (rawChannel &&
              blocks.regras_output_canais[String(rawChannel).toLowerCase()]) ||
            undefined;

          if (rawChannelContent) {
            channelValue =
              typeof rawChannelContent === 'string'
                ? resolveConditionalString(rawChannelContent.trim(), mergedState)
                : Array.isArray(rawChannelContent)
                  ? resolveConditionalBlocks(rawChannelContent, mergedState).trim()
                  : '';
          }
        }

        if (baseValue && channelValue) {
          const activeKey = normalizeChannelKey(
            (mergedState.canal as string) ||
              (mergedState.origin_channel as string) ||
              (mergedState.channel as string),
          );
          const channelLabel =
            CHANNEL_LABELS[activeKey] || activeKey || 'Canal Ativo';
          value = `${baseValue}\n\n### Diretrizes Específicas do Canal (${channelLabel})\n${channelValue}`;
        } else if (channelValue) {
          value = channelValue;
        } else {
          value = baseValue;
        }
      } else {
        const content = blocks[key];
        value =
          typeof content === 'string'
            ? resolveConditionalString(content.trim(), mergedState)
            : Array.isArray(content)
              ? resolveConditionalBlocks(content, mergedState).trim()
              : '';
      }

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
