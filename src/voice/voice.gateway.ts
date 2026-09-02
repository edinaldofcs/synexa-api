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
import { AudioGateService } from './services/audio-gate.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { VoiceToolsService } from './voice-tools.service';
import {
  evaluateConditionsWithDetails,
  describeEvaluation,
  type ActivationConditionGroup,
} from '../orchestrator/utils/condition-evaluator.util';
import { AnalyticsService } from '../analytics/analytics.service';
import { NativeToolsService } from '../common/services/native-tools.service';
import { getSessionId } from '../common/auth/auth-cookie';
import type { AuthenticatedWebSocket } from '../common/ws/cookie-ws.adapter';
import {
  VoiceClientSession,
  summarizeState,
} from './sessions/voice-client-session';
import { VoiceTelemetryService } from './services/voice-telemetry.service';
import { VoiceSessionFactory } from './services/voice-session.factory';
import { WebRtcAdapter } from './adapters/webrtc/web-webrtc.adapter';
import {
  resolveAudioGateConfig,
  buildVoiceSystemPrompt,
  mergeApiReturnIntoState,
  aiSpeaksFirstEnabled,
  buildGreetingTurn,
  resolveMaxCallDurationSec,
} from './services/voice-runtime.util';

const MAX_SESSION_STATE_BYTES = 32 * 1024;
const MAX_SESSION_STATE_KEYS = 40;
// Timeout de identificacao: conexao WS sem 'start' dentro da janela e fechada
const VOICE_IDENTIFICATION_TIMEOUT_MS = 30000;

function pruneSessionState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return state;
  }
  if (!serialized || serialized.length <= MAX_SESSION_STATE_BYTES) return state;
  const entries = Object.entries(state);
  const preserved = entries.filter(
    ([key]) => key.startsWith('system') || key.startsWith('config'),
  );
  const recent = entries
    .filter(([key]) => !key.startsWith('system') && !key.startsWith('config'))
    .slice(-MAX_SESSION_STATE_KEYS);
  return Object.fromEntries([...preserved, ...recent]);
}

