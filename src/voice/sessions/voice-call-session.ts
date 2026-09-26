import { VoiceWorkTracker } from '../services/voice-work-tracker';
import {
  createVoiceConversation,
  startVoiceHeartbeat,
  finalizeVoiceConversation,
} from '../services/voice-heartbeat';
import { withFlowGreeting } from '../services/voice-runtime.util';
import { resolveVoiceFlowSettings } from '../services/voice-flow-settings';
import {
  VoiceInactivity,
  readInactivityTurns,
} from '../services/voice-inactivity';
import { Logger } from '@nestjs/common';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import {
  GeminiLiveVoiceProvider,
  resolveLiveModel,
  resolveLiveVoice,
} from '../providers/gemini-live-voice.provider';
import {
  IVoiceProvider,
  VoiceProviderConnectOptions,
} from '../providers/voice-provider.interface';
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
  buildSwitchTurn,
  resolveMaxCallDurationSec,
  selectVoiceGreetingVariation,
  voiceGreetingCacheEnabled,
  buildVoiceFarewellToolResponse,
  VOICE_HANGUP_WATCHDOG_TIMEOUT_MS,
} from '../services/voice-runtime.util';

import { VoiceGreetingCacheService } from '../services/voice-greeting-cache.service';
import { extractFunnelFromState } from '../../common/utils/funnel-mapping.util';
import { evaluateConditionsWithDetails } from '../../orchestrator/utils/condition-evaluator.util';

export interface VoiceGateRuntimeConfig {
  enabled?: boolean;
  threshold?: number;
  hangoverMarginMs?: number;
  prerollMs?: number;
}

export interface VoiceCallSessionConfig {
  geminiLive?: unknown;
  voiceBehavior?: {
    greetingMessage?: string;
    aiSpeaksFirst?: boolean;
    greetingCacheEnabled?: boolean;
    idleEnabled?: boolean;
    turns?: unknown[];
  };
  voiceSettings?: unknown;
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
  /** Provedor TTS efetivo da chamada: 'cartesia' | 'custom' | 'google'. */
  ttsProvider?: string;
  /** Provedor STT efetivo da chamada: 'groq' | 'custom'. */
  sttProvider?: string;
  /** Config BYO de TTS (endpoint HTTP do cliente) quando ttsProvider === 'custom'. */
  customTts?: {
    baseUrl: string;
    apiKey: string;
    voice?: string;
    sampleRate?: number;
    timeoutMs?: number;
  };
  /** Config BYO de STT (endpoint HTTP do cliente) quando sttProvider === 'custom'. */
  customStt?: {
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
  };
  inworldApiKey?: string;
  cartesiaApiKey?: string;
  groqApiKey?: string;
  /**
   * Handler chamado quando a IA solicita o encerramento da chamada
   * (tool `finalizar_chamada`). Ex: AMI hangupChannel no Asterisk.
   */
  onAiHangupRequest?: () => Promise<void> | void;
  /** Libera o slot do semáforo global de sessões de voz */
  onSessionEnd?: () => void;
  /** Transmite eventos em tempo real da chamada telefônica (tools, encadeamento, transcrição, handover) */
  onEvent?: (event: { type: string; [key: string]: any }) => void;
}

export class VoiceCallSession {
  private readonly logger = new Logger(VoiceCallSession.name);

  public readonly id: string;
  private stopHeartbeat?: () => void;
  private exportEnabled = false;
  private readonly pendingWork = new VoiceWorkTracker();
  public conversationId: string | null = null;
  public isAiSpeaking = false;
  public isGreetingPlaying = false;
  public interruptedCount = 0;
  public inputTokens = 0;
  public outputTokens = 0;
  public totalTokens = 0;
  public startTime = 0;
  private isEnded = false;

  private inactivity?: VoiceInactivity;
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
  /** Sinaliza que a IA solicitou encerramento e aguarda o término da fala da despedida */
  private pendingAiHangup = false;
  private hangupExecuted = false;
  private hangupWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private liveAudioTap?: (
    role: 'ai' | 'user',
    chunk: Buffer,
    sampleRate: number,
  ) => void;
  public onSpeakingStateChange?: (
    state: 'speaking_ai' | 'listening_user' | 'thinking',
  ) => void;

  public setLiveAudioTap(
    tap?: (role: 'ai' | 'user', chunk: Buffer, sampleRate: number) => void,
  ): void {
    this.liveAudioTap = tap;
  }

