import { Logger } from '@nestjs/common';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import {
  GeminiLiveVoiceProvider,
  resolveLiveModel,
} from '../providers/gemini-live-voice.provider';
import { IVoiceProvider } from '../providers/voice-provider.interface';
import {
  AudioGateService,
  AudioGateSession,
} from '../services/audio-gate.service';
import { VoiceToolsService } from '../voice-tools.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  InboundDataMapperService,
  InboundMappingConfig,
} from '../../common/services/inbound-data-mapper.service';
import {
  buildVoiceSystemPrompt,
  aiSpeaksFirstEnabled,
  buildGreetingTurn,
  resolveMaxCallDurationSec,
} from '../services/voice-runtime.util';

export interface VoiceGateRuntimeConfig {
  enabled?: boolean;
  threshold?: number;
  hangoverMarginMs?: number;
  prerollMs?: number;
}

export interface VoiceCallSessionConfig {
  companyId?: string;
  clientId?: string;
  agentId?: string;
  selectedAgent?: any;
  model?: string;
  voiceName?: string;
  apiKey?: string;
  /** Context compression (sliding window) — default ON quando ausente */
  contextCompressionEnabled?: boolean;
  /** Config de audio gate resolvida (por padrão usa valores do cliente/env) */
  gateConfig?: VoiceGateRuntimeConfig;
  /** Canal usado na sincronização com painel_interactions (ex: voice_sip, voice_webrtc) */
  channel?: string;
  voiceEngine?: 'hybrid' | 'live_api';
  cartesiaApiKey?: string;
  groqApiKey?: string;
  /**
   * Handler chamado quando a IA solicita o encerramento da chamada
   * (tool `finalizar_chamada`). Ex: AMI hangupChannel no Asterisk.
   */
  onAiHangupRequest?: () => Promise<void> | void;
  /** Libera o slot do semáforo global de sessões de voz */
  onSessionEnd?: () => void;
}

export class VoiceCallSession {
  private readonly logger = new Logger(VoiceCallSession.name);

  public readonly id: string;
  public conversationId: string | null = null;
  public isAiSpeaking = false;
  public interruptedCount = 0;
  public inputTokens = 0;
  public outputTokens = 0;
  public totalTokens = 0;
  public startTime = 0;
  private isEnded = false;

