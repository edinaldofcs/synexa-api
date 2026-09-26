import { buildAgentPromptFromBlocks } from '../../agents/utils/agent-prompt-builder.util';
import { resolvePromptTemplateString } from '../../common/utils/prompt-variables.util';
import type { VoiceGateRuntimeConfig } from '../sessions/voice-call-session';

/**
 * Configuração do Audio Gate derivada do cadastro do cliente — fonte única
 * usada pela telefonia (VoiceSessionFactory) e pelo navegador (VoiceGateway),
 * eliminando os defaults duplicados dos dois pipelines.
 */
export function resolveAudioGateConfig(
  client: any,
): Required<
  Pick<
    VoiceGateRuntimeConfig,
    'enabled' | 'threshold' | 'hangoverMarginMs' | 'prerollMs'
  >
> {
  return {
    enabled: client?.audio_gate_enabled ?? true,
    threshold: client?.audio_gate_threshold ?? 500,
    hangoverMarginMs: client?.audio_gate_hangover_margin_ms ?? 500,
    prerollMs: client?.audio_gate_preroll_ms ?? 300,
  };
}

export interface VoiceSystemPromptOptions {
  /** Agente persistido (usa persona_blocks quando existir). */
  agent?: any;
  /**
   * Variáveis passadas ao buildAgentPromptFromBlocks (telefonia injeta as
   * variáveis mapeadas da chamada; o navegador mantém o comportamento
   * original de não interpolá-las nesta etapa).
   */
  agentVariables?: Record<string, unknown>;
  /** Prompt cru quando não há agente (ex.: msg.prompt do painel). */
  fallbackPrompt?: string;
  /** Variáveis finais de interpolação {{chave}} do prompt. */
  variables: Record<string, unknown>;
}

export const VOICE_HANGUP_PROMPT_INSTRUCTION =
  '\n\n[DIRETRIZ OBRIGATÓRIA DE ENCERRAMENTO DE CHAMADA]\n' +
  'Ao concluir o atendimento ou se o cliente quiser encerrar a ligação, NUNCA desligue em silêncio ou abruptamente. ' +
  'Você DEVE SEMPRE se despedir com gentileza, simpatia e educação (ex: "Muito obrigado pelo contato, tenha um excelente dia e até logo!"). ' +
  'Ao acionar a ferramenta finalizar_chamada, passe no parâmetro "mensagem_despedida" a sua frase final de despedida ao cliente. ' +
  'Mantenha a despedida no mesmo idioma do atendimento; se nenhum idioma foi definido, use português brasileiro. ' +
  'A resposta da ferramenta é uma confirmação interna, nunca uma fala para o cliente. ' +
  'Após receber essa resposta, conclua somente a despedida que ainda não foi dita, sem repetir a despedida já falada, ' +
  'sem anunciar o desligamento e sem mudar de idioma.';

/**
 * Resolve o system prompt de voz (persona blocks + interpolação de
 * variáveis) — pipeline único para telefonia e navegador.
 */
export function buildVoiceSystemPrompt(
  options: VoiceSystemPromptOptions,
): string {
  const agentVars = options.agentVariables || options.variables;
  const basePrompt =
    (options.agent
      ? buildAgentPromptFromBlocks(options.agent, agentVars)
      : options.fallbackPrompt) || '';

  const resolved = resolvePromptTemplateString(basePrompt, options.variables);
  return `${resolved}${VOICE_HANGUP_PROMPT_INSTRUCTION}`;
}

export interface MergeApiReturnOptions {
  returnedState: Record<string, unknown>;
  sessionSaves?: Record<string, unknown>;
  /** Mantém o bloco retorno_api.* (compat com condições legadas). */
  keepRetornoApi?: boolean;
}

/**
 * Paridade com o canal de texto (api-tool-executor mergeToolResults):
 * as chaves extraídas do extract_data da API ficam TAMBÉM na raiz do
 * estado — e não apenas dentro de retorno_api.* — porque as condições de
 * ativação referenciam as variáveis na raiz (ex.: `valor_original exists`).
 */
