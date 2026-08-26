import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket, WebSocketServer as WsServer } from 'ws';
import { VoiceService } from './voice.service';
import { VoiceAuthService } from './voice-auth.service';
import { MockVoiceProvider } from './providers/mock-voice.provider';
import { GeminiLiveVoiceProvider } from './providers/gemini-live-voice.provider';
import {
  AudioGateService,
  AudioGateSession,
} from './services/audio-gate.service';
import { HybridSttService } from './services/hybrid-stt.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';
import { buildAgentPromptFromBlocks } from '../agents/utils/agent-prompt-builder.util';
import { VoiceToolsService } from './voice-tools.service';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  type ActivationConditionGroup,
} from '../orchestrator/utils/condition-evaluator.util';
import { resolvePromptTemplateString } from '../common/utils/prompt-variables.util';
import { AnalyticsService } from '../analytics/analytics.service';
import { getSessionId } from '../common/auth/auth-cookie';
import type { AuthenticatedWebSocket } from '../common/ws/cookie-ws.adapter';

interface ClientSession {
  clientWs: WebSocket;
  liveProvider: GeminiLiveVoiceProvider | null;
  gateSession: AudioGateSession | null;
  mockSession?: {
    handleClientMessage: (msg: any) => void;
    close: () => void;
  } | null;
  isReady: boolean;
  isAiSpeaking: boolean;
  companyId?: string;
  clientId?: string;
  agentId?: string;
  conversationId?: string;
  startTime: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  interruptedCount: number;
  hybridSttUtterances: number;
  hybridSttFallbacks: number;
  aiResponseStarted: boolean;
  model: string;
  voiceName: string;
  bufferedUserPcm: Buffer[];
  bufferedUserPcmBytes: number;
  telemetryPersisted: boolean;
  state: Record<string, unknown>;
  providerGeneration: number;
  /** Acumulador do turno atual da IA para persistir a fala como mensagem única */
  aiMessageBuffer: {
    messageId: string | null;
    content: string;
    lastPersist: number;
  } | null;
}

function summarizeState(state: Record<string, unknown>): string {
  const entries = Object.entries(state || {})
    .filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'object') return false;
      if (typeof value === 'string' && value.length > 80) return false;
      return true;
    })
    .filter(
      ([key]) =>
        ![
          'inbound_variable_mapping',
          'activation_rules',
          'llm_providers',
        ].includes(key),
    );
  if (!entries.length) return 'vazio';
  return entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}