@WebSocketGateway({ path: '/ws/voice' })
export class VoiceGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(VoiceGateway.name);
  private sessions = new Map<WebSocket, VoiceClientSession>();

  @WebSocketServer()
  server: WsServer;

  constructor(
    private readonly voiceService: VoiceService,
    private readonly voiceAuthService: VoiceAuthService,
    private readonly mockVoiceProvider: MockVoiceProvider,
    private readonly audioGateService: AudioGateService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly voiceToolsService: VoiceToolsService,
    private readonly analyticsService: AnalyticsService,
    private readonly nativeToolsService: NativeToolsService,
    private readonly telemetryService: VoiceTelemetryService,
    private readonly redis: RedisService,
  ) {}

  handleConnection(clientWs: AuthenticatedWebSocket) {
    if (!this.isTrustedOrigin(clientWs)) {
      this.logger.warn(
        '[VoiceGateway] WebSocket rejeitado por origem não autorizada',
      );
      clientWs.close(1008, 'Origin not allowed');
      return;
    }

    this.enforcePreAuthConnectionLimit(clientWs);

    this.logger.log('🟢 [VoiceGateway] Cliente conectado via WebSocket');
    let telemetryTimer: ReturnType<typeof setInterval> | null = null;
    // Sinaliza que a sessão de voz foi encerrada; evita criar timers/providers
    // quando um 'start' assíncrono retoma depois do close
    let voiceSessionClosed = false;
    // Watchdog do tempo limite da chamada (max_call_duration_sec)
    let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
    // Turnos de entrada (handoff/saudação) e watchdog pertencem à PRIMEIRA
    // conexão de provider: transições de agente não reenviam a saudação nem
    // reiniciam o cronômetro (o limite conta o tempo total da ligação).
    let introTurnSent = false;
    let maxDurationArmed = false;

    // Conexão pre-auth sem 'start' dentro da janela é fechada (evita
    // sockets pendentes de identificação acumulando)
    let identificationTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {
        identificationTimer = null;
        if (clientWs.readyState === WebSocket.OPEN) {
          this.logger.warn(
            '[VoiceGateway] Conexão sem identificação (start) dentro do tempo limite; encerrando',
          );
          clientWs.close(1013, 'Identification timeout');
        }
      },
      this.configService.get<number>(
        'VOICE_IDENTIFICATION_TIMEOUT_MS',
        VOICE_IDENTIFICATION_TIMEOUT_MS,
      ),
    );
    const clearIdentificationTimer = () => {
      if (identificationTimer) {
        clearTimeout(identificationTimer);
        identificationTimer = null;
      }
    };

    const session = new VoiceClientSession(clientWs);
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
      const payload = this.telemetryService.buildTelemetryPayload(session);
      if (!payload) return;
      sendToClient({ type: 'telemetry', telemetry: payload });
    };

    const acquireVoiceSlot = (): boolean => {
      if (session.holdsSessionSlot) return true;
      if (!this.voiceSessionFactory.tryAcquireSession()) {
        this.logger.warn(
          '[VoiceGateway] Limite global de sessões de voz atingido; recusando nova sessão',
        );
        return false;
      }
      session.holdsSessionSlot = true;
      return true;
    };

    const releaseVoiceSlot = () => {
      if (!session.holdsSessionSlot) return;
      session.holdsSessionSlot = false;
      this.voiceSessionFactory.releaseSession();
    };

    let statePersistTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleConversationStatePersist = () => {
      if (statePersistTimer) return;
      statePersistTimer = setTimeout(() => {
        statePersistTimer = null;
        void this.telemetryService
          .persistConversationState(session)
          .catch(() => {});
      }, 3000);
    };
    const flushConversationState = async () => {
      if (statePersistTimer) {
        clearTimeout(statePersistTimer);
        statePersistTimer = null;
      }
      await this.telemetryService.persistConversationState(session);
    };

    const closeVoiceSession = async () => {
      voiceSessionClosed = true;
      if (telemetryTimer) {
        clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = null;
      }
      sendTelemetry();
      if (statePersistTimer) {
        clearTimeout(statePersistTimer);
        statePersistTimer = null;
      }
      await flushConversationState();
      if (session.liveProvider) {
        session.liveProvider.close();
        session.liveProvider = null;
        session.isReady = false;
      }
      await this.telemetryService.persistSessionTelemetry(session);
      releaseVoiceSlot();
    };

    clientWs.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case 'start': {
            clearIdentificationTimer();
            clearIdentificationTimer();
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

            const clientDbPromise: Promise<any> = session.clientId
              ? this.prisma.painel_clients
                  .findUnique({ where: { id: session.clientId } })
                  .catch(() => null)
              : Promise.resolve(null);

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

              if (!selectedAgent && !msg.systemPrompt && !msg.prompt) {
                sendToClient({
                  type: 'error',
                  code: 'VOICE_AGENT_NOT_FOUND',
                  message: 'Agente de voz não encontrado para este cliente.',
                });
                clientWs.close(1008, 'Agent not found');
                return;
              }

              if (selectedAgent && selectedAgent.interaction_mode === 'text') {
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

            session.beginSession({
              companyId: authenticatedUser.company_id,
              agentId: selectedAgent?.id,
              state: selectedAgent?.id
                ? { current_agent_id: selectedAgent.id }
                : {},
            });

            // Configurações salvas do cliente (buscadas em paralelo à seleção
            // do agente durante a abertura)
            const clientDb = await clientDbPromise;

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

            // Canal Web sob o mesmo contrato ITelephonyAdapter da telefonia:
            // o pipeline de áudio (gate → provider → retorno) é único.
            const callAdapter = new WebRtcAdapter({
              id: conversation.id,
              socket: clientWs,
              metadata: {
                channelId: conversation.id,
                customVariables: {
                  client_id: session.clientId,
                  agent_id: session.agentId,
                },
              },
            });
            session.callAdapter = callAdapter;

            // Áudio do usuário: adapter → Audio Gate → provider (como em
            // VoiceCallSession)
            callAdapter.onAudio((pcm16) => {
              if (!session.liveProvider) return;
              if (!session.gateSession) {
                session.liveProvider.sendAudio(pcm16.toString('base64'));
                return;
              }
              const result = session.gateSession.processChunk(
                pcm16.toString('base64'),
                session.isAiSpeaking,
              );
              if (result) {
                for (const chunk of result.forwardChunks) {
                  session.liveProvider.sendAudio(chunk);
                }
                if (result.shouldSendStreamEnd) {
                  session.liveProvider.sendAudioStreamEnd();
                }
              }
            });

            // Inicializa Audio Gate Session (config compartilhada com telefonia)
            session.gateSession = this.audioGateService.createSession({
              ...resolveAudioGateConfig(clientDb),
              sampleRate: 16000,
            });

            const voiceProvider = this.configService.get<string>(
              'VOICE_PROVIDER',
              'gemini',
            );

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
              session.state = pruneSessionState({
                ...session.state,
                user_transcript: text,
                mensagem_usuario: text,
                user_message: text,
                last_message: text,
                message: text,
                text,
                texto: text,
              });
              scheduleConversationStatePersist();
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

                // Encerramento da chamada solicitado pela IA (canal web):
                // responde a tool call e encerra a sessão graciosamente.
                if (call.name === 'finalizar_chamada') {
                  sendDebug(
                    'session',
                    '📞 IA encerrou a chamada (finalizar_chamada).',
                    undefined,
                    'success',
                  );
                  sendToClient({ type: 'call_ended', reason: 'ai_requested' });
                  responses.push({
                    id: call.id,
                    name: call.name,
                    response: { ok: true, message: 'Chamada encerrada.' },
                  });
                  responseProvider.sendToolResponse(responses);
                  setTimeout(() => {
                    try {
                      clientWs.close(1000, 'AI requested hangup');
                    } catch {
                      // socket já fechado
                    }
                  }, 300);
                  return;
                }

                if (
                  [
                    'validate_variable_part',
                    'validate_variable',
                    'set_session_variable',
                    'set_call_variable',
                    'set_variable',
                    'calculate_financial',
                    'calculate_discount_installment',
                  ].includes(call.name)
                ) {
                  const nativeRes = this.nativeToolsService.execute(
                    call.name,
                    args,
                    session.state,
                  );
                  if (
                    [
                      'set_session_variable',
                      'set_call_variable',
                      'set_variable',
                    ].includes(call.name) &&
                    nativeRes.ok
                  ) {
                    await flushConversationState();
                    sendDebug(
                      'session',
                      `💾 Variável salva na sessão pelo assistente.`,
                      { state: summarizeState(session.state) },
                    );
                  }
                  responses.push({
                    id: call.id,
                    name: call.name,
                    response: nativeRes,
                  });
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
                    session.state = pruneSessionState(
                      mergeApiReturnIntoState(session.state, {
                        returnedState,
                        sessionSaves,
                      }),
                    );
                    await flushConversationState();
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
              const generation = session.nextGeneration();
              const [voiceTools, voiceSubagents] =
                agent && session.clientId
                  ? await Promise.all([
                      this.voiceToolsService.getAgentTools(
                        session.clientId,
                        agent.id,
                      ),
                      this.voiceToolsService.getAgentSubagents(
                        session.clientId,
                        agent.id,
                      ),
                    ])
                  : [[], []];

              // 'start' concorrente: este connectAgent ficou obsoleto quando
              // outra iteração avançou a generation da sessão
              if (generation !== session.providerGeneration) {
                this.logger.warn(
                  '[VoiceGateway] connectAgent obsoleto (generation antiga); abortando',
                );
                return;
              }

              const voiceToolDeclarations = [
                ...voiceTools,
                ...voiceSubagents,
              ].map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              }));

              // Injeta as ferramentas nativas SOMENTE quando explicitamente
              // habilitadas no agente (transitions.capabilities.<key> === true
              // via toggles do AgentForm) — paridade com o canal de texto e
              // opt-in real. `finalizar_chamada` é sempre declarada com
              // agente persistido: o encerramento é controle de canal.
              const capabilities = this.asRecordSafe(
                (agent as any)?.transitions?.capabilities,
              );
              const nativeToolDecls = this.nativeToolsService
                .getDeclarations()
                .filter((decl) => {
                  if (decl.name === 'validate_variable_part') {
                    return capabilities.validate_variables === true;
                  }
                  if (decl.name === 'set_session_variable') {
                    return capabilities.set_variables === true;
                  }
                  if (decl.name === 'calculate_financial') {
                    return capabilities.financial_calculator === true;
                  }
                  return true;
                });
              voiceToolDeclarations.push(...nativeToolDecls);
              if (agent) {
                voiceToolDeclarations.push({
                  name: 'finalizar_chamada',
                  description:
                    'Encerra a chamada/atendimento atual de forma educada. Use apenas quando a conversa estiver concluída e não houver mais nada a tratar.',
                  parameters: { type: 'OBJECT', properties: {} },
                });
              }
              // Dedup por nome: declarações repetidas (ex.: subagents com o
              // mesmo nome cadastrado) fazem o Gemini rejeitar a conexão
              // inteira (1007 Duplicate function declaration)
              const seenToolNames = new Set<string>();
              const uniqueToolDeclarations = voiceToolDeclarations.filter(
                (decl) => {
                  if (!decl?.name || seenToolNames.has(decl.name)) return false;
                  seenToolNames.add(decl.name);
                  return true;
                },
              );
              if (
                uniqueToolDeclarations.length !== voiceToolDeclarations.length
              ) {
                this.logger.warn(
                  `[VoiceGateway] ${voiceToolDeclarations.length - uniqueToolDeclarations.length} tool declarations duplicadas removidas (agente ${agent?.id})`,
                );
              }
              voiceToolDeclarations.length = 0;
              voiceToolDeclarations.push(...uniqueToolDeclarations);

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

              if (!acquireVoiceSlot()) {
                sendToClient({
                  type: 'error',
                  code: 'VOICE_MAX_SESSIONS',
                  message:
                    'Limite de sessões de voz simultâneas atingido. Tente novamente em instantes.',
                });
                clientWs.close(1013, 'Too many voice sessions');
                return;
              }

              const provider = new GeminiLiveVoiceProvider();
              // Fecha o provider anterior antes de sobrescrever: 'start'
              // concorrente sem este close deixava o WS do Gemini aberto
              // (conectado e faturando) até o fim do processo
              if (session.liveProvider && session.liveProvider !== provider) {
                session.liveProvider.close();
              }
              session.liveProvider = provider;

              // Resolve variáveis {{chave}} do prompt com o estado da sessão
              // (incluindo retornos de APIs) + dados do cliente — pipeline
              // compartilhado com a telefonia
              const systemPrompt = buildVoiceSystemPrompt({
                agent,
                fallbackPrompt:
                  msg.systemPrompt ||
                  msg.prompt ||
                  'Você é um assistente de voz inteligente e natural do Synexa. Responda com clareza e empatia.',
                variables: {
                  nome_agente: clientDb?.agent_name || '',
                  // nome_empresa = empresa/tenant; nome_cliente (pessoa na
                  // linha) só existe se estiver no estado da sessão
                  nome_empresa: clientDb?.company_name || '',
                  ...session.state,
                },
              });

              provider.connect({
                apiKey,
                model: session.model,
                voiceName: session.voiceName,
                systemPrompt,
                contextCompressionEnabled:
                  clientDb?.context_compression_enabled ?? true,
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
                  // Tempo limite da chamada (web): conta o TEMPO TOTAL da
                  // ligação — armado 1x no primeiro setup (agente inicial);
                  // transições de agente NÃO reiniciam o cronômetro.
                  if (!maxDurationArmed) {
                    const maxDurationSec = resolveMaxCallDurationSec(agent);
                    if (maxDurationSec) {
                      maxDurationArmed = true;
                      maxDurationTimer = setTimeout(() => {
                        if (
                          voiceSessionClosed ||
                          generation !== session.providerGeneration
                        ) {
                          return;
                        }
                        sendDebug(
                          'session',
                          `⏱️ Tempo limite da chamada atingido (${maxDurationSec}s). Encerrando.`,
                          undefined,
                          'warn',
                        );
                        sendToClient({
                          type: 'call_ended',
                          reason: 'max_call_duration',
                        });
                        void closeVoiceSession();
                        try {
                          clientWs.close(1000, 'max_call_duration');
                        } catch {
                          // socket já fechado
                        }
                      }, maxDurationSec * 1000);
                    }
                  }
                  // Turnos de entrada (contexto de handoff / saudação)
                  // pertencem ao PRIMEIRO agente da chamada: transições de
                  // agente não reenviam a mensagem inicial.
                  if (!introTurnSent) {
                    if (handoffText) {
                      introTurnSent = true;
                      setTimeout(() => {
                        if (generation === session.providerGeneration) {
                          provider.sendText(
                            `[CONTEXTO DA TRANSFERÊNCIA]\nO usuário disse: ${handoffText}`,
                          );
                        }
                      }, 0);
                    } else if (agent && aiSpeaksFirstEnabled(agent)) {
                      // A IA fala primeiro: sauda o cliente imediatamente
                      // após o setup, antes de qualquer áudio do chamador.
                      // Usa a mensagem inicial configurada no agente quando
                      // existir (interpolando variáveis da sessão).
                      introTurnSent = true;
                      const greetingTurn = buildGreetingTurn(
                        agent,
                        session.state as Record<string, unknown>,
                      );
                      setTimeout(() => {
                        if (generation === session.providerGeneration) {
                          sendDebug(
                            'session',
                            '🤖 IA inicia a conversa (saudação automática).',
                          );
                          provider.sendText(greetingTurn);
                        }
                      }, 0);
                    }
                  }
                },
                onAudio: (base64Audio) => {
                  if (generation !== session.providerGeneration) return;
                  session.isAiSpeaking = true;
                  session.gateSession?.notifyAiSpeakingChanged(true);
                  // Áudio da IA volta pelo adapter (frame JSON ao navegador)
                  callAdapter.sendAudio(Buffer.from(base64Audio, 'base64'));
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
                    session.aiMessageBuffer =
                      this.telemetryService.createAiBuffer();
                  }
                  sendToClient({ type: 'ai_transcript', text });
                  await this.telemetryService.appendAiTranscript(session, text);
                },
                onUserTranscript: async (text) => {
                  if (generation !== session.providerGeneration) return;
                  sendDebug('audio', 'Fala do usuário transcrita.', { text });
                  sendToClient({ type: 'user_transcript', text });
                  await this.telemetryService.persistUserTranscript(
                    session,
                    text,
                  );
                  await handleUserTranscript(text, generation);
                },
                onInterrupted: async () => {
                  if (generation !== session.providerGeneration) return;
                  session.isAiSpeaking = false;
                  session.interruptedCount++;
                  session.aiResponseStarted = false;
                  // Preserva o trecho falado antes da interrupção
                  await this.telemetryService.flushAiBuffer(session);
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
                  await this.telemetryService.flushAiBuffer(session);
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
              session.nextGeneration();
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
              session.state = pruneSessionState({
                ...session.state,
                current_agent_id: targetAgent.id,
                switch_reason: reason,
              });
              await flushConversationState();
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
            // O WS pode ter fechado durante o connectAgent (await): sem esta
            // checagem o interval de telemetria seria criado após o cleanup
            // e nunca mais limpo (leak por conexão)
            if (voiceSessionClosed) {
              this.logger.warn(
                '[VoiceGateway] Sessão encerrada durante o start; timer de telemetria não criado',
              );
              break;
            }
            sendTelemetry();
            telemetryTimer = setInterval(sendTelemetry, 5000);
            break;
          }

          case 'audio': {
            if (session.mockSession) {
              session.mockSession.handleClientMessage(msg);
              return;
            }

            // Pipeline unificado: frame do navegador → adapter → gate → provider
            if (msg.data && session.callAdapter) {
              session.callAdapter.handleClientAudio(msg.data);
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
      clearIdentificationTimer();
      if (session.mockSession) {
        session.mockSession.close();
        session.mockSession = null;
      }
      await this.telemetryService.flushAiBuffer(session);
      await closeVoiceSession();
      this.sessions.delete(clientWs);
    });
  }

  handleDisconnect(clientWs: WebSocket) {
    const session = this.sessions.get(clientWs);
    if (session) {
      if (session.holdsSessionSlot) {
        session.holdsSessionSlot = false;
        this.voiceSessionFactory.releaseSession();
      }
      session.liveProvider?.close();
      this.sessions.delete(clientWs);
    }
  }

  /**
   * Teto de conexoes pre-auth por IP (Redis INCR com janela de 60s): sem
   * este limite, sockets sem identificacao acumulam sessoes pendentes.
   */
  private asRecordSafe(value: unknown): Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  private enforcePreAuthConnectionLimit(clientWs: AuthenticatedWebSocket) {
    const ip = clientIpOf(clientWs);
    const max =
      this.configService.get<number>('VOICE_MAX_PREAUTH_PER_IP', 10) || 10;
    const key = `voice:preauth:${ip}`;
    void this.redis
      .getClient()
      .incr(key)
      .then(async (current) => {
        if (current === 1) {
          await this.redis.getClient().expire(key, 60);
        }
        if (current > max) {
          this.logger.warn(
            `[VoiceGateway] Limite de conexões pre-auth excedido por IP (${ip}): ${current}/${max}`,
          );
          clientWs.close(1013, 'Too many connections');
        }
      })
      .catch(() => {
        // Redis indisponivel: fail-open (disponibilidade da voz)
      });
  }

  private isTrustedOrigin(clientWs: AuthenticatedWebSocket) {
    const origin = clientWs.handshakeRequest?.headers?.origin;
    const environment = this.configService.get<string>(
      'ENVIRONMENT',
      'development',
    );
    if (!origin) {
      // Em production, handshake sem Origin é recusado (S20)
      return environment !== 'production';
    }

    if (environment === 'development' || environment === 'test') return true;

    const allowedOrigins = (this.configService.get<string>('CORS_ORIGIN') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return typeof origin === 'string' && allowedOrigins.includes(origin);
  }
}

function clientIpOf(clientWs: AuthenticatedWebSocket): string {
  const forwarded = clientWs.handshakeRequest?.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return (
    clientWs.handshakeRequest?.socket?.remoteAddress?.toString() || 'unknown'
  );
}