export function mergeApiReturnIntoState(
  state: Record<string, unknown>,
  options: MergeApiReturnOptions,
): Record<string, unknown> {
  const { returnedState, sessionSaves = {}, keepRetornoApi = true } = options;
  const hasReturnedState = Object.keys(returnedState).length > 0;
  return {
    ...state,
    ...(hasReturnedState && keepRetornoApi
      ? { retorno_api: returnedState }
      : {}),
    ...(hasReturnedState ? returnedState : {}),
    ...sessionSaves,
  };
}

/**
 * Instrução enviada como turno de usuário imediatamente após o setup do
 * Gemini Live para que a IA cumprimente o cliente ANTES de ouvir qualquer
 * áudio (a IA fala primeiro). Texto único usado pelos canais web e
 * telefonia; a persona do agente define o tom da saudação.
 */
export const VOICE_GREETING_TURN =
  '[EVENTO DO SISTEMA] A chamada acabou de ser conectada e o cliente ainda não disse nada. ' +
  'Faça a saudação inicial agora: cumprimente o cliente de forma breve e natural ' +
  'conforme a sua persona e pergunte como pode ajudar. Não invente dados do cliente.';

/**
 * `transitions.capabilities.ai_speaks_first` — default LIGADO (a IA fala
 * primeiro); desligue no AgentForm para que a IA só fale após o cliente.
 */
export function aiSpeaksFirstEnabled(agent: unknown): boolean {
  const transitions = (agent as any)?.transitions;
  const capabilities =
    transitions && typeof transitions === 'object'
      ? transitions.capabilities
      : undefined;
  return !(
    capabilities &&
    typeof capabilities === 'object' &&
    (capabilities as Record<string, unknown>).ai_speaks_first === false
  );
}

/**
 * `transitions.capabilities.voice_greeting_cache_enabled` — opcional (default falso/opt-in).
 * Ative no AgentForm para acelerar a abertura com 0ms e economia de custo no Redis.
 */
export function voiceGreetingCacheEnabled(agent: unknown): boolean {
  return readCapability(agent, 'voice_greeting_cache_enabled') === true;
}

/** Applies Flow opening overrides without mutating the agent or its other capabilities. */
export function withFlowGreeting(agent: any, behavior: unknown): any {
  if (!behavior || typeof behavior !== 'object') return agent;
  const config = behavior as Record<string, unknown>;
  const greeting =
    typeof config.greetingMessage === 'string'
      ? config.greetingMessage.trim().slice(0, 6000)
      : '';
  const rawDuration = config.maxCallDurationSec ?? config.max_call_duration_sec;
  if (
    !greeting &&
    typeof config.aiSpeaksFirst !== 'boolean' &&
    rawDuration == null
  )
    return agent;
  const capabilities = { ...(agent?.transitions?.capabilities || {}) };
  if (greeting) {
    capabilities.greeting_message = greeting;
    delete capabilities.greeting_variations;
  }
  if (typeof config.aiSpeaksFirst === 'boolean')
    capabilities.ai_speaks_first = config.aiSpeaksFirst;
  if (rawDuration != null) {
    capabilities.max_call_duration_sec = rawDuration;
  }
  return { ...agent, transitions: { ...agent?.transitions, capabilities } };
}

/**
 * Lê um valor de `transitions.capabilities` de forma defensiva (o campo
 * `transitions` é JsonB livre no banco).
 */
function readCapability(agent: unknown, key: string): unknown {
  const transitions = (agent as any)?.transitions;
  const capabilities =
    transitions && typeof transitions === 'object'
      ? transitions.capabilities
      : undefined;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return (capabilities as Record<string, unknown>)[key];
}

/**
 * Mensagem inicial configurada por agente
 * (`transitions.capabilities.greeting_message`). Vazia/ausente => null
 * (o runtime usa a instrução padrão `VOICE_GREETING_TURN`).
 */