@WebSocketGateway({ path: '/ws/voice' })
export class VoiceGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(VoiceGateway.name);
  private sessions = new Map<WebSocket, ClientSession>();

  @WebSocketServer()
  server: WsServer;

  constructor(
    private readonly voiceService: VoiceService,
    private readonly voiceAuthService: VoiceAuthService,
    private readonly mockVoiceProvider: MockVoiceProvider,
    private readonly audioGateService: AudioGateService,
    private readonly hybridSttService: HybridSttService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
    private readonly voiceToolsService: VoiceToolsService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  handleConnection(clientWs: AuthenticatedWebSocket) {
    if (!this.isTrustedOrigin(clientWs)) {
      this.logger.warn(
        '[VoiceGateway] WebSocket rejeitado por origem não autorizada',
      );
      clientWs.close(1008, 'Origin not allowed');
      return;
    }

    this.logger.log('🟢 [VoiceGateway] Cliente conectado via WebSocket');
    let telemetryTimer: ReturnType<typeof setInterval> | null = null;

    /**
     * Persiste o conteúdo final acumulado do turno da IA e encerra o buffer.
     * Chunks intermediários atualizam sempre a MESMA linha (throttle 1s);
     * o flush garante que o texto completo fique gravado no fim do turno.
     */
    const flushAiMessageBuffer = async () => {
      const buffer = session.aiMessageBuffer;
      if (!buffer?.messageId || !buffer.content) return;
      try {
        await this.prisma.messages.update({
          where: { id: buffer.messageId },
          data: { content: buffer.content },
        });
      } catch (e: any) {
        this.logger.debug(`Erro ao finalizar mensagem AI: ${e.message}`);
      }
      session.aiMessageBuffer = null;
    };

    const session: ClientSession = {
      clientWs,
      liveProvider: null,
      gateSession: null,
      isReady: false,
      isAiSpeaking: false,
      startTime: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      interruptedCount: 0,
      hybridSttUtterances: 0,
      hybridSttFallbacks: 0,
      aiResponseStarted: false,
      model: 'gemini-3.1-flash-live-preview',
      voiceName: 'Aoede',
      bufferedUserPcm: [],
      bufferedUserPcmBytes: 0,
      telemetryPersisted: false,
      state: {},
      providerGeneration: 0,
      aiMessageBuffer: null,
    };
    this.sessions.set(clientWs, session);

    const sendToClient = (payload: any) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const sendDebug = (
      stage: 'session' | 'model' | 'tool' | 'api' | 'audio' | 'error',
      message: string,
      data?: unknown,
      level: 'info' | 'success' | 'warn' | 'error' = 'info',
    ) => {
      sendToClient({
        type: 'debug',
        event: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: new Date().toISOString(),
          stage,
          level,
          message,
          data,
        },
      });
    };

    const sendTelemetry = () => {
      if (!session.conversationId) return;

      const stats = session.gateSession?.getStats();
      const durationSec = Number(
        ((Date.now() - session.startTime) / 1000).toFixed(1),
      );
      const costUsd = this.pricingService.calculateVoiceLiveCost({
        durationSeconds: durationSec,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
      });

      sendToClient({
        type: 'telemetry',
        telemetry: {
          durationSec,
          forwardedSec: stats?.forwardedSec || 0,
          suppressedSec: stats?.suppressedSec || 0,
          interruptedCount: session.interruptedCount,
          totalTokens: session.totalTokens,
          audioInputTokens: session.inputTokens,
          audioOutputTokens: session.outputTokens,
          costUsd,
          costBrl: Number((costUsd * 5.5).toFixed(4)),
          voiceName: session.voiceName,
          audioGateEnabled: session.gateSession?.enabled ?? true,
        },
      });
    };

    const persistVoiceSessionAndTelemetry = async () => {
      if (session.telemetryPersisted) return;
      session.telemetryPersisted = true;

      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - session.startTime) / 1000),
      );

      if (session.companyId) {
        try {
          const rawCost = this.pricingService.calculateVoiceLiveCost({
            durationSeconds,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          });

          // 1. Fecha a conversa omnichannel
          if (session.conversationId) {
            await this.prisma.conversations.update({
              where: { id: session.conversationId },
              data: {
                status: 'closed',
                closed_at: new Date(),
              },
            });
          }

          // 2. Registra agent_runs
          if (
            session.totalTokens > 0 &&
            session.companyId &&
            session.clientId
          ) {
            await this.prisma.agent_runs.create({
              data: {
                company_id: session.companyId,
                client_id: session.clientId,
                conversation_id: session.conversationId,
                provider: 'gemini-live',
                model: session.model,
                status: 'success',
                input_tokens: session.inputTokens,
                output_tokens: session.outputTokens,
                total_tokens: session.totalTokens,
                cost: rawCost,
                latency_ms: durationSeconds * 1000,
                trace: {
                  type: 'voice_live_session',
                  duration_seconds: durationSeconds,
                  voice_name: session.voiceName,
                  interrupted_count: session.interruptedCount,
                } as any,
              },
            });
          }

          // 3. Registra voice_session_telemetry
          if (session.conversationId && session.gateSession) {
            const stats = session.gateSession.getStats();
            await this.prisma.voice_session_telemetry.create({
              data: {
                company_id: session.companyId,
                client_id: session.clientId,
                conversation_id: session.conversationId,
                duration_sec: durationSeconds,
                audio_gate_forwarded_sec: stats.forwardedSec,
                audio_gate_suppressed_sec: stats.suppressedSec,
                audio_gate_closes: stats.closes,
                interrupted_count: session.interruptedCount,
                hybrid_stt_utterances: session.hybridSttUtterances,
                hybrid_stt_fallback_count: session.hybridSttFallbacks,
                total_tokens: session.totalTokens,
                audio_input_tokens: session.inputTokens,
                audio_output_tokens: session.outputTokens,
                cost_usd: rawCost,
                cost_brl: Number((rawCost * 5.5).toFixed(4)),
                model: session.model,
                voice_name: session.voiceName,
                audio_gate_enabled: session.gateSession.enabled,
              },
            });

            this.logger.log(
              `📊 [VoiceGateway] Telemetria registrada: ${durationSeconds}s | Gate: +${stats.forwardedSec}s / -${stats.suppressedSec}s silêncio | Custo: $${rawCost}`,
            );
          }
        } catch (err: any) {
          this.logger.error(
            `Erro ao persistir telemetria de voz: ${err.message}`,
          );
        }
      }
    };

    const closeVoiceSession = async () => {
      if (telemetryTimer) {
        clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      sendTelemetry();
      if (session.liveProvider) {
        session.liveProvider.close();
        session.liveProvider = null;
        session.isReady = false;
      }
      await persistVoiceSessionAndTelemetry();
    };

    clientWs.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case 'start': {
            let authenticatedUser;
            try {
              const sessionId = clientWs.handshakeRequest
                ? getSessionId(clientWs.handshakeRequest)
                : null;
              if (sessionId) {
                authenticatedUser =
                  await this.voiceAuthService.authenticateSession(sessionId);
              } else {
                authenticatedUser =
                  await this.voiceAuthService.authenticateSession('');
              }
              session.clientId = await this.voiceAuthService.resolveClientId(
                authenticatedUser.company_id,
                typeof msg.clientId === 'string'
                  ? msg.clientId
                  : typeof msg.client_id === 'string'
                    ? msg.client_id
                    : undefined,
              );
            } catch (error: any) {
              this.logger.warn(
                `[VoiceGateway] Sessão rejeitada: ${error?.message || 'falha de autenticação'}`,
              );
              sendToClient({
                type: 'error',
                code: 'VOICE_AUTH_REQUIRED',
                message:
                  'Autenticação necessária para iniciar a sessão de voz.',
              });
              clientWs.close(1008, 'Unauthorized');
              return;
            }

            let selectedAgent: any = null;
            const requestedAgentId =
              typeof msg.agentId === 'string'
                ? msg.agentId
                : typeof msg.agent_id === 'string'
                  ? msg.agent_id
                  : undefined;

            if (requestedAgentId && session.clientId) {
              selectedAgent = await this.prisma.painel_agents.findFirst({
                where: {
                  id: requestedAgentId,
                  client_id: session.clientId,
                },
              });

              if (!selectedAgent) {
                sendToClient({
                  type: 'error',
                  code: 'VOICE_AGENT_NOT_FOUND',
                  message: 'Agente de voz não encontrado para este cliente.',
                });
                clientWs.close(1008, 'Agent not found');
                return;
              }

              if (selectedAgent.interaction_mode === 'text') {
                sendToClient({
                  type: 'error',
                  code: 'VOICE_AGENT_TEXT_ONLY',
                  message:
                    'Este agente está configurado apenas para atendimento por texto.',
                });
                clientWs.close(1008, 'Text-only agent');
                return;
              }
            }

            if (!selectedAgent && session.clientId) {
              selectedAgent = await this.prisma.painel_agents.findFirst({
                where: {
                  client_id: session.clientId,
                  is_active: true,
                  interaction_mode: { not: 'text' },
                  is_initial: true,
                },
              });
              if (!selectedAgent) {
                selectedAgent = await this.prisma.painel_agents.findFirst({
                  where: {
                    client_id: session.clientId,
                    is_active: true,
                    interaction_mode: { not: 'text' },
                  },
                  orderBy: { execution_order: 'asc' },
                });
              }
            }

            await closeVoiceSession();
            if (session.mockSession) {
              session.mockSession.close();
              session.mockSession = null;
            }

            session.startTime = Date.now();
            session.companyId = authenticatedUser.company_id;
            session.agentId = selectedAgent?.id;
            session.inputTokens = 0;
            session.outputTokens = 0;
            session.totalTokens = 0;
            session.interruptedCount = 0;
            session.bufferedUserPcm = [];
            session.bufferedUserPcmBytes = 0;
            session.telemetryPersisted = false;
            session.aiResponseStarted = false;
            session.state = session.agentId
              ? { current_agent_id: session.agentId }
              : {};
            session.providerGeneration++;

            // Busca configurações salvas do cliente
            let clientDb: any = null;
            if (session.clientId) {
              clientDb = await this.prisma.painel_clients.findUnique({
                where: { id: session.clientId },
              });
            }

            session.model =
              selectedAgent?.model ||
              msg.model ||
              this.voiceService.getDefaultModel();
            session.voiceName =
              selectedAgent?.voice_name ||
              msg.voice ||
              clientDb?.voice_name ||
              this.voiceService.getDefaultVoice();

            // Cria a conversa omnichannel no banco
            const conversation = await this.prisma.conversations.create({
              data: {
                company_id: session.companyId!,
                client_id: session.clientId,
                origin_channel: 'voice',
                status: 'active',
                metadata: {
                  voice_name: session.voiceName,
                  model: session.model,
                  agent_id: session.agentId,
                },
              },
            });
            session.conversationId = conversation.id;

            // Inicializa Audio Gate Session
            session.gateSession = this.audioGateService.createSession({
              enabled: clientDb?.audio_gate_enabled ?? true,
              threshold: clientDb?.audio_gate_threshold ?? 500,
              hangoverMarginMs: clientDb?.audio_gate_hangover_margin_ms ?? 500,
              prerollMs: clientDb?.audio_gate_preroll_ms ?? 300,
              sampleRate: 16000,
            });

            const voiceProvider = this.configService.get<string>(
              'VOICE_PROVIDER',
              'gemini',
            );
            const persistVoiceState = async () => {
              if (!session.conversationId) return;
              await this.prisma.conversation_state.upsert({
                where: { conversation_id: session.conversationId },
                update: {
                  state: session.state as any,
                  version: { increment: 1 },
                },
                create: {
                  conversation_id: session.conversationId,
                  state: session.state as any,
                },
              });
            };

            const findVoiceAgents = async () =>
              this.prisma.painel_agents.findMany({
                where: {
                  client_id: session.clientId!,
                  is_active: true,
                  interaction_mode: { not: 'text' },
                },
                select: {
                  id: true,
                  service_step: true,
                  model: true,
                  voice_name: true,
                  system_prompt: true,
                  persona_blocks: true,
                  transitions: true,
                  activation_conditions: true,
                  activation_mode: true,
                },
                orderBy: { execution_order: 'asc' },
              });

            const findActivationAgent = async (immediateOnly: boolean) => {
              if (!session.clientId) return null;
              const agents = await findVoiceAgents();
              let matchedAgent: any = null;
              for (const agent of agents) {
                if (agent.id === session.agentId) continue;
                if (immediateOnly && agent.activation_mode !== 'immediate') {
                  continue;
                }
                const conditions =
                  agent.activation_conditions as ActivationConditionGroup | null;
                if (!conditions) continue;
                const evaluation = evaluateConditionsWithDetails(
                  conditions,
                  session.state,
                );
                if (evaluation.matched) {
                  matchedAgent = agent;
                  break;
                }
                const detailMessage = `Condição de ativação não atendida para "${agent.service_step}": ${describeEvaluation(evaluation)}`;
                this.logger.debug(detailMessage);
                sendDebug(
                  'session',
                  detailMessage,
                  { agentId: agent.id },
                  'warn',
                );
              }
              return matchedAgent;
            };

            let connectAgent: (
              agent: any,
              handoffText?: string,
            ) => Promise<void>;
            let switchAgent: (
              agent: any,
              reason: string,
              handoffText?: string,
            ) => Promise<void>;

            const handleUserTranscript = async (
              text: string,
              generation: number,
            ) => {
              if (generation !== session.providerGeneration) return;
              session.state = {
                ...session.state,
                user_transcript: text,
                mensagem_usuario: text,
                user_message: text,
                last_message: text,
                message: text,
                text,
                texto: text,
              };
              await persistVoiceState();
            };

            const handleToolCalls = async (
              functionCalls: any[],
              generation: number,
              responseProvider: GeminiLiveVoiceProvider,
            ) => {
              if (
                generation !== session.providerGeneration ||
                !session.clientId ||
                !session.agentId
              ) {
                return;
              }

              const responses: Array<{
                id: string;
                name: string;
                response: any;
              }> = [];
              let requestedAgent: any = null;
              let switchReason = '';
              // Configs das APIs do agente (para aplicar save_to_session)
              let apiToolRecords: Awaited<
                ReturnType<typeof this.voiceToolsService.getAgentTools>
              > = [];
              if (
                functionCalls.some(
                  (call: any) => !call?.name?.startsWith('subagent_'),
                )
              ) {
                try {
                  apiToolRecords = await this.voiceToolsService.getAgentTools(
                    session.clientId,
                    session.agentId,
                  );
                } catch {
                  apiToolRecords = [];
                }
              }
              for (const call of functionCalls) {
                const startedAt = Date.now();
                const args = call.args || {};
                sendDebug('tool', `IA solicitou a tool ${call.name}.`, {
                  name: call.name,
                  arguments: args,
                });

                if (call.name === 'set_call_variable') {
                  const varName =
                    typeof args.name === 'string' ? args.name.trim() : '';
                  const varVal = args.value;
                  if (
                    varName &&
                    varVal !== undefined &&
                    varVal !== null &&
                    varVal !== ''
                  ) {
                    session.state = { ...session.state, [varName]: varVal };
                    await persistVoiceState();
                    sendDebug(
                      'session',
                      `💾 Variável "${varName}" salva na sessão pelo assistente.`,
                      { state: summarizeState(session.state) },
                    );
                    responses.push({
                      id: call.id,
                      name: call.name,
                      response: { ok: true, saved: { [varName]: varVal } },
                    });
                  } else {
                    responses.push({
                      id: call.id,
                      name: call.name,
                      response: {
                        ok: false,
                        error: 'Informe "name" e "value".',
                      },
                    });
                  }
                  continue;
                }

                const isSubagent = call.name.startsWith('subagent_');
                const response = isSubagent
                  ? await this.voiceToolsService.executeSubagent(
                      session.clientId,
                      session.agentId,
                      call.name,
                      args,
                    )
                  : await this.voiceToolsService.execute(
                      session.clientId,
                      session.agentId,
                      call.name,
                      args,
                      session.state,
                    );

                // Transição pós-API: avalia condições de ativação sobre o
                // estado enriquecido com o retorno da API/subagente
                if (
                  response &&
                  typeof response === 'object' &&
                  (response as Record<string, unknown>).ok !== false
                ) {
                  const apiResponse = response as Record<string, any>;
                  const returnedState =
                    apiResponse?.data && typeof apiResponse.data === 'object'
                      ? apiResponse.data
                      : Object.fromEntries(
                          Object.entries(apiResponse).filter(
                            ([key]) =>
                              !['ok', 'status', 'message', 'error'].includes(
                                key,
                              ),
                          ),
                        );
                  // Campos marcados como "Salvar valor enviado na sessão"
                  const sessionSaves = collectSessionSavesBound(
                    apiToolRecords,
                    call.name,
                    args,
                  );
                  const hasReturnedState =
                    Object.keys(returnedState).length > 0;
                  const hasSessionSaves = Object.keys(sessionSaves).length > 0;
                  if (hasReturnedState || hasSessionSaves) {
                    session.state = {
                      ...session.state,
                      ...(hasReturnedState
                        ? { retorno_api: returnedState, ...returnedState }
                        : {}),
                      ...sessionSaves,
                    };
                    await persistVoiceState();
                    sendDebug(
                      'session',
                      `📊 Variáveis do estado: ${summarizeState(session.state)}`,
                      { state: session.state },
                      'info',
                    );
                    // Na voz a troca é SEMPRE imediata após a validação da API
                    // (o activation_mode se aplica apenas ao texto)
                    const conditionAgent = await findActivationAgent(false);
                    if (conditionAgent) {
                      requestedAgent = conditionAgent;
                      switchReason =
                        'Condição de ativação atendida pelo retorno da API';
                    }
                  }
                }

                sendDebug(
                  isSubagent ? 'tool' : 'api',
                  isSubagent
                    ? `Retorno recebido do subagente ${call.name}.`
                    : `Retorno recebido da API ${call.name}.`,
                  {
                    name: call.name,
                    durationMs: Date.now() - startedAt,
                    response,
                  },
                  response?.ok === false ? 'warn' : 'success',
                );
                responses.push({ id: call.id, name: call.name, response });
              }

              responseProvider.sendToolResponse(responses);

              // Analytics: avaliação dos marcadores de negócio pós-tool
              if (session.clientId && session.companyId) {
                const toolNames = functionCalls
                  .filter((call: any) => !call?.name?.startsWith('subagent_'))
                  .map((call: any) => call.name);
                await this.analyticsService.evaluateAndRecord({
                  clientId: session.clientId,
                  companyId: session.companyId,
                  conversationId: session.conversationId || undefined,
                  originChannel: 'voice',
                  toolNames,
                  state: session.state,
                });
              }

              if (requestedAgent) {
                await switchAgent(
                  requestedAgent,
                  switchReason,
                  session.state.user_transcript as string | undefined,
                );
              }
            };

            const collectSessionSavesBound = (
              tools: Awaited<
                ReturnType<typeof this.voiceToolsService.getAgentTools>
              >,
              functionName: string,
              args: Record<string, unknown>,
            ): Record<string, unknown> => {
              const tool = tools.find((t) => t.name === functionName);
              if (!tool) return {};
              const saves: Record<string, unknown> = {};
              const configs: Record<string, any> = {
                ...(typeof tool.body === 'object' && tool.body !== null
                  ? (tool.body as Record<string, any>)
                  : {}),
                ...(typeof tool.parameters === 'object' &&
                tool.parameters !== null
                  ? (tool.parameters as Record<string, any>)
                  : {}),
              };
              for (const [key, cfg] of Object.entries(configs)) {
                const fieldCfg =
                  cfg && typeof cfg === 'object'
                    ? (cfg as Record<string, any>)
                    : {};
                const shouldSave =
                  fieldCfg.save_to_session === true ||
                  fieldCfg.save_to_session === 'true';
                if (!shouldSave) continue;
                const sessionVarName =
                  typeof fieldCfg.session_variable === 'string' &&
                  fieldCfg.session_variable.trim()
                    ? fieldCfg.session_variable.trim()
                    : key.replace(/\./g, '_');
                let val = args[key];
                if (val === undefined && key.includes('.')) {
                  val = args[key.split('.').pop()!];
                }
                if (val !== undefined) {
                  saves[sessionVarName] = val;
                }
              }
              return saves;
            };

            connectAgent = async (agent: any, handoffText?: string) => {
              const generation = ++session.providerGeneration;
              const voiceTools =
                agent && session.clientId
                  ? await this.voiceToolsService.getAgentTools(
                      session.clientId,
                      agent.id,
                    )
                  : [];
              const voiceSubagents =
                agent && session.clientId
                  ? await this.voiceToolsService.getAgentSubagents(
                      session.clientId,
                      agent.id,
                    )
                  : [];
              const voiceToolDeclarations = [
                ...voiceTools,
                ...voiceSubagents,
              ].map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              }));

              // Tool nativa: permite ao assistente salvar dados capturados na
              // conversa (ex: CPF falado pelo cliente) no estado da sessão
              voiceToolDeclarations.push({
                name: 'set_call_variable',
                description:
                  'Salva uma variável no estado da sessão do atendimento. ' +
                  'Use SEMPRE que o cliente informar um dado importante (ex: cpf, codigo_plano, forma_pagamento, status_atendimento) ' +
                  'para que ele fique disponível para as próximas etapas e integrações.',
                parameters: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description:
                        'Nome da variável (ex: cpf, codigo_plano, status_atendimento)',
                    },
                    value: {
                      type: 'string',
                      description: 'Valor a ser salvo (sempre como string)',
                    },
                  },
                  required: ['name', 'value'],
                },
              });

              const agentName = agent
                ? String(agent.service_step || agent.id)
                : null;

              // Informa ao painel qual agente está ativo e com quais
              // ferramentas ele entrou na ligação
              sendToClient({
                type: 'agent_info',
                agentId: session.agentId || null,
                agentName,
                model: session.model,
                voiceName: session.voiceName,
                tools: voiceToolDeclarations.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                })),
              });

              sendDebug(
                'session',
                agentName
                  ? `Agente "${agentName}" carregado com ${voiceToolDeclarations.length} ferramenta(s).`
                  : 'Sessão de voz iniciada sem agente persistido.',
                {
                  agentId: session.agentId,
                  agentName,
                  clientId: session.clientId,
                  model: session.model,
                  voice: session.voiceName,
                  tools: voiceToolDeclarations.map((tool) => tool.name),
                },
                'success',
              );
              if (agent && voiceToolDeclarations.length === 0) {
                sendDebug(
                  'tool',
                  `Atenção: o agente "${agentName}" não possui nenhuma API ou subagente autorizado.`,
                  { allowed_tool_names: agent.allowed_tool_names ?? [] },
                  'warn',
                );
              }

              if (voiceProvider === 'mock') {
                this.logger.log(
                  '🤖 [VoiceGateway] Iniciando Voice Provider em Modo MOCK',
                );
                session.mockSession = this.mockVoiceProvider.createSession({
                  onAudio: (data) => {
                    if (generation === session.providerGeneration) {
                      sendToClient({ type: 'audio', data });
                    }
                  },
                  onUserTranscript: (text) => {
                    if (generation !== session.providerGeneration) return;
                    sendToClient({ type: 'user_transcript', text });
                    void handleUserTranscript(text, generation);
                  },
                  onAiTranscript: (text) => {
                    if (generation === session.providerGeneration) {
                      sendToClient({ type: 'ai_transcript', text });
                    }
                  },
                  onTurnComplete: () => {
                    if (generation === session.providerGeneration) {
                      sendToClient({ type: 'turn_complete' });
                    }
                  },
                  onError: (err) => {
                    if (generation === session.providerGeneration) {
                      sendToClient({ type: 'error', message: err.message });
                    }
                  },
                });
                sendToClient({ type: 'ready' });
                return;
              }

              const apiKey =
                this.configService.get<string>('GEMINI_API_KEY') ||
                process.env.GEMINI_API_KEY ||
                '';
              if (!apiKey) {
                sendToClient({
                  type: 'error',
                  message: 'GEMINI_API_KEY não configurada no backend',
                });
                return;
              }

              const provider = new GeminiLiveVoiceProvider();
              session.liveProvider = provider;

              // Resolve variáveis [[chave]] do prompt com o estado da sessão
              // (incluindo retornos de APIs) + dados do cliente
              const basePrompt =
                (agent
                  ? buildAgentPromptFromBlocks(agent)
                  : msg.systemPrompt || msg.prompt) ||
                'Você é um assistente de voz inteligente e natural do Synexa. Responda com clareza e empatia.';
              const systemPrompt = resolvePromptTemplateString(basePrompt, {
                nome_agente: clientDb?.agent_name || '',
                ...session.state,
              });

              provider.connect({
                apiKey,
                model: session.model,
                voiceName: session.voiceName,
                systemPrompt,
                contextCompressionEnabled:
                  clientDb?.context_compression_enabled ?? false,
                contextCompressionTargetTokens:
                  clientDb?.context_compression_target_tokens ?? 8000,
                tools: voiceToolDeclarations.length
                  ? [{ functionDeclarations: voiceToolDeclarations }]
                  : undefined,
                onSetupComplete: () => {
                  if (generation !== session.providerGeneration) return;
                  session.isReady = true;
                  sendDebug(
                    'model',
                    'Gemini Live conectado e pronto para receber áudio.',
                    { model: session.model, voice: session.voiceName },
                    'success',
                  );
                  sendToClient({ type: 'ready' });
                  if (handoffText) {
                    setTimeout(() => {
                      if (generation === session.providerGeneration) {
                        provider.sendText(
                          `[CONTEXTO DA TRANSFERÊNCIA]\nO usuário disse: ${handoffText}`,
                        );
                      }
                    }, 0);
                  }
                },
                onAudio: (base64Audio) => {
                  if (generation !== session.providerGeneration) return;
                  session.isAiSpeaking = true;
                  session.gateSession?.notifyAiSpeakingChanged(true);
                  sendToClient({ type: 'audio', data: base64Audio });
                },
                onAiTranscript: async (text) => {
                  if (generation !== session.providerGeneration) return;
                  if (!session.aiResponseStarted) {
                    session.aiResponseStarted = true;
                    sendDebug(
                      'model',
                      'Resposta da IA iniciada.',
                      undefined,
                      'success',
                    );
                    // Novo turno da IA: abre um buffer zerado
                    session.aiMessageBuffer = {
                      messageId: null,
                      content: '',
                      lastPersist: 0,
                    };
                  }
                  sendToClient({ type: 'ai_transcript', text });
                  if (session.conversationId && session.companyId && text) {
                    try {
                      const buffer = session.aiMessageBuffer;
                      if (buffer) {
                        // Eventos podem ser deltas ("Vamos", "conversar") ou
                        // cumulativos; o startsWith detecta o caso cumulativo.
                        if (buffer.content && text.startsWith(buffer.content)) {
                          buffer.content = text;
                        } else {
                          buffer.content = buffer.content
                            ? `${buffer.content} ${text}`
                            : text;
                        }

                        const now = Date.now();
                        if (!buffer.messageId) {
                          const created = await this.prisma.messages.create({
                            data: {
                              company_id: session.companyId,
                              conversation_id: session.conversationId!,
                              sender_type: 'ai',
                              channel: 'voice',
                              direction: 'outbound',
                              content: buffer.content,
                            },
                          });
                          buffer.messageId = created.id;
                          buffer.lastPersist = now;
                        } else if (now - buffer.lastPersist > 1000) {
                          await this.prisma.messages.update({
                            where: { id: buffer.messageId },
                            data: { content: buffer.content },
                          });
                          buffer.lastPersist = now;
                        }
                      }
                    } catch (e: any) {
                      this.logger.debug(
                        `Erro ao salvar mensagem AI: ${e.message}`,
                      );
                    }
                  }
                },
                onUserTranscript: async (text) => {
                  if (generation !== session.providerGeneration) return;
                  sendDebug('audio', 'Fala do usuário transcrita.', { text });
                  sendToClient({ type: 'user_transcript', text });
                  if (session.conversationId && session.companyId && text) {
                    try {
                      await this.prisma.messages.create({
                        data: {
                          company_id: session.companyId,
                          conversation_id: session.conversationId,
                          sender_type: 'customer',
                          channel: 'voice',
                          direction: 'inbound',
                          content: text,
                        },
                      });
                    } catch (e: any) {
                      this.logger.debug(
                        `Erro ao salvar mensagem User: ${e.message}`,
                      );
                    }
                  }
                  await handleUserTranscript(text, generation);
                },
                onInterrupted: async () => {
                  if (generation !== session.providerGeneration) return;
                  session.isAiSpeaking = false;
                  session.interruptedCount++;
                  session.aiResponseStarted = false;
                  // Preserva o trecho falado antes da interrupção
                  await flushAiMessageBuffer();
                  session.gateSession?.notifyAiSpeakingChanged(false);
                  sendDebug(
                    'audio',
                    'Resposta da IA interrompida pelo usuário.',
                  );
                  sendToClient({ type: 'interrupted' });
                },
                onTurnComplete: async () => {
                  if (generation !== session.providerGeneration) return;
                  session.isAiSpeaking = false;
                  session.aiResponseStarted = false;
                  await flushAiMessageBuffer();
                  session.gateSession?.notifyAiSpeakingChanged(false);
                  sendDebug(
                    'model',
                    'Turno da IA concluído.',
                    undefined,
                    'success',
                  );
                  sendToClient({ type: 'turn_complete' });
                },
                onToolCall: async (functionCalls) => {
                  await handleToolCalls(functionCalls, generation, provider);
                },
                onUsageMetadata: (meta) => {
                  if (generation !== session.providerGeneration) return;
                  session.totalTokens = meta.totalTokenCount || 0;
                  session.inputTokens = meta.promptTokenCount || 0;
                  session.outputTokens = meta.candidatesTokenCount || 0;
                  sendDebug('model', 'Uso de tokens atualizado.', {
                    promptTokenCount: session.inputTokens,
                    candidatesTokenCount: session.outputTokens,
                    totalTokenCount: session.totalTokens,
                  });
                  sendToClient({ type: 'usage', metadata: meta });
                  sendTelemetry();
                },
                onError: (err) => {
                  if (generation !== session.providerGeneration) return;
                  sendDebug('error', err.message, undefined, 'error');
                  sendToClient({ type: 'error', message: err.message });
                },
                onClose: () => {
                  if (generation !== session.providerGeneration) return;
                  sendDebug('session', 'Conexão com o Gemini Live encerrada.');
                  sendToClient({ type: 'closed' });
                },
              });
            };

            switchAgent = async (targetAgent, reason, handoffText) => {
              if (!targetAgent || targetAgent.id === session.agentId) return;
              const previousProvider = session.liveProvider;
              session.providerGeneration++;
              session.isReady = false;
              previousProvider?.close();
              session.liveProvider = null;
              if (session.mockSession) {
                session.mockSession.close();
                session.mockSession = null;
              }
              session.agentId = targetAgent.id;
              session.model =
                targetAgent.model || this.voiceService.getDefaultModel();
              session.voiceName =
                targetAgent.voice_name || this.voiceService.getDefaultVoice();
              session.state = {
                ...session.state,
                current_agent_id: targetAgent.id,
                switch_reason: reason,
              };
              await persistVoiceState();
              if (session.conversationId) {
                const conversation = await this.prisma.conversations.findUnique(
                  {
                    where: { id: session.conversationId },
                    select: { metadata: true },
                  },
                );
                await this.prisma.conversations.update({
                  where: { id: session.conversationId },
                  data: {
                    metadata: {
                      ...((conversation?.metadata as Record<string, unknown>) ||
                        {}),
                      agent_id: targetAgent.id,
                      model: session.model,
                      voice_name: session.voiceName,
                    } as any,
                  },
                });
              }
              await connectAgent(targetAgent, handoffText);
              sendDebug(
                'session',
                `🔄 Condição de Ativação Atendida: Troca de agente para "${targetAgent.service_step || targetAgent.id}"`,
                { conditions: targetAgent.activation_conditions },
                'success',
              );
              sendToClient({
                type: 'agent_switched',
                agentId: targetAgent.id,
                agentName: targetAgent.service_step || targetAgent.id,
              });
            };

            await connectAgent(selectedAgent);
            sendTelemetry();
            telemetryTimer = setInterval(sendTelemetry, 1000);
            break;
          }

          case 'audio': {
            if (session.mockSession) {
              session.mockSession.handleClientMessage(msg);
              return;
            }

            if (session.liveProvider && msg.data) {
              if (session.gateSession) {
                const { forwardChunks, shouldSendStreamEnd } =
                  session.gateSession.processChunk(
                    msg.data,
                    session.isAiSpeaking,
                  );

                for (const chunk of forwardChunks) {
                  session.liveProvider.sendAudio(chunk);
                }
                if (shouldSendStreamEnd) {
                  session.liveProvider.sendAudioStreamEnd();
                }
              } else {
                session.liveProvider.sendAudio(msg.data);
              }
            }
            break;
          }

          case 'text': {
            if (session.mockSession) {
              session.mockSession.handleClientMessage(msg);
              return;
            }
            if (session.liveProvider && msg.text) {
              session.liveProvider.sendText(msg.text);
            }
            break;
          }

          case 'stop': {
            if (session.mockSession) {
              session.mockSession.close();
              session.mockSession = null;
            }
            await closeVoiceSession();
            sendToClient({ type: 'stopped' });
            break;
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Erro no processamento de mensagem de voz: ${err.message}`,
        );
      }
    });

    clientWs.on('close', async () => {
      this.logger.log('🔴 [VoiceGateway] Cliente desconectado');
      if (session.mockSession) {
        session.mockSession.close();
        session.mockSession = null;
      }
      await flushAiMessageBuffer();
      await closeVoiceSession();
      this.sessions.delete(clientWs);
    });
  }

  handleDisconnect(clientWs: WebSocket) {
    const session = this.sessions.get(clientWs);
    if (session) {
      session.liveProvider?.close();
      this.sessions.delete(clientWs);
    }
  }

  private isTrustedOrigin(clientWs: AuthenticatedWebSocket) {
    const origin = clientWs.handshakeRequest?.headers.origin;
    if (!origin) return true;

    const environment = this.configService.get<string>(
      'ENVIRONMENT',
      'development',
    );
    if (environment === 'development' || environment === 'test') return true;

    const allowedOrigins = (this.configService.get<string>('CORS_ORIGIN') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return typeof origin === 'string' && allowedOrigins.includes(origin);
  }
}
