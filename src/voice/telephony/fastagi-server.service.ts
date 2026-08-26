import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import * as readline from 'readline';
import { RtpGatewayService } from './rtp-gateway.service';
import { AsteriskAmiService } from './asterisk-ami.service';
import { AudioGateService } from '../services/audio-gate.service';
import { HybridSttService } from '../services/hybrid-stt.service';
import { GeminiLiveVoiceProvider } from '../providers/gemini-live-voice.provider';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';

import { AsteriskFastAgiAdapter } from '../adapters/asterisk/asterisk-fastagi.adapter';
import { buildAgentPromptFromBlocks } from '../../agents/utils/agent-prompt-builder.util';
import {
  InboundDataMapperService,
  InboundMappingConfig,
} from '../../common/services/inbound-data-mapper.service';

export interface FastAgiEnv {
  agi_channel?: string;
  agi_uniqueid?: string;
  agi_callerid?: string;
  agi_calleridname?: string;
  agi_extension?: string;
  agi_arg_1?: string; // Cellphone
  agi_arg_2?: string; // Company Phone / DID
  agi_arg_3?: string; // Client ID / Persona ID / JSON variables
  [key: string]: string | undefined;
}

@Injectable()
export class FastAgiServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FastAgiServerService.name);
  private server: net.Server | null = null;
  private port: number;
  private enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly rtpGatewayService: RtpGatewayService,
    private readonly amiService: AsteriskAmiService,
    private readonly audioGateService: AudioGateService,
    private readonly hybridSttService: HybridSttService,
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
    private readonly inboundDataMapper: InboundDataMapperService,
  ) {
    this.port = this.configService.get<number>('FASTAGI_PORT') || 4573;
    this.enabled =
      this.configService.get<boolean>('FASTAGI_ENABLED') ?? false;
  }

  public onModuleInit(): void {
    if (this.enabled) {
      this.start();
    } else {
      this.logger.log('ℹ️ [FastAGI] Servidor FastAGI desativado (FASTAGI_ENABLED=false)');
    }
  }

  public onModuleDestroy(): void {
    this.stop();
  }

  public start(): void {
    if (this.server) return;

    this.server = net.createServer((socket) => {
      this.handleSocketConnection(socket);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(`📞 [FastAGI] Servidor TCP escutando em 0.0.0.0:${this.port}`);
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.log('🛑 [FastAGI] Servidor FastAGI encerrado');
    }
  }

  private handleSocketConnection(socket: net.Socket): void {
    const agiEnv: FastAgiEnv = {};
    const rl = readline.createInterface({
      input: socket,
      output: socket,
      terminal: false,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') {
        rl.removeAllListeners('line');
        this.processAgiCall(socket, agiEnv).catch((err) => {
          this.logger.error(`❌ [FastAGI] Erro ao processar chamada: ${err.message}`);
          socket.end();
        });
      } else {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const key = trimmed.substring(0, colonIdx).trim();
          const val = trimmed.substring(colonIdx + 1).trim();
          agiEnv[key] = val;
        }
      }
    });

    socket.on('error', (err) => {
      this.logger.warn(`[FastAGI] Erro no socket TCP: ${err.message}`);
    });
  }

  private async processAgiCall(
    socket: net.Socket,
    agiEnv: FastAgiEnv,
  ): Promise<void> {
    const adapter = new AsteriskFastAgiAdapter(socket, agiEnv);
    const channel = adapter.metadata.channelId || 'SIP/default';
    const uniqueId = adapter.metadata.uniqueId || `agi_${Date.now()}`;
    const callerId = adapter.metadata.callerNumber || 'anonymous';
    const didNumber = adapter.metadata.didNumber || 'default';
    const customVariables = adapter.metadata.customVariables || {};

    this.logger.log(
      `📞 [FastAGI] Chamada recebida | canal=${channel} | caller=${callerId} | did=${didNumber} | vars=${JSON.stringify(customVariables)}`,
    );

    // 1. Busca configurações da empresa/cliente e agente no banco
    const targetClientId = (customVariables.SYNEXA_CLIENT_ID as string) || undefined;
    const client = targetClientId
      ? await this.prisma.painel_clients.findUnique({
          where: { id: targetClientId },
          include: { companies: true },
        })
      : await this.prisma.painel_clients.findFirst({
          include: { companies: true },
        });

    const companyId = client?.company_id;
    const clientId = client?.id;

    // Busca agente configurado ou step especificado no dialplan
    const targetAgentStep = (customVariables.SYNEXA_AGENT_STEP as string) || undefined;
    const selectedAgent = clientId
      ? await this.prisma.painel_agents.findFirst({
          where: {
            client_id: clientId,
            ...(targetAgentStep ? { service_step: targetAgentStep } : { is_active: true }),
          },
        })
      : null;

    if (selectedAgent?.interaction_mode === 'text') {
      this.logger.warn(
        `[FastAGI] Chamada recusada: agente ${selectedAgent.service_step || selectedAgent.id} aceita somente texto`,
      );
      await adapter.hangup('agent_text_only');
      await adapter.close();
      return;
    }

    // 2. Mapeia e Constrói o Prompt interpolando variáveis do Asterisk / Discador
    const clientMeta = (client?.metadata as Record<string, unknown>) || {};
    const inboundConfig =
      (clientMeta.inbound_variable_mapping as InboundMappingConfig) || undefined;

    const rawInbound = {
      ...customVariables,
      caller_number: callerId,
      caller_name: adapter.metadata.callerName,
      did_number: didNumber,
      channel,
    };

    const combinedVariables = this.inboundDataMapper.mapInboundData(
      rawInbound,
      inboundConfig,
      'voice',
    );

    const systemPrompt = selectedAgent
      ? buildAgentPromptFromBlocks(selectedAgent as any, combinedVariables)
      : 'Você é um assistente de voz inteligente do Synexa atendendo uma ligação telefônica. Seja natural, objetivo e prestativo.';

    // 3. Inicializa Conversa Omnichannel no Synexa
    let conversationId: string | null = null;
    if (companyId) {
      const conv = await this.prisma.conversations.create({
        data: {
          company_id: companyId,
          client_id: clientId,
          origin_channel: 'voice',
          status: 'active',
          metadata: {
            telephony: 'asterisk_fastagi',
            asterisk_unique_id: uniqueId,
            channel,
            caller: callerId,
            did: didNumber,
            context_variables: combinedVariables,
            agent_id: selectedAgent?.id,
          } as any,
        },
      });
      conversationId = conv.id;

      // Persiste variáveis mapeadas no estado da conversa
      try {
        await this.prisma.conversation_state.upsert({
          where: { conversation_id: conv.id },
          create: {
            conversation_id: conv.id,
            state: combinedVariables as any,
          },
          update: {
            state: combinedVariables as any,
          },
        });
      } catch (err: any) {
        this.logger.warn(`Erro ao persistir conversation_state FastAGI: ${err.message}`);
      }
    }

    // 4. Inicializa componentes de Áudio e IA
    const gateSession = this.audioGateService.createSession({
      enabled: client?.audio_gate_enabled ?? true,
      threshold: client?.audio_gate_threshold ?? 500,
      hangoverMarginMs: client?.audio_gate_hangover_margin_ms ?? 500,
      prerollMs: client?.audio_gate_preroll_ms ?? 300,
      sampleRate: 16000,
    });

    const liveProvider = new GeminiLiveVoiceProvider();
    let isAiSpeaking = false;
    let interruptedCount = 0;
    const startTime = Date.now();
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // 5. Cria Sessão RTP UDP
    const rtpSession = this.rtpGatewayService.createSession({
      onPcmAudioIn: (pcm16Base64) => {
        const { forwardChunks, shouldSendStreamEnd } =
          gateSession.processChunk(pcm16Base64, isAiSpeaking);

        for (const chunk of forwardChunks) {
          liveProvider.sendAudio(chunk);
        }
        if (shouldSendStreamEnd) {
          liveProvider.sendAudioStreamEnd();
        }
      },
      onClose: () => {
        liveProvider.close();
      },
    });

    await rtpSession.start();
    await adapter.start();

    // 6. Conecta ao Gemini Live
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      '';

    if (apiKey) {
      liveProvider.connect({
        apiKey,
        systemPrompt,
        voiceName: selectedAgent?.voice_name || client?.voice_name || 'Aoede',
        onAudio: (base64Pcm24) => {
          isAiSpeaking = true;
          gateSession.notifyAiSpeakingChanged(true);
          const pcmBuf = Buffer.from(base64Pcm24, 'base64');
          rtpSession.enqueuePcmOut(pcmBuf);
        },
        onTurnComplete: () => {
          isAiSpeaking = false;
          gateSession.notifyAiSpeakingChanged(false);
        },
        onInterrupted: () => {
          isAiSpeaking = false;
          interruptedCount++;
          gateSession.notifyAiSpeakingChanged(false);
        },
        onToolCall: async (calls) => {
          for (const call of calls) {
            if (call.name === 'finalizar_chamada') {
              this.logger.log('📞 [FastAGI] IA solicitou encerramento da chamada');
              await this.amiService.hangupChannel(channel);
            } else if (call.name === 'set_variable') {
              const varName = call.args?.name;
              const varVal = call.args?.value;
              if (varName && varVal) {
                adapter.setVariable(String(varName), String(varVal));
              }
            }
          }
        },
        onUsageMetadata: (meta) => {
          totalTokens = meta.totalTokenCount || 0;
          inputTokens = meta.promptTokenCount || 0;
          outputTokens = meta.candidatesTokenCount || 0;
        },
      });
    }

    // Ao fechar o socket TCP (hangup do Asterisk)
    socket.on('close', async () => {
      this.logger.log(`🔴 [FastAGI] Canal ${channel} finalizado`);
      rtpSession.close();
      liveProvider.close();

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      const stats = gateSession.getStats();

      if (conversationId && companyId) {
        try {
          await this.prisma.conversations.update({
            where: { id: conversationId },
            data: {
              status: 'closed',
              closed_at: new Date(),
            },
          });

          const rawCost = this.pricingService.calculateVoiceLiveCost({
            durationSeconds: durationSec,
            inputTokens,
            outputTokens,
          });

          await this.prisma.voice_session_telemetry.create({
            data: {
              company_id: companyId,
              client_id: clientId,
              conversation_id: conversationId,
              asterisk_unique_id: uniqueId,
              caller_number: callerId,
              did_number: didNumber,
              duration_sec: durationSec,
              audio_gate_forwarded_sec: stats.forwardedSec,
              audio_gate_suppressed_sec: stats.suppressedSec,
              audio_gate_closes: stats.closes,
              interrupted_count: interruptedCount,
              total_tokens: totalTokens,
              audio_input_tokens: inputTokens,
              audio_output_tokens: outputTokens,
              cost_usd: rawCost,
              cost_brl: Number((rawCost * 5.5).toFixed(4)),
              audio_gate_enabled: client?.audio_gate_enabled ?? true,
            },
          });
        } catch (err: any) {
          this.logger.warn(`Erro ao persistir telemetria FastAGI: ${err.message}`);
        }
      }
    });
  }
}