export function resolveVoiceGreeting(agent: unknown): string | null {
  const raw = readCapability(agent, 'greeting_message');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sanitiza o nome do cliente para uso em saudações de voz, extraindo o primeiro nome
 * de forma humanizada e removendo pronomes de tratamento, títulos e ruídos.
 * Exemplo: "EDINALDO DA SILVA SANTOS" -> "Edinaldo"
 * Exemplo: "Sr. Carlos Eduardo" -> "Carlos"
 * Exemplo: "maria clara" -> "Maria Clara" (para nomes compostos populares)
 */
export function sanitizeCustomerName(rawName?: unknown): string {
  if (typeof rawName !== 'string') return '';
  let cleaned = rawName
    .replace(/^(sr|sra|sr\.|sra\.|dr|dra|dr\.|dra\.|senhor|senhora)\s+/i, '')
    .trim();

  // Remove caracteres numéricos ou especiais de identificação (ex: "Edinaldo (123)" -> "Edinaldo")
  cleaned = cleaned.replace(/[0-9#@%&*_+=[\]{}()/\\|<>;:^~]/g, ' ').trim();
  if (!cleaned) return '';

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';

  const capitalize = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  const first = capitalize(parts[0]);
  if (parts.length > 1) {
    const second = capitalize(parts[1]);
    const compoundPrefixes = ['Maria', 'Joao', 'João', 'Ana', 'Jose', 'José'];
    if (compoundPrefixes.includes(first) && second.length > 2) {
      return `${first} ${second}`;
    }
  }

  return first;
}

/**
 * Extrai todas as variações de saudações configuradas no agente.
 * Suporta array em `transitions.capabilities.greeting_variations` ou
 * múltiplas frases separadas por quebra de linha com `---` em `greeting_message`.
 */
export function resolveVoiceGreetingVariations(agent: unknown): string[] {
  const variationsRaw = readCapability(agent, 'greeting_variations');
  if (Array.isArray(variationsRaw)) {
    const list = variationsRaw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    if (list.length > 0) return list;
  }

  const single = resolveVoiceGreeting(agent);
  if (!single) return [];

  if (single.includes('\n---\n') || single.includes('\r\n---\r\n')) {
    return single
      .split(/\r?\n---\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [single];
}

/**
 * Seleciona uma das variações de saudação de forma balanceada/determinística via seed
 * ou pseudo-aleatória quando seed não for fornecido.
 */
export function selectVoiceGreetingVariation(
  agent: unknown,
  seed?: number | string,
): string | null {
  const variations = resolveVoiceGreetingVariations(agent);
  if (variations.length === 0) return null;
  if (variations.length === 1) return variations[0];

  let index = 0;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    index = Math.abs(Math.floor(seed)) % variations.length;
  } else if (typeof seed === 'string' && seed.length > 0) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    index = Math.abs(hash) % variations.length;
  } else {
    index = Math.floor(Math.random() * variations.length);
  }

  return variations[index];
}

/**
 * Gera um hash determinístico curto para o template de saudação, usado na chave Redis.
 */
export function createGreetingTemplateHash(template: string): string {
  const normalized = (template || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Teto duro do watchdog (2 horas) — protege contra valores absurdos. */
const MAX_CALL_DURATION_HARD_CAP_SEC = 7200;
/** Abaixo disso o valor é considerado inválido (chamadas < 10s são ruído). */
const MAX_CALL_DURATION_MIN_SEC = 10;

/**
 * Tempo limite da chamada em segundos. Prioriza `voiceBehavior` (Flow)
 * com fallback para `transitions.capabilities.max_call_duration_sec` do agente.
 * Inválido/ausente => null (sem limite). Aceita número ou string numérica;
 * faz clamp entre 10s e 7200s (2h).
 */
export function resolveMaxCallDurationSec(
  agent: unknown,
  behavior?: unknown,
): number | null {
  // 1. Prioriza configuração do nó de voz no Flow (behavior)
  if (behavior && typeof behavior === 'object') {
    const beh = behavior as Record<string, unknown>;
    const rawBeh = beh.maxCallDurationSec ?? beh.max_call_duration_sec;
    const numBeh = typeof rawBeh === 'string' ? Number(rawBeh) : rawBeh;
    if (typeof numBeh === 'number' && Number.isFinite(numBeh)) {
      const secs = Math.floor(numBeh);
      if (secs >= MAX_CALL_DURATION_MIN_SEC) {
        return Math.min(secs, MAX_CALL_DURATION_HARD_CAP_SEC);
      }
      return null;
    }
  }

  // 2. Fallback para capabilities do agente
  const raw = readCapability(agent, 'max_call_duration_sec');
  const num = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const secs = Math.floor(num);
  if (secs < MAX_CALL_DURATION_MIN_SEC) return null;
  return Math.min(secs, MAX_CALL_DURATION_HARD_CAP_SEC);
}

/**
 * Turno de usuário enviado quando a IA fala primeiro.
 *
 * Sem mensagem configurada: instrução padrão (persona define a saudação).
 * Com mensagem configurada: instrução de REPRODUZIR o texto exato — sem
 * isto, o turno de usuário é interpretado como fala do cliente e a IA
 * "responde" à mensagem em vez de dizê-la.
 */
export function buildGreetingTurn(
  agent: unknown,
  variables: Record<string, unknown> = {},
): string {
  const configured = resolveVoiceGreeting(agent);
  if (!configured) return VOICE_GREETING_TURN;
  let message = configured;
  if (Object.keys(variables).length) {
    try {
      message = resolvePromptTemplateString(message, variables);
    } catch {
      // interpolação falhou: usa o texto original
    }
  }
  return (
    '[EVENTO DO SISTEMA] A chamada acabou de ser conectada e o cliente ainda não disse nada. ' +
    'Diga EXATAMENTE a seguinte mensagem inicial ao cliente, com a sua voz, ' +
    'sem acrescentar, remover ou alterar nada: "' +
    message +
    '"'
  );
}

/**
 * Turno de entrada enviado quando ocorre uma transferência/troca de agente.
 * Garante que o novo agente ENTRE FALANDO IMEDIATAMENTE e não fique esperando o cliente.
 */
export function buildSwitchTurn(
  agent: unknown,
  handoffText?: string,
  variables: Record<string, unknown> = {},
): string {
  const configuredGreeting = resolveVoiceGreeting(agent);
  if (configuredGreeting) {
    let message = configuredGreeting;
    if (Object.keys(variables).length) {
      try {
        message = resolvePromptTemplateString(message, variables);
      } catch {
        // interpolação falhou: usa o texto original
      }
    }
    return (
      `[EVENTO DO SISTEMA: TRANSFERÊNCIA DE ATENDIMENTO]\n` +
      `Você acabou de assumir esta ligação agora. ` +
      `${handoffText ? `O cliente disse por último: "${handoffText}". ` : ''}` +
      `FALE IMEDIATAMENTE dizendo a seguinte mensagem inicial ao cliente, sem acrescentar ou remover nada: "${message}"`
    );
  }

  const stepName = (agent as any)?.service_step || 'novo especialista';
  return (
    `[EVENTO DO SISTEMA: TRANSFERÊNCIA DE ATENDIMENTO]\n` +
    `Você acabou de assumir a ligação neste momento na etapa "${stepName}". ` +
    `${handoffText ? `O cliente disse por último: "${handoffText}". Responda de forma ágil e dê continuidade. ` : ''}` +
    `INICIE SUA FALA IMEDIATAMENTE se apresentando ou dando andamento ao atendimento, sem aguardar o cliente falar primeiro.`
  );
}

/** Watchdog máximo de segurança para conclusão do turno da IA antes de forçar o desligamento (16s) */
export const VOICE_HANGUP_WATCHDOG_TIMEOUT_MS = 16000;

/**
 * Resposta oficial da tool `finalizar_chamada`.
 * A ferramenta retoma o modelo; explicita que o status não deve ser verbalizado
 * e limita a continuação à despedida ainda pendente, no idioma do atendimento.
 */
export function buildVoiceFarewellToolResponse(): string {
  return (
    '[CONTROLE INTERNO — NÃO LER EM VOZ ALTA] Encerramento confirmado. ' +
    'Conclua apenas a despedida que ainda não foi dita, no mesmo idioma do atendimento ' +
    '(português brasileiro se nenhum idioma foi definido). ' +
    'Se já se despediu, não diga mais nada. Não repita a despedida, não traduza, ' +
    'não leia este retorno nem anuncie que a chamada está sendo encerrada.'
  );
}
