import { Logger } from '@nestjs/common';
import { ITelephonyAdapter } from '../adapters/telephony-adapter.interface';
import { GeminiLiveVoiceProvider } from '../providers/gemini-live-voice.provider';
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
import { buildVoiceSystemPrompt } from '../services/voice-runtime.util';

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
  /** Config de audio gate resolvida (por padrão usa valores do cliente/env) */
  gateConfig?: VoiceGateRuntimeConfig;
  /** Canal usado na sincronização com painel_interactions (ex: voice_sip, voice_webrtc) */
  channel?: string;
  /**
   * Handler chamado quando a IA solicita o encerramento da chamada
   * (tool `finalizar_chamada`). Ex: AMI hangupChannel no Asterisk.
   */
  onAiHangupRequest?: () => Promise<void> | void;
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
  private liveProvider: GeminiLiveVoiceProvider;
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

  constructor(options: {
    telephonyAdapter: ITelephonyAdapter;
    liveProvider: GeminiLiveVoiceProvider;
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
        this.logger.warn(`Erro ao buscar regras de mapeamento: ${err.message}`);
      }
    }

    const fallbackAgentName =
      clientAgentName ||
      (selectedAgent as any)?.agent_name ||
      (selectedAgent as any)?.name ||
      'Maria';
    const fallbackCompanyName = clientCompanyName || 'Cliente';

    const rawContextVariables: Record<string, any> = {
      ...(this.telephonyAdapter.metadata.customVariables || {}),
      caller_number: this.telephonyAdapter.metadata.callerNumber,
      caller_name: this.telephonyAdapter.metadata.callerName,
      did_number: this.telephonyAdapter.metadata.didNumber,
      channel_id: this.telephonyAdapter.metadata.channelId,
      nome_agente: fallbackAgentName,
      agent_name: fallbackAgentName,
      nome_cliente: fallbackCompanyName,
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
        nome_cliente: contextVariables.nome_cliente || fallbackCompanyName,
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
      model: this.config.model || 'gemini-2.0-flash-exp',
      voiceName: this.config.voiceName || 'Aoede',
      systemPrompt,
      tools: toolsDeclarations.length
        ? [{ functionDeclarations: toolsDeclarations }]
        : undefined,
      onSetupComplete: () => {
        this.logger.log(
          `🎙️ [VoiceCallSession] Provedor de IA conectado para chamada ${this.id}`,
        );
      },
      onAudio: (base64Audio) => {
        const pcm24k = Buffer.from(base64Audio, 'base64');
        this.isAiSpeaking = true;
        this.gateSession?.notifyAiSpeakingChanged(true);
        this.telephonyAdapter.sendAudio(pcm24k);
      },
      onAiTranscript: async (text) => {
        if (this.conversationId && companyId && text) {
          try {
            await this.prisma.messages.create({
              data: {
                conversation_id: this.conversationId,
                company_id: companyId,
                sender_type: 'ai',
                channel: 'voice',
                direction: 'outbound',
                content: text,
              },
            });
          } catch {
            // Silencioso em caso de log
          }
        }
      },
      onUserTranscript: async (text) => {
        if (this.conversationId && companyId && text) {
          try {
            await this.prisma.messages.create({
              data: {
                conversation_id: this.conversationId,
                company_id: companyId,
                sender_type: 'customer',
                channel: 'voice',
                direction: 'inbound',
                content: text,
              },
            });
          } catch {
            // Silencioso em caso de log
          }
        }
      },
      onInterrupted: () => {
        this.isAiSpeaking = false;
        this.interruptedCount++;
        // Barge-in: descarta o áudio do Gemini ainda enfileirado para que
        // a IA pare de falar imediatamente (evita cauda obsoleta tocando)
        this.telephonyAdapter.clearQueuedAudio?.();
        this.gateSession?.notifyAiSpeakingChanged(false);
      },
      onTurnComplete: () => {
        this.isAiSpeaking = false;
        this.gateSession?.notifyAiSpeakingChanged(false);
      },
      onToolCall: async (functionCalls) => {
        if (!clientId || !selectedAgent?.id) return;
        const responses = await Promise.all(
          functionCalls.map(async (call) => {
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
              if (varName && varVal && this.telephonyAdapter.setVariable) {
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
                response: { ok: false, error: 'Tools service unavailable' },
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
                          !['ok', 'status', 'message', 'error'].includes(key),
                      ),
                    );
              this.sessionState = { ...this.sessionState, ...returnedState };
            }

            return { id: call.id, name: call.name, response };
          }),
        );
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
  }

  /**
   * Encerra a sessão, desliga o canal e persiste telemetria.
   */
  public async end(reason?: string): Promise<void> {
    if (this.isEnded) return;
    this.isEnded = true;
    if (reason) this.hangupCause = String(reason);
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
      const rawCost = this.pricingService.calculateVoiceLiveCost({
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