  constructor(options: {
    telephonyAdapter: ITelephonyAdapter;
    liveProvider: IVoiceProvider;
    audioGateService: AudioGateService;
    pricingService: ModelPricingService;
    prisma: PrismaService;
    voiceToolsService?: VoiceToolsService;
    greetingCacheService?: VoiceGreetingCacheService;
    config: VoiceCallSessionConfig;
  }) {
    this.telephonyAdapter = options.telephonyAdapter;
    this.liveProvider = options.liveProvider;
    this.audioGateService = options.audioGateService;
    this.pricingService = options.pricingService;
    this.prisma = options.prisma;
    this.voiceToolsService = options.voiceToolsService;
    this.greetingCacheService = options.greetingCacheService;
    this.config = options.config;
    this.id = this.telephonyAdapter.id;
    this.inactivity = new VoiceInactivity(
      readInactivityTurns(this.config.voiceBehavior),
      (text) =>
        this.liveProvider.sendText(
          `Fale exatamente a mensagem de inatividade a seguir, sem executar ferramentas: ${JSON.stringify(text)}`,
        ),
      () => {
        void this.executeGracefulTelephonyHangup('inactivity');
      },
      () => this.logger.warn('Inactivity speech timed out'),
    );
  }

  private readonly greetingCacheService?: VoiceGreetingCacheService;

