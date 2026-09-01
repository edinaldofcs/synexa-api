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

/**
 * Resolve o system prompt de voz (persona blocks + interpolação de
 * variáveis) — pipeline único para telefonia e navegador.
 */
export function buildVoiceSystemPrompt(
  options: VoiceSystemPromptOptions,
): string {
  const basePrompt =
    (options.agent
      ? buildAgentPromptFromBlocks(options.agent, options.agentVariables)
      : options.fallbackPrompt) || '';

  return resolvePromptTemplateString(basePrompt, options.variables);
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

/** Teto duro do watchdog (2 horas) — protege contra valores absurdos. */
const MAX_CALL_DURATION_HARD_CAP_SEC = 7200;
/** Abaixo disso o valor é considerado inválido (chamadas < 10s são ruído). */
const MAX_CALL_DURATION_MIN_SEC = 10;

/**
 * Tempo limite da chamada em segundos
 * (`transitions.capabilities.max_call_duration_sec`). Inválido/ausente =>
 * null (sem limite). Aceita número ou string numérica; faz clamp entre
 * 10s e 7200s (2h).
 */
export function resolveMaxCallDurationSec(agent: unknown): number | null {
  const raw = readCapability(agent, 'max_call_duration_sec');
  const num = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const secs = Math.floor(num);
  if (secs < MAX_CALL_DURATION_MIN_SEC) return null;
  return Math.min(secs, MAX_CALL_DURATION_HARD_CAP_SEC);
}

/**
 * Turno de usuário enviado quando a IA fala primeiro: usa a mensagem
 * configurada no agente (com interpolação de variáveis {{chave}}) ou a
 * instrução padrão de saudação.
 */
export function buildGreetingTurn(
  agent: unknown,
  variables: Record<string, unknown> = {},
): string {
  const configured = resolveVoiceGreeting(agent);
  if (!configured) return VOICE_GREETING_TURN;
  if (!Object.keys(variables).length) return configured;
  try {
    return resolvePromptTemplateString(configured, variables);
  } catch {
    return configured;
  }
}