  private gateSession: AudioGateSession | null = null;
  private telephonyAdapter: ITelephonyAdapter;
  private liveProvider: IVoiceProvider;
  private audioGateService: AudioGateService;
  private voiceToolsService: VoiceToolsService | undefined;
  private pricingService: ModelPricingService;
  private prisma: PrismaService;
  private config: VoiceCallSessionConfig;
  /** Estado da sessão (variáveis mapeadas da telefonia + retornos de API) */
  public sessionState: Record<string, unknown> = {};
  /** Metadados persistidos na criação da conversa (mantidos no fechamento) */
  private conversationMetadata: Record<string, unknown> = {};
  /** Motivo do encerramento (remoto ou solicitado pela IA) */
  public hangupCause: string | null = null;
  private aiMessageBuffer: {
    messageId: string | null;
    content: string;
    lastPersist: number;
  } | null = null;
  private userMessageBuffer: {
    messageId: string | null;
    content: string;
    lastPersist: number;
  } | null = null;
  private sessionSlotReleased = false;
  /** Setup do Gemini concluído (saudação automática aguarda isto) */
  private setupCompleted = false;
  /** Transporte de telefonia iniciado (greeting aguarda isto) */
  private transportStarted = false;
  private greetingSent = false;
  /** Watchdog do tempo limite da chamada (max_call_duration_sec) */
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    telephonyAdapter: ITelephonyAdapter;
    liveProvider: IVoiceProvider;
    audioGateService: AudioGateService;
    pricingService: ModelPricingService;
    prisma: PrismaService;
    voiceToolsService?: VoiceToolsService;
    config: VoiceCallSessionConfig;
  }) {
    this.telephonyAdapter = options.telephonyAdapter;
    this.liveProvider = options.liveProvider;
    this.audioGateService = options.audioGateService;
    this.pricingService = options.pricingService;
    this.prisma = options.prisma;
    this.voiceToolsService = options.voiceToolsService;
    this.config = options.config;
    this.id = this.telephonyAdapter.id;
  }

  /**
   * Inicia a sessão completa de voz e IA.
   */
  public async start(): Promise<void> {
    try {
      this.startTime = Date.now();
      const { selectedAgent, clientId, companyId } = this.config;

      // 1. Consolida e Mapeia variáveis recebidas da telefonia (ex: Asterisk AGI / CallFlex)
      let inboundConfig: InboundMappingConfig | undefined;
      let clientAgentName = '';
      let clientCompanyName = '';
      if (clientId) {
        try {
          const client = await this.prisma.painel_clients.findUnique({
            where: { id: clientId },
            select: { metadata: true, agent_name: true, company_name: true },
          });
          clientAgentName = client?.agent_name || '';
          clientCompanyName = client?.company_name || '';
          const meta = (client?.metadata as Record<string, unknown>) || {};
          inboundConfig = meta.inbound_variable_mapping as InboundMappingConfig;
        } catch (err: any) {
          this.logger.warn(
            `Erro ao buscar regras de mapeamento: ${err.message}`,
          );
        }
      }

      const fallbackAgentName =
        clientAgentName ||
        (selectedAgent as any)?.agent_name ||
        (selectedAgent as any)?.name ||
        'Maria';
      const fallbackCompanyName = clientCompanyName || 'Cliente';

      // Nome da PESSOA na linha: prioridade para o caller_name filtrado que
      // o servidor de telefonia já normalizou (ex.: descarta o display name
      // padrão do softphone "microsip"); por último o caller_name cru.
      const adapterCustomVars = (this.telephonyAdapter.metadata
        .customVariables || {}) as Record<string, unknown>;
      const rawCallerName =
        (adapterCustomVars.caller_name as string) ||
        this.telephonyAdapter.metadata.callerName ||
        '';
      const callerNameClean =
        /^(microsip|unknown|anonymous|desconhecido)$/i.test(
          rawCallerName.trim(),
        )
          ? ''
          : rawCallerName.trim();

      const rawContextVariables: Record<string, any> = {
        ...adapterCustomVars,
        caller_number: this.telephonyAdapter.metadata.callerNumber,
        caller_name: callerNameClean,
        did_number: this.telephonyAdapter.metadata.didNumber,
        channel_id: this.telephonyAdapter.metadata.channelId,
        nome_agente: fallbackAgentName,
        agent_name: fallbackAgentName,
        // nome_cliente = nome da PESSOA na linha (caller_name limpo, ou
        // sobrescrito pelo mapeamento inbound/CRM); NUNCA o nome da empresa
        nome_cliente: callerNameClean,
        // nome_empresa/empresa/company_name = empresa (tenant)
        nome_empresa: fallbackCompanyName,
        company_name: fallbackCompanyName,
        empresa: fallbackCompanyName,
      };

      const mapper = new InboundDataMapperService();
      const contextVariables = mapper.mapInboundData(
        rawContextVariables,
        inboundConfig,
        'voice',
      );
      this.sessionState = { ...contextVariables };

      // 2. Interpola variáveis no Prompt do Agente (pipeline compartilhado
      //    com o canal Web do painel)
      const systemPrompt = buildVoiceSystemPrompt({
        agent: selectedAgent,
        agentVariables: contextVariables,
        fallbackPrompt:
          'Você é um assistente de voz inteligente e natural. Responda com clareza e empatia.',
        variables: {
          ...contextVariables,
          nome_agente: contextVariables.nome_agente || fallbackAgentName,
          agent_name: contextVariables.agent_name || fallbackAgentName,
          // nome da pessoa na linha: sem valor => vazio (não vaza o nome da
          // empresa); o mapeamento inbound pode preencher
          nome_cliente: contextVariables.nome_cliente || '',
          nome_empresa: fallbackCompanyName,
          company_name: fallbackCompanyName,
          empresa: fallbackCompanyName,
        },
      });

      // 3. Inicializa Conversa Omnichannel no Banco de Dados
      if (companyId) {
        try {
          const convMetadata = {
            telephony_provider: this.telephonyAdapter.providerName,
            call_id: this.telephonyAdapter.id,
            caller: this.telephonyAdapter.metadata.callerNumber,
            did: this.telephonyAdapter.metadata.didNumber,
            context_variables: contextVariables,
            model: this.config.model,
            voice_name: this.config.voiceName,
          } as Record<string, unknown>;
          const conv = await this.prisma.conversations.create({
            data: {
              company_id: companyId,
              client_id: clientId,
              origin_channel: 'voice',
              status: 'active',
              metadata: convMetadata as any,
            },
          });
          this.conversationId = conv.id;
          this.conversationMetadata = convMetadata;

          // Persiste variáveis mapeadas no estado da conversa
          await this.prisma.conversation_state.upsert({
            where: { conversation_id: conv.id },
            create: {
              conversation_id: conv.id,
              state: contextVariables as any,
            },
            update: {
              state: contextVariables as any,
            },
          });
        } catch (err: any) {
          this.logger.error(
            `Erro ao criar conversa ou estado no banco: ${err.message}`,
          );
        }
      }

      // 4. Carrega Tools & Subagentes
      let toolsDeclarations: any[] = [];
      if (this.voiceToolsService && clientId && selectedAgent?.id) {
        try {
          const agentTools = await this.voiceToolsService.getAgentTools(
            clientId,
            selectedAgent.id,
          );
          const agentSubagents = await this.voiceToolsService.getAgentSubagents(
            clientId,
            selectedAgent.id,
          );
          toolsDeclarations = [...agentTools, ...agentSubagents].map(
            ({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            }),
          );
        } catch (err: any) {
          this.logger.warn(`Erro ao carregar tools do agente: ${err.message}`);
        }
      }

      // Adiciona tool nativa de controle de variáveis de telefonia
      toolsDeclarations.push({
        name: 'set_call_variable',
        description:
          'Define ou atualiza uma variável na telefonia/PBX para o fluxo da chamada ou CRM.',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: {
              type: 'STRING',
              description:
                'Nome da variável (ex: status_atendimento, cpf_confirmado, motivo_contato)',
            },
            value: { type: 'STRING', description: 'Valor a ser gravado' },
          },
          required: ['name', 'value'],
        },
      });

      // Tool nativa de encerramento da chamada (quando há controle do canal)
      if (this.config.onAiHangupRequest) {
        toolsDeclarations.push({
          name: 'finalizar_chamada',
          description:
            'Encerra a chamada telefônica atual de forma educada. Use apenas quando a conversa estiver concluída.',
          parameters: {
            type: 'OBJECT',
            properties: {},
          },
        });
      }

      // Dedup por nome: declarações repetidas (ex.: subagents com o mesmo
      // nome cadastrado) fazem o Gemini rejeitar a conexão inteira (1007)
      const seenToolNames = new Set<string>();
      toolsDeclarations = toolsDeclarations.filter((decl) => {
        if (!decl?.name || seenToolNames.has(decl.name)) return false;
        seenToolNames.add(decl.name);
        return true;
      });

      // 5. Configura o Audio Gate (VAD / Supressão de Ruído)
      this.gateSession = this.audioGateService.createSession({
        enabled: this.config.gateConfig?.enabled ?? true,
        threshold: this.config.gateConfig?.threshold ?? 500,
        hangoverMarginMs: this.config.gateConfig?.hangoverMarginMs ?? 500,
        prerollMs: this.config.gateConfig?.prerollMs ?? 300,
        sampleRate: 16000,
      });

      // 6. Conecta a IA (Gemini Live Provider)
      await this.liveProvider.connect({
        apiKey: this.config.apiKey || process.env.GEMINI_API_KEY || '',
        cartesiaApiKey: this.config.cartesiaApiKey,
        groqApiKey: this.config.groqApiKey,
        model:
          this.config.voiceEngine === 'hybrid'
            ? this.config.model &&
              this.config.model.toLowerCase().startsWith('gemini-') &&
              !this.config.model.includes('live') &&
              !this.config.model.includes('native-audio')
              ? this.config.model
              : 'gemini-2.5-flash-lite'
            : resolveLiveModel(this.config.model),
        voiceName: this.config.voiceName,
        systemPrompt,
        contextCompressionEnabled:
          this.config.contextCompressionEnabled ?? true,
        tools: toolsDeclarations.length
          ? [{ functionDeclarations: toolsDeclarations }]
          : undefined,
        onSetupComplete: () => {
          this.logger.log(
            `🎙️ [VoiceCallSession] Provedor de IA conectado para chamada ${this.id}`,
          );
          this.setupCompleted = true;
          this.maybeSendGreeting();
        },
        onAudio: (base64Audio) => {
          const pcm24k = Buffer.from(base64Audio, 'base64');
          this.isAiSpeaking = true;
          this.gateSession?.notifyAiSpeakingChanged(true);
          this.telephonyAdapter.sendAudio(pcm24k);
        },
        onAiTranscript: async (text) => {
          await this.appendAiTranscript(companyId, text);
        },
        onUserTranscript: async (text) => {
          await this.appendUserTranscript(companyId, text);
        },
        onInterrupted: () => {
          this.isAiSpeaking = false;
          this.interruptedCount++;
          // Barge-in: descarta o áudio do Gemini ainda enfileirado para que
          // a IA pare de falar imediatamente (evita cauda obsoleta tocando)
          this.telephonyAdapter.clearQueuedAudio?.();
          this.gateSession?.notifyAiSpeakingChanged(false);
          void this.flushTranscriptBuffers();
        },
        onTurnComplete: () => {
          this.isAiSpeaking = false;
          this.gateSession?.notifyAiSpeakingChanged(false);
          void this.flushTranscriptBuffers();
        },
        onToolCall: async (functionCalls) => {
          // O protocolo BidiGenerateContent do Gemini Live paralisa a síntese
          // de fala até receber toolResponse para CADA call recebida. Qualquer
          // exceção ou return antecipado que omita o sendToolResponse provoca
          // deadlock — por isso todo caminho abaixo termina respondendo.
          const errorResponseFor = (call: any, err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            return {
              id: call.id,
              name: call.name,
              response: { ok: false, error: message },
            };
          };

          if (!clientId || !selectedAgent?.id) {
            this.logger.warn(
              `⚠️ [VoiceCallSession] Tool calls sem clientId/agente (chamada ${this.id})`,
            );
            this.liveProvider.sendToolResponse(
              functionCalls.map((call) =>
                errorResponseFor(call, 'Client or agent unavailable'),
              ),
            );
            return;
          }

          let responses: Array<{ id: string; name: string; response: any }>;
          try {
            responses = await Promise.all(
              functionCalls.map(async (call) => {
                try {
                  if (call.name === 'finalizar_chamada') {
                    this.logger.log(
                      `📞 [VoiceCallSession] IA solicitou encerramento da chamada ${this.id}`,
                    );
                    this.hangupCause = 'ai_requested';
                    try {
                      await this.config.onAiHangupRequest?.();
                    } catch (err: any) {
                      this.logger.warn(
                        `Falha ao solicitar hangup do canal: ${err.message}`,
                      );
                    }
                    // Fallback: encerra a sessão de IA mesmo sem confirmação do canal
                    setTimeout(() => void this.end('ai_requested'), 2500);
                    return {
                      id: call.id,
                      name: call.name,
                      response: { ok: true },
                    };
                  }

                  if (call.name === 'set_call_variable') {
                    const varName = call.args?.name;
                    const varVal = call.args?.value;
                    if (
                      varName &&
                      varVal &&
                      this.telephonyAdapter.setVariable
                    ) {
                      await this.telephonyAdapter.setVariable(
                        String(varName),
                        String(varVal),
                      );
                      return {
                        id: call.id,
                        name: call.name,
                        response: { ok: true, saved: { [varName]: varVal } },
                      };
                    }
                    return {
                      id: call.id,
                      name: call.name,
                      response: {
                        ok: false,
                        error: 'Telephony does not support setVariable',
                      },
                    };
                  }

                  if (!this.voiceToolsService) {
                    return {
                      id: call.id,
                      name: call.name,
                      response: {
                        ok: false,
                        error: 'Tools service unavailable',
                      },
                    };
                  }

                  const isSubagent = call.name.startsWith('subagent_');
                  const response = isSubagent
                    ? await this.voiceToolsService.executeSubagent(
                        clientId,
                        selectedAgent.id,
                        call.name,
                        call.args || {},
                      )
                    : await this.voiceToolsService.execute(
                        clientId,
                        selectedAgent.id,
                        call.name,
                        call.args || {},
                        this.sessionState,
                      );

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
                    this.sessionState = {
                      ...this.sessionState,
                      ...returnedState,
                    };
                  }

                  return { id: call.id, name: call.name, response };
                } catch (err: any) {
                  this.logger.warn(
                    `🛠️ [VoiceCallSession] Tool ${call.name} falhou: ${err.message}`,
                  );
                  return errorResponseFor(call, err);
                }
              }),
            );
          } catch (err: any) {
            this.logger.error(
              `❌ [VoiceCallSession] Falha ao processar tool calls: ${err.message}`,
            );
            responses = functionCalls.map((call) =>
              errorResponseFor(call, err),
            );
          }
          this.liveProvider.sendToolResponse(responses);
        },
        onUsageMetadata: (meta) => {
          this.totalTokens = meta.totalTokenCount || 0;
          this.inputTokens = meta.promptTokenCount || 0;
          this.outputTokens = meta.candidatesTokenCount || 0;
        },
        onError: (err) => {
          this.logger.error(
            `❌ [VoiceCallSession] Erro no Gemini Live: ${err.message}`,
          );
        },
        onClose: () => {
          this.logger.log(
            `🛑 [VoiceCallSession] Sessão IA encerrada para chamada ${this.id}`,
          );
        },
      });

      // 7. Configura o Transporte de Telefonia
      this.telephonyAdapter.onAudio((pcm16k) => {
        if (this.isEnded) return;
        const result = this.gateSession?.processChunk(
          pcm16k.toString('base64'),
          this.isAiSpeaking,
        );
        if (result) {
          for (const chunk of result.forwardChunks) {
            this.liveProvider.sendAudio(chunk);
          }
          if (result.shouldSendStreamEnd) {
            this.liveProvider.sendAudioStreamEnd();
          }
        }
      });

      this.telephonyAdapter.onCallEnd((reason) => {
        if (reason) this.hangupCause = String(reason);
        void this.end(reason ? `remote_${reason}` : 'remote_hangup');
      });

      await this.telephonyAdapter.start();
      this.transportStarted = true;
      this.maybeSendGreeting();
      this.armMaxDurationWatchdog();
    } catch (err) {
      this.releaseSessionSlot();
      try {
        this.liveProvider.close();
      } catch {}
      try {
        this.telephonyAdapter.close();
      } catch {}
      throw err;
    }
  }

  /**
   * A IA fala primeiro: quando setup + transporte estiverem prontos, envia
   * um turno de usuário com a instrução de saudação. Respeita a capability
   * `ai_speaks_first` do agente (default ligado) e usa a mensagem inicial
   * configurada (`greeting_message`) quando existir.
   */
  private maybeSendGreeting(): void {
    if (this.greetingSent) return;
    if (!this.setupCompleted || !this.transportStarted) return;
    const agent = this.config.selectedAgent as unknown;
    if (!aiSpeaksFirstEnabled(agent)) return;
    this.greetingSent = true;
    this.logger.log(
      `🤖 [VoiceCallSession] IA sauda o cliente primeiro (chamada ${this.id})`,
    );
    const turn = buildGreetingTurn(agent, {
      ...this.sessionState,
    });
    setTimeout(() => this.liveProvider.sendText(turn), 0);
  }

  /**
   * Agenda o watchdog do tempo limite da chamada
   * (`transitions.capabilities.max_call_duration_sec` do agente).
   */
  private armMaxDurationWatchdog(): void {
    const limitSec = resolveMaxCallDurationSec(
      this.config.selectedAgent as unknown,
    );
    if (!limitSec) return;
    this.maxDurationTimer = setTimeout(
      () => void this.enforceMaxCallDuration(limitSec),
      limitSec * 1000,
    );
  }

  /**
   * Tempo limite atingido: solicita o hangup do canal (como
   * `finalizar_chamada`) e encerra a sessão mesmo sem confirmação.
   */
  private async enforceMaxCallDuration(limitSec: number): Promise<void> {
    this.maxDurationTimer = null;
    if (this.isEnded) return;
    this.logger.warn(
      `⏱️ [VoiceCallSession] Tempo limite da chamada ${this.id} atingido (${limitSec}s). Encerrando.`,
    );
    this.hangupCause = 'max_call_duration';
    try {
      await this.config.onAiHangupRequest?.();
    } catch (err: any) {
      this.logger.warn(
        `Falha ao solicitar hangup do canal (tempo limite): ${err.message}`,
      );
    }
    try {
      await this.telephonyAdapter.hangup('max_call_duration');
    } catch (err: any) {
      this.logger.warn(
        `Falha no hangup direto do canal (tempo limite): ${err.message}`,
      );
    }
    // Fallback: encerra a sessão de IA mesmo sem confirmação do canal
    setTimeout(() => void this.end('max_call_duration'), 2500);
  }

  private releaseSessionSlot(): void {
    if (this.sessionSlotReleased) return;
    this.sessionSlotReleased = true;
    this.config.onSessionEnd?.();
  }

  /** Transcript da IA: cria 1x e atualiza a mesma linha com throttle 1s. */
  private async appendAiTranscript(
    companyId: string | undefined,
    text: string,
  ): Promise<void> {
    if (!this.conversationId || !companyId || !text) return;
    try {
      if (!this.aiMessageBuffer) {
        this.aiMessageBuffer = { messageId: null, content: '', lastPersist: 0 };
      }
      const buffer = this.aiMessageBuffer;
      if (buffer.content && text.startsWith(buffer.content)) {
        buffer.content = text;
      } else {
        buffer.content = buffer.content ? `${buffer.content} ${text}` : text;
      }
      const now = Date.now();
      if (!buffer.messageId) {
        const created = await this.prisma.messages.create({
          data: {
            conversation_id: this.conversationId,
            company_id: companyId,
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
    } catch {
      // Silencioso em caso de log
    }
  }

  /** Transcript do usuário: acumulado no turno e persistido 1x/seg. */
  private async appendUserTranscript(
    companyId: string | undefined,
    text: string,
  ): Promise<void> {
    if (!this.conversationId || !companyId || !text) return;
    try {
      if (!this.userMessageBuffer) {
        this.userMessageBuffer = {
          messageId: null,
          content: '',
          lastPersist: 0,
        };
      }
      const buffer = this.userMessageBuffer;
      if (buffer.content && text.startsWith(buffer.content)) {
        buffer.content = text;
      } else {
        buffer.content = buffer.content ? `${buffer.content} ${text}` : text;
      }
      const now = Date.now();
      if (!buffer.messageId) {
        const created = await this.prisma.messages.create({
          data: {
            conversation_id: this.conversationId,
            company_id: companyId,
            sender_type: 'customer',
            channel: 'voice',
            direction: 'inbound',
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
    } catch {
      // Silencioso em caso de log
    }
  }

  /** Persiste o conteúdo final dos buffers de transcript (fim de turno). */
  private async flushTranscriptBuffers(): Promise<void> {
    const buffers = [this.aiMessageBuffer, this.userMessageBuffer];
    this.aiMessageBuffer = null;
    this.userMessageBuffer = null;
    for (const buffer of buffers) {
      if (!buffer?.messageId || !buffer.content) continue;
      try {
        await this.prisma.messages.update({
          where: { id: buffer.messageId },
          data: { content: buffer.content },
        });
      } catch {
        // Silencioso em caso de log
      }
    }
  }

  /**
   * Encerra a sessão, desliga o canal e persiste telemetria.
   */
  public async end(reason?: string): Promise<void> {
    if (this.isEnded) return;
    this.isEnded = true;
    // Descarrega os buffers de transcript antes de encerrar para não perder
    // as últimas frases quando o cliente desliga no meio de um turno.
    await this.flushTranscriptBuffers();
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (reason) this.hangupCause = String(reason);
    this.releaseSessionSlot();
    const channelId = this.telephonyAdapter.metadata.channelId as
      | string
      | undefined;

    try {
      this.liveProvider.close();
      this.telephonyAdapter.close();

      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - this.startTime) / 1000),
      );
      const stats = this.gateSession?.getStats();
      const rawCost =
        this.config.voiceEngine === 'hybrid'
          ? this.pricingService.calculateHybridVoiceCost({
              durationSeconds,
              inputTokens: this.inputTokens,
              outputTokens: this.outputTokens,
            })
          : this.pricingService.calculateVoiceLiveCost({
              durationSeconds,
              inputTokens: this.inputTokens,
              outputTokens: this.outputTokens,
            });

      if (
        this.config.clientId &&
        this.config.companyId &&
        this.conversationId
      ) {
        await this.prisma.voice_session_telemetry.create({
          data: {
            company_id: this.config.companyId,
            client_id: this.config.clientId,
            conversation_id: this.conversationId,
            asterisk_unique_id: this.telephonyAdapter.metadata.uniqueId ?? null,
            caller_number:
              (this.telephonyAdapter.metadata.callerNumber as string) || null,
            did_number:
              (this.telephonyAdapter.metadata.didNumber as string) || null,
            hangup_cause: this.hangupCause,
            duration_sec: durationSeconds,
            audio_gate_forwarded_sec: stats?.forwardedSec || 0,
            audio_gate_suppressed_sec: stats?.suppressedSec || 0,
            audio_gate_closes: stats?.closes || 0,
            interrupted_count: this.interruptedCount,
            total_tokens: this.totalTokens,
            audio_input_tokens: this.inputTokens,
            audio_output_tokens: this.outputTokens,
            cost_usd: rawCost,
            cost_brl: Number((rawCost * 5.5).toFixed(4)),
            model: this.config.model || null,
            voice_name: this.config.voiceName || 'Aoede',
            audio_gate_enabled: this.gateSession?.enabled ?? true,
            metadata: {
              telephony_provider: this.telephonyAdapter.providerName,
              channel_id: channelId,
            } as any,
          },
        });
      }

      if (this.conversationId) {
        await this.prisma.conversations.update({
          where: { id: this.conversationId },
          data: {
            status: 'closed',
            closed_at: new Date(),
            metadata: {
              ...this.conversationMetadata,
              hangup_cause: this.hangupCause,
              duration_sec: durationSeconds,
              cost_usd: rawCost,
              interrupted_count: this.interruptedCount,
            } as any,
          },
        });

        // Sincroniza interação unificada (painel_interactions)
        if (this.config.clientId && this.config.companyId) {
          try {
            await this.prisma.painel_interactions.upsert({
              where: { session_id: this.conversationId },
              create: {
                company_id: this.config.companyId,
                client_id: this.config.clientId,
                agent_id: this.config.agentId || null,
                session_id: this.conversationId,
                channel: this.config.channel || 'voice_webrtc',
                direction: 'inbound',
                interaction_mode: 'voice',
                has_human_answer: true,
                human_answered_at: new Date(this.startTime),
                barge_in_count: this.interruptedCount,
                duration_seconds: durationSeconds,
                billable_seconds: durationSeconds,
                total_tokens: this.totalTokens,
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                estimated_cost_usd: rawCost as any,
                llm_model: this.config.model || 'gemini-2.0-flash-exp',
                started_at: new Date(this.startTime),
                ended_at: new Date(),
                status: 'completed',
              },
              update: {
                has_human_answer: true,
                barge_in_count: this.interruptedCount,
                duration_seconds: durationSeconds,
                billable_seconds: durationSeconds,
                total_tokens: this.totalTokens,
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                estimated_cost_usd: rawCost as any,
                ended_at: new Date(),
                status: 'completed',
              },
            });
          } catch (intErr: any) {
            this.logger.warn(
              `Falha ao registrar painel_interactions na sessão de voz: ${intErr.message}`,
            );
          }
        }
      }

      this.logger.log(
        `📊 [VoiceCallSession] Chamada ${this.id} finalizada: ${durationSeconds}s | Custo: $${rawCost} | Motivo: ${this.hangupCause || 'normal'}`,
      );
    } catch (err: any) {
      this.logger.error(`Erro ao finalizar sessão de voz: ${err.message}`);
    }
  }
}