  /**
   * Inicia a sessão completa de voz e IA.
   */
  public async start(): Promise<void> {
    try {
      this.startTime = Date.now();
      const {
        selectedAgent: initialSelectedAgent,
        clientId,
        companyId,
      } = this.config;
      let selectedAgent = initialSelectedAgent;

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
        canal: 'voice',
        origin_channel: 'voice',
        channel: 'voice',
        caller_number: this.telephonyAdapter.metadata.callerNumber,
        caller_name: callerNameClean,
        did_number: this.telephonyAdapter.metadata.didNumber,
        channel_id: this.telephonyAdapter.metadata.channelId,
        nome_agente: fallbackAgentName,
        agent_name: fallbackAgentName,
        // nome_cliente = nome da PESSOA na linha (caller_name limpo, ou
        // sobrescrito pelo mapeamento inbound de variáveis); NUNCA o nome da empresa
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
          canal: 'voice',
          origin_channel: 'voice',
          channel: 'voice',
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
          const conv = await createVoiceConversation(this.prisma, {
            data: {
              company_id: companyId,
              client_id: clientId,
              origin_channel: 'voice',
              status: 'active',
              metadata: convMetadata as any,
            },
          });
          this.conversationId = conv.id;
          this.exportEnabled = conv.exportEnabled;
          this.stopHeartbeat = this.exportEnabled
            ? startVoiceHeartbeat(this.prisma, conv.id)
            : undefined;
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
          this.logger.error(`Erro ao criar conversa ou estado no banco`);
          throw err;
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
          'Define ou atualiza uma variável na telefonia/PBX para o fluxo da chamada ou sistemas externos.',
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
            'Encerra a chamada telefônica atual com o cliente de forma educada e cordial. ' +
            'Use apenas quando a conversa estiver concluída e não houver mais nada a tratar.\n' +
            'REGRAS OBRIGATÓRIAS:\n' +
            '1. Você DEVE se despedir do cliente antes de desligar a chamada.\n' +
            '2. Informe no parâmetro "mensagem_despedida" a sua frase final de despedida ao cliente (ex: "Seu acordo deu certo! Enviei as informações para seu celular. Muito obrigado pelo contato, tenha um excelente dia e até logo!").\n' +
            '3. A chamada só será desconectada após a fala da sua despedida ser concluída.',
          parameters: {
            type: 'OBJECT',
            properties: {
              mensagem_despedida: {
                type: 'STRING',
                description:
                  'Frase verbal de despedida final dita ao cliente antes do encerramento da ligação.',
              },
            },
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
      let pendingAgentTransition: any = null;
      let pendingSwitchTurn: string | null = null;
      const switchTelephonyAgent = async (targetAgent: any) => {
        if (
          this.isEnded ||
          !targetAgent?.id ||
          targetAgent.id === selectedAgent?.id
        )
          return;

        const nativeTools = toolsDeclarations.filter((tool) =>
          ['set_call_variable', 'finalizar_chamada'].includes(tool.name),
        );
        const nextTools =
          this.voiceToolsService && clientId
            ? [
                ...(await this.voiceToolsService.getAgentTools(
                  clientId,
                  targetAgent.id,
                )),
                ...(await this.voiceToolsService.getAgentSubagents(
                  clientId,
                  targetAgent.id,
                )),
              ].map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              }))
            : [];
        const names = new Set<string>();
        toolsDeclarations = [...nextTools, ...nativeTools].filter((tool) => {
          if (!tool.name || names.has(tool.name)) return false;
          names.add(tool.name);
          return true;
        });

        const nextModel =
          this.config.voiceEngine === 'hybrid'
            ? targetAgent.model?.startsWith('gemini-') &&
              !targetAgent.model.includes('live')
              ? targetAgent.model
              : 'gemini-2.5-flash-lite'
            : resolveLiveModel(targetAgent.model || this.config.model);
        const nextVoice =
          this.config.voiceEngine === 'hybrid'
            ? targetAgent.voice_name || this.config.voiceName
            : resolveLiveVoice(targetAgent.voice_name || this.config.voiceName);
        const flowLive =
          this.config.geminiLive && typeof this.config.geminiLive === 'object'
            ? (this.config.geminiLive as Record<string, unknown>)
            : undefined;

        this.telephonyAdapter.clearQueuedAudio?.();
        this.isAiSpeaking = false;
        this.gateSession?.notifyAiSpeakingChanged(false);
        this.inactivity?.stop();
        this.liveProvider.close();
        selectedAgent = targetAgent;
        this.config.agentId = targetAgent.id;
        this.config.selectedAgent = targetAgent;
        this.config.model = nextModel;
        this.config.voiceName = nextVoice;
        this.sessionState.current_agent_id = targetAgent.id;
        pendingSwitchTurn = buildSwitchTurn(
          targetAgent,
          typeof this.sessionState.user_transcript === 'string'
            ? this.sessionState.user_transcript
            : undefined,
          this.sessionState,
        );
        providerOptions.model = nextModel;
        providerOptions.voiceName = nextVoice;
        providerOptions.geminiLive = flowLive
          ? { ...flowLive, model: nextModel, voiceName: nextVoice }
          : undefined;
        providerOptions.allowInterruption = resolveAgentInterruption(targetAgent);
        providerOptions.systemPrompt = buildVoiceSystemPrompt({
          agent: targetAgent,
          agentVariables: this.sessionState,
          fallbackPrompt: 'Você é um assistente de voz inteligente e natural.',
          variables: {
            ...this.sessionState,
            canal: 'voice',
            origin_channel: 'voice',
            channel: 'voice',
          },
        });
        providerOptions.tools = toolsDeclarations.length
          ? [{ functionDeclarations: toolsDeclarations }]
          : undefined;
        await this.liveProvider.connect(providerOptions);
      };
      const resolveAgentInterruption = (agent: any): boolean => {
        if (typeof agent?.allow_interrupted === 'boolean') {
          return agent.allow_interrupted;
        }
        if (
          typeof (this.config.geminiLive as any)?.allowInterruption === 'boolean'
        ) {
          return (this.config.geminiLive as any).allowInterruption;
        }
        return true;
      };
      const providerOptions: VoiceProviderConnectOptions = {
        allowInterruption: resolveAgentInterruption(selectedAgent),
        apiKey: this.config.apiKey || process.env.GEMINI_API_KEY || '',
        inworldApiKey: this.config.inworldApiKey,
        cartesiaApiKey: this.config.cartesiaApiKey,
        groqApiKey: this.config.groqApiKey,
        ttsProvider:
          this.config.ttsProvider === 'inworld'
            ? 'inworld'
            : this.config.ttsProvider === 'custom' && this.config.customTts
              ? 'custom'
              : 'cartesia',
        sttProvider:
          this.config.sttProvider === 'inworld'
            ? 'inworld'
            : this.config.sttProvider === 'custom' && this.config.customStt
              ? 'custom'
              : 'groq',
        customTts: this.config.customTts,
        customStt: this.config.customStt,
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
        geminiLive: this.config.geminiLive,
        voiceSettings: this.config.voiceSettings,
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
          this.inactivity?.start();
          this.config.onEvent?.({
            type: 'flow_telephony_ready',
            channelId: this.id,
            clientId: this.config.clientId,
            agentId: selectedAgent?.id,
            agentName: selectedAgent?.service_step || selectedAgent?.name,
          });
          if (pendingSwitchTurn) {
            const turn = pendingSwitchTurn;
            pendingSwitchTurn = null;
            this.liveProvider.sendText(turn);
          } else {
            this.maybeSendGreeting();
          }
        },
        onAudio: (base64Audio) => {
          const pcm24k = Buffer.from(base64Audio, 'base64');
          this.inactivity?.outputAudio(pcm24k.length);
          if (!this.isAiSpeaking) {
            this.isAiSpeaking = true;
            this.onSpeakingStateChange?.('speaking_ai');
          }
          this.gateSession?.notifyAiSpeakingChanged(true);
          this.liveAudioTap?.('ai', pcm24k, 24000);
          this.telephonyAdapter.sendAudio(pcm24k);
        },
        onAiTranscript: async (text) => {
          if (this.isEnded) return;
          this.config.onEvent?.({
            type: 'flow_telephony_transcript',
            channelId: this.id,
            clientId: this.config.clientId,
            role: 'ai',
            text,
          });
          await this.appendAiTranscript(companyId, text);
        },
        onUserTranscript: async (text) => {
          if (this.isEnded) return;
          this.inactivity?.userActivity();
          this.inactivity?.outputStarted();
          this.config.onEvent?.({
            type: 'flow_telephony_transcript',
            channelId: this.id,
            clientId: this.config.clientId,
            role: 'user',
            text,
          });
          await this.appendUserTranscript(companyId, text);
        },
        onInterrupted: () => {
          if (this.isGreetingPlaying) {
            this.logger.debug(
              '[VoiceCallSession] Interrupção suprimida durante saudação inicial ininterrupta',
            );
            return;
          }
          this.isAiSpeaking = false;
          this.onSpeakingStateChange?.('listening_user');
          this.interruptedCount++;
          this.inactivity?.interrupted();
          // Barge-in: descarta o áudio do Gemini ainda enfileirado para que
          // a IA pare de falar imediatamente (evita cauda obsoleta tocando)
          this.telephonyAdapter.clearQueuedAudio?.();
          this.gateSession?.notifyAiSpeakingChanged(false);
          void this.flushTranscriptBuffers();
        },
        onTurnComplete: () => {
          this.inactivity?.outputComplete();
          this.isAiSpeaking = false;
          this.onSpeakingStateChange?.('listening_user');
          this.gateSession?.notifyAiSpeakingChanged(false);
          void this.flushTranscriptBuffers();

          if (this.pendingAiHangup) {
            setTimeout(() => {
              void this.executeGracefulTelephonyHangup('turn_complete');
            }, 1500);
          }
        },
        onToolCall: (functionCalls) =>
          this.pendingWork.run(async () => {
            if (this.isEnded) return;
            this.inactivity?.outputStarted();
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

            const agentToolsList =
              clientId && selectedAgent?.id && this.voiceToolsService
                ? await this.voiceToolsService
                    .getAgentTools(clientId, selectedAgent.id)
                    .catch(() => [])
                : [];

            for (const call of functionCalls) {
              const matchedTool = agentToolsList.find(
                (candidate) => candidate.name === call.name,
              );
              this.config.onEvent?.({
                type: 'flow_telephony_tool_call',
                channelId: this.id,
                clientId: this.config.clientId,
                name: call.name,
                toolName: matchedTool?.apiName || call.name,
                apiId: matchedTool?.id,
                arguments: call.args || {},
                agentId: selectedAgent?.id,
              });
            }

            let responses: Array<{ id: string; name: string; response: any }>;
            try {
              responses = await Promise.all(
                functionCalls.map(async (call) => {
                  try {
                    if (call.name === 'finalizar_chamada') {
                      const despedida =
                        (call.args?.mensagem_despedida as string) || '';
                      this.logger.log(
                        `📞 [VoiceCallSession] IA solicitou encerramento da chamada ${this.id}. Aguardando conclusão da fala da IA.`,
                      );
                      this.hangupCause = 'ai_requested';
                      this.pendingAiHangup = true;

                      // Watchdog de segurança para não prender o canal da operadora/Asterisk (16s)
                      if (this.hangupWatchdogTimer) {
                        clearTimeout(this.hangupWatchdogTimer);
                      }
                      this.hangupWatchdogTimer = setTimeout(() => {
                        if (this.pendingAiHangup && !this.hangupExecuted) {
                          void this.executeGracefulTelephonyHangup(
                            'watchdog_timeout',
                          );
                        }
                      }, VOICE_HANGUP_WATCHDOG_TIMEOUT_MS);

                      return {
                        id: call.id,
                        name: call.name,
                        response: {
                          ok: true,
                          message: buildVoiceFarewellToolResponse(),
                        },
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
                    const toolCallStarted = Date.now();
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

                    // Persiste a chamada de tool da voz na tabela tool_calls
                    // (não-bloqueante: falha de log não pode derrubar a chamada)
                    if (this.config.companyId) {
                      await this.prisma.tool_calls
                        .create({
                          data: {
                            company_id: this.config.companyId,
                            client_id: clientId,
                            conversation_id: this.conversationId,
                            tool_name: call.name,
                            tool_type: isSubagent ? 'subagent' : 'api',
                            arguments: (call.args || {}) as any,
                            result: (response || {}) as any,
                            status:
                              (response as any)?.ok === false
                                ? 'failed'
                                : 'success',
                            latency_ms: Date.now() - toolCallStarted,
                            error_message:
                              (response as any)?.error ||
                              (response as any)?.message ||
                              null,
                          },
                        })
                        .catch(() => undefined);
                    }

                    if (
                      response &&
                      typeof response === 'object' &&
                      (response as Record<string, unknown>).ok !== false
                    ) {
                      const apiResponse = response as Record<string, any>;
                      const returnedState =
                        apiResponse?.data &&
                        typeof apiResponse.data === 'object'
                          ? apiResponse.data
                          : Object.fromEntries(
                              Object.entries(apiResponse).filter(
                                ([key]) =>
                                  ![
                                    'ok',
                                    'status',
                                    'message',
                                    'error',
                                    '_chainTrail',
                                  ].includes(key),
                              ),
                            );
                      this.sessionState = {
                        ...this.sessionState,
                        ...returnedState,
                      };

                      const matchedTool = agentToolsList.find(
                        (candidate) => candidate.name === call.name,
                      );

                      this.config.onEvent?.({
                        type: 'flow_telephony_tool_response',
                        channelId: this.id,
                        clientId: this.config.clientId,
                        name: call.name,
                        toolName: matchedTool?.apiName || call.name,
                        apiId: matchedTool?.id,
                        response,
                      });

                      // Notifica encadeamento se houver _chainTrail
                      if (Array.isArray(apiResponse?._chainTrail)) {
                        for (const step of apiResponse._chainTrail) {
                          this.config.onEvent?.({
                            type: 'flow_telephony_chaining',
                            channelId: this.id,
                            clientId: this.config.clientId,
                            from: step.from,
                            to: step.to,
                            fromId: step.fromId,
                            toId: step.toId,
                            arguments: step.arguments,
                            response: step.response,
                            timestamp: step.timestamp,
                          });
                        }
                      }

                      // Notifica variáveis de sessão enriquecidas
                      this.config.onEvent?.({
                        type: 'flow_telephony_variables',
                        channelId: this.id,
                        clientId: this.config.clientId,
                        variables: this.sessionState,
                      });

                      // Avalia condição de ativação para transição de agente
                      try {
                        if (this.config.clientId && this.prisma) {
                          const otherAgents =
                            await this.prisma.painel_agents.findMany({
                              where: {
                                client_id: this.config.clientId,
                                id: { not: selectedAgent?.id },
                                is_active: true,
                              },
                              orderBy: { execution_order: 'asc' },
                            });

                          for (const nextAgent of otherAgents) {
                            const conditions =
                              nextAgent.activation_conditions as any;
                            if (conditions) {
                              const evalResult = evaluateConditionsWithDetails(
                                conditions,
                                this.sessionState,
                              );
                              if (evalResult?.matched) {
                                this.logger.log(
                                  `🔄 [VoiceCallSession] Transição de agente ativada: ${selectedAgent?.service_step} ➔ ${nextAgent.service_step}`,
                                );
                                this.config.onEvent?.({
                                  type: 'flow_telephony_agent_switched',
                                  channelId: this.id,
                                  clientId: this.config.clientId,
                                  fromAgent:
                                    selectedAgent?.service_step ||
                                    selectedAgent?.id,
                                  fromAgentId: selectedAgent?.id,
                                  toAgent:
                                    nextAgent.service_step || nextAgent.id,
                                  toAgentId: nextAgent.id,
                                  reason:
                                    'Condição de ativação atendida pelo retorno da API',
                                });
                                pendingAgentTransition ??= nextAgent;
                                break;
                              }
                            }
                          }
                        }
                      } catch (e: any) {
                        this.logger.warn(
                          `Erro ao avaliar transição de agente telefônico: ${e?.message}`,
                        );
                      }
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
            if (!this.isEnded) this.liveProvider.sendToolResponse(responses);
            if (pendingAgentTransition && !this.isEnded) {
              const targetAgent = pendingAgentTransition;
              pendingAgentTransition = null;
              try {
                await switchTelephonyAgent(targetAgent);
              } catch (error) {
                this.logger.error(
                  `Falha ao reconectar agente na chamada ${this.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }),
        onUsageMetadata: (meta) => {
          this.totalTokens = meta.totalTokenCount || 0;
          this.inputTokens = meta.promptTokenCount || 0;
          this.outputTokens =
            meta.responseTokenCount ?? meta.candidatesTokenCount ?? 0;
        },
        onError: (err) => {
          this.logger.error(
            `❌ [VoiceCallSession] Erro no Gemini Live: ${err.message}`,
          );
        },
        onClose: () => {
          this.inactivity?.stop();
          this.logger.log(
            `🛑 [VoiceCallSession] Sessão IA encerrada para chamada ${this.id}`,
          );
        },
      };
      await this.liveProvider.connect(providerOptions);

      // 7. Configura o Transporte de Telefonia
      this.telephonyAdapter.onAudio((pcm16k) => {
        if (!this.isAiSpeaking) this.inactivity?.inputAudio(pcm16k);
        if (this.isEnded) return;
        this.liveAudioTap?.('user', pcm16k, 16000);
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
   * configurada (`greeting_message` ou variações) quando existir.
   *
   * Se houver áudio cacheado no Redis, o buffer PCM é enviado em 0ms direto
   * para o transporte de telefonia, enquanto a IA sincroniza o contexto
   * nos bastidores.
   */
  private async maybeSendGreeting(): Promise<void> {
    if (this.greetingSent) return;
    if (!this.setupCompleted || !this.transportStarted) return;
    const agent = withFlowGreeting(
      this.config.selectedAgent,
      this.config.voiceBehavior,
    );
    if (!aiSpeaksFirstEnabled(agent)) return;
    this.greetingSent = true;
    this.inactivity?.outputStarted();

    this.logger.log(
      `🤖 [VoiceCallSession] IA sauda o cliente primeiro (chamada ${this.id})`,
    );

    // 1. Tenta resolver saudação via VoiceGreetingCacheService se habilitado (opcional)
    const variation = selectVoiceGreetingVariation(agent, this.id);
    const cacheEnabled =
      this.config.voiceBehavior?.greetingCacheEnabled ??
      voiceGreetingCacheEnabled(agent);

    if (
      variation &&
      cacheEnabled &&
      !this.exportEnabled &&
      this.greetingCacheService
    ) {
      try {
        const isHybrid = this.config.voiceEngine === 'hybrid';
        const provider =
          this.config.ttsProvider || (isHybrid ? 'cartesia' : 'google');
        const customTts = this.config.customTts;
        const apiKey =
          provider === 'inworld'
            ? this.config.inworldApiKey || ''
            : provider === 'custom'
              ? customTts?.apiKey || ''
              : isHybrid
                ? this.config.cartesiaApiKey ||
                  process.env.CARTESIA_API_KEY ||
                  ''
                : this.config.apiKey || process.env.GEMINI_API_KEY || '';

        const voiceId =
          provider === 'custom'
            ? customTts?.voice || this.config.voiceName || 'synexa-custom-voice'
            : this.config.voiceName ||
              (isHybrid ? 'cb2694c3-715f-4da9-99f3-1c974fff2928' : 'Aoede');

        const customerName =
          (this.sessionState.nome as string) ||
          (this.sessionState.nome_cliente as string) ||
          (this.sessionState.primeiro_nome as string) ||
          undefined;

        if (apiKey) {
          const res =
            await this.greetingCacheService.resolveOrSynthesizeGreeting({
              companyId: this.config.companyId,
              agentId: this.config.agentId,
              provider,
              voiceId,
              modelId:
                provider === 'inworld'
                  ? 'inworld-tts-2-flash'
                  : isHybrid
                    ? resolveVoiceFlowSettings(this.config.voiceSettings)
                        .cartesiaModel
                    : undefined,
              language: resolveVoiceFlowSettings(this.config.voiceSettings)
                .language,
              template: variation,
              customerName,
              variables: this.sessionState,
              apiKey,
              customTts: provider === 'custom' ? customTts : undefined,
            });

          if (this.isEnded) return;
          if (res.audioBuffer && res.audioBuffer.length > 0) {
            this.logger.log(
              `⚡ [VoiceCallSession] Reproduzindo saudação inicial (${res.fromCache ? 'CACHE 0ms' : 'SÍNTESE'}) | Provedor: ${provider} | Texto: "${res.text}"`,
            );
            this.isAiSpeaking = true;
            this.onSpeakingStateChange?.('speaking_ai');
            this.isGreetingPlaying = true;
            this.liveProvider.setInterruptionBlocked?.(true);
            this.gateSession?.notifyAiSpeakingChanged(true);
            this.liveAudioTap?.('ai', res.audioBuffer, 24000);
            this.telephonyAdapter.sendAudio(res.audioBuffer);
            this.inactivity?.outputAudio(res.audioBuffer.length);
            this.inactivity?.outputComplete();

            void this.appendAiTranscript(this.config.companyId || '', res.text);

            // Registra a saudação no contexto da IA SEM disparar fala proativa
            this.liveProvider.seedGreetingTurn?.(res.text);

            // 24kHz 16-bit mono = 48 bytes/ms + margem de reprodução
            const playbackMs = Math.round(res.audioBuffer.length / 48) + 200;
            setTimeout(() => {
              this.isGreetingPlaying = false;
              this.isAiSpeaking = false;
              this.liveProvider.setInterruptionBlocked?.(false);
              this.gateSession?.notifyAiSpeakingChanged(false);
            }, playbackMs);

            return;
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `⚠️ [VoiceCallSession] Falha ao resolver saudação acelerada: ${err.message}. Seguindo fallback.`,
        );
      }
    }

    // 2. Fallback padrão: envio direto para a LLM / Live Provider
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
      this.config.voiceBehavior,
    );
    if (!limitSec) return;
    this.maxDurationTimer = setTimeout(
      () => void this.enforceMaxCallDuration(limitSec),
      limitSec * 1000,
    );
  }

  /**
   * Encerramento gracioso da telefonia: acionado após a conclusão da despedida verbal da IA.
   */
  private async executeGracefulTelephonyHangup(
    origin = 'turn_complete',
  ): Promise<void> {
    if (this.hangupExecuted || this.isEnded) return;
    this.hangupExecuted = true;
    this.pendingAiHangup = false;
    if (this.hangupWatchdogTimer) {
      clearTimeout(this.hangupWatchdogTimer);
      this.hangupWatchdogTimer = null;
    }
    this.logger.log(
      `📞 [VoiceCallSession] Despedida da IA concluída (${origin}). Desligando canal telefônico da chamada ${this.id}.`,
    );
    try {
      await this.config.onAiHangupRequest?.();
    } catch (err: any) {
      this.logger.warn(`Falha ao solicitar hangup do canal: ${err.message}`);
    }
    try {
      await this.telephonyAdapter.hangup(
        origin === 'inactivity' ? 'inactivity' : 'ai_requested',
      );
    } catch (err: any) {
      this.logger.warn(`Falha no hangup direto do canal: ${err.message}`);
    }
    setTimeout(
      () =>
        void this.end(origin === 'inactivity' ? 'inactivity' : 'ai_requested'),
      800,
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
    this.inactivity?.stop();
    // Descarrega os buffers de transcript antes de encerrar para não perder
    // as últimas frases quando o cliente desliga no meio de um turno.
    await this.pendingWork.drain();
    await this.flushTranscriptBuffers().catch(() =>
      this.logger.error('Transcript flush failed'),
    );
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.hangupWatchdogTimer) {
      clearTimeout(this.hangupWatchdogTimer);
      this.hangupWatchdogTimer = null;
    }
    if (reason) this.hangupCause = String(reason);
    this.releaseSessionSlot();
    const channelId = this.telephonyAdapter.metadata.channelId as
      | string
      | undefined;

    try {
      this.liveProvider.close();
      this.telephonyAdapter.close();

      if (this.conversationId)
        await this.prisma.conversation_state.upsert({
          where: { conversation_id: this.conversationId },
          create: {
            conversation_id: this.conversationId,
            state: this.sessionState as any,
          },
          update: { state: this.sessionState as any },
        });
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
              byoVoice:
                this.config.ttsProvider === 'custom' ||
                this.config.sttProvider === 'custom',
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
            const now = new Date();
            const startedAt = new Date(this.startTime);
            const funnel = extractFunnelFromState(this.sessionState, now);

            await this.prisma.painel_interactions.upsert({
              where: { session_id: this.conversationId },
              create: {
                company_id: this.config.companyId,
                client_id: this.config.clientId,
                agent_id: this.config.agentId || null,
                agent_name: (this.sessionState?.nome_agente as string) || null,
                session_id: this.conversationId,
                channel: this.config.channel || 'voice_sip',
                direction: 'inbound',
                interaction_mode: 'voice',
                client_identifier: funnel.client_identifier,
                client_name: funnel.client_name,
                has_human_answer: true,
                human_answered_at: startedAt,
                is_right_party: funnel.is_right_party,
                right_party_at: funnel.right_party_at,
                is_debt_presented: funnel.is_debt_presented,
                debt_presented_at: funnel.debt_presented_at,
                debt_amount:
                  funnel.debt_amount !== null
                    ? (funnel.debt_amount as any)
                    : null,
                is_agreement_reached: funnel.is_agreement_reached,
                agreement_at: funnel.agreement_at,
                agreement_id: funnel.agreement_id,
                agreement_amount:
                  funnel.agreement_amount !== null
                    ? (funnel.agreement_amount as any)
                    : null,
                is_promise_to_pay: funnel.is_promise_to_pay,
                promise_to_pay_at: funnel.promise_to_pay_at,
                promise_due_date: funnel.promise_due_date,
                promise_amount:
                  funnel.promise_amount !== null
                    ? (funnel.promise_amount as any)
                    : null,
                disposition: funnel.disposition,
                barge_in_count: this.interruptedCount,
                duration_seconds: durationSeconds,
                billable_seconds: durationSeconds,
                total_tokens: this.totalTokens,
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                estimated_cost_usd: rawCost as any,
                llm_model: this.config.model || 'gemini-2.0-flash-exp',
                hangup_cause: this.hangupCause || null,
                context_variables: (this.sessionState || {}) as any,
                started_at: startedAt,
                ended_at: now,
                status: 'completed',
              },
              update: {
                client_identifier: funnel.client_identifier || undefined,
                client_name: funnel.client_name || undefined,
                has_human_answer: true,
                is_right_party: funnel.is_right_party,
                right_party_at: funnel.right_party_at || undefined,
                is_debt_presented: funnel.is_debt_presented,
                debt_presented_at: funnel.debt_presented_at || undefined,
                debt_amount:
                  funnel.debt_amount !== null
                    ? (funnel.debt_amount as any)
                    : undefined,
                is_agreement_reached: funnel.is_agreement_reached,
                agreement_at: funnel.agreement_at || undefined,
                agreement_id: funnel.agreement_id || undefined,
                agreement_amount:
                  funnel.agreement_amount !== null
                    ? (funnel.agreement_amount as any)
                    : undefined,
                is_promise_to_pay: funnel.is_promise_to_pay,
                promise_to_pay_at: funnel.promise_to_pay_at || undefined,
                promise_due_date: funnel.promise_due_date || undefined,
                promise_amount:
                  funnel.promise_amount !== null
                    ? (funnel.promise_amount as any)
                    : undefined,
                disposition: funnel.disposition,
                barge_in_count: this.interruptedCount,
                duration_seconds: durationSeconds,
                billable_seconds: durationSeconds,
                total_tokens: this.totalTokens,
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                estimated_cost_usd: rawCost as any,
                hangup_cause: this.hangupCause || undefined,
                context_variables: (this.sessionState || {}) as any,
                ended_at: now,
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
      this.logger.error(`Erro ao finalizar sessão de voz`);
    } finally {
      this.stopHeartbeat?.();
      if (this.conversationId)
        await finalizeVoiceConversation(this.prisma, this.conversationId).catch(
          () => this.logger.error('Voice finalization persistence failed'),
        );
    }
  }
}
