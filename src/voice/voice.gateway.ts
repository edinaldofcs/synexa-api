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
import { PrismaService } from '../common/prisma/prisma.service';
import { ModelPricingService } from '../orchestrator/services/model-pricing.service';

const GOOGLE_LIVE_API_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface ClientSession {
  clientWs: WebSocket;
  googleWs: WebSocket | null;
  mockSession?: {
    handleClientMessage: (msg: any) => void;
    close: () => void;
  } | null;
  isGoogleReady: boolean;
  companyId?: string;
  clientId?: string;
  startTime: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
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
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
  ) {}

  handleConnection(clientWs: WebSocket) {
    this.logger.log('🟢 [VoiceGateway] Cliente conectado');

    const session: ClientSession = {
      clientWs,
      googleWs: null,
      isGoogleReady: false,
      startTime: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: 'gemini-3.1-flash-live-preview',
    };
    this.sessions.set(clientWs, session);

    const sendToClient = (payload: any) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

  const persistVoiceUsage = async () => {
      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - session.startTime) / 1000),
      );

      if (session.companyId && session.clientId && session.totalTokens > 0) {
        try {
          const rawCost = this.pricingService.calculateVoiceLiveCost({
            durationSeconds,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          });

          await this.prisma.agent_runs.create({
            data: {
              company_id: session.companyId,
              client_id: session.clientId,
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
              } as any,
            },
          });

          this.logger.log(
            `📊 [VoiceGateway] Consumo de voz registrado: ${durationSeconds}s, ${session.totalTokens} tokens, Custo: $${rawCost}`,
          );
        } catch (err: any) {
          this.logger.error(
            `Erro ao persistir métricas de voz: ${err.message}`,
          );
        }
      }
    };

    const closeGoogleSession = async () => {
      if (session.googleWs) {
        const wsToClose = session.googleWs;
        session.googleWs = null;
        session.isGoogleReady = false;

        await persistVoiceUsage();

        try {
          wsToClose.on('error', () => {});
          if (
            wsToClose.readyState === WebSocket.OPEN ||
            wsToClose.readyState === WebSocket.CONNECTING
          ) {
            wsToClose.close();
          }
          wsToClose.removeAllListeners('open');
          wsToClose.removeAllListeners('message');
          wsToClose.removeAllListeners('close');
        } catch (err: any) {
          this.logger.error(
            `Erro ao fechar conexão com Google: ${err.message}`,
          );
        }
      }
    };

    clientWs.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case 'start': {
            const accessToken =
              typeof msg.accessToken === 'string'
                ? msg.accessToken
                : typeof msg.access_token === 'string'
                  ? msg.access_token
                  : '';

            let authenticatedUser;
            try {
              authenticatedUser = await this.voiceAuthService.authenticate(
                accessToken,
              );
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
                message: 'Autenticação necessária para iniciar a sessão de voz.',
              });
              clientWs.close(1008, 'Unauthorized');
              return;
            }

            await closeGoogleSession();
            if (session.mockSession) {
              session.mockSession.close();
              session.mockSession = null;
            }

            session.startTime = Date.now();
            session.companyId = authenticatedUser.company_id;
            session.inputTokens = 0;
            session.outputTokens = 0;
            session.totalTokens = 0;

            const voiceProvider = this.configService.get<string>(
              'VOICE_PROVIDER',
              'gemini',
            );
            const serverApiKey = this.voiceService.getGeminiApiKey();
            const apiKey = serverApiKey;

            if (
              voiceProvider === 'mock' ||
              (!apiKey &&
                this.configService.get('ENVIRONMENT') === 'development')
            ) {
              this.logger.log(
                '🎙️ [VoiceGateway] Iniciando em Modo Mock (Voz simulada)',
              );
              session.mockSession = this.mockVoiceProvider.handleMockSession(
                clientWs,
                sendToClient,
              );
              return;
            }

            if (!apiKey) {
              sendToClient({
                type: 'error',
                message:
                  'GEMINI_API_KEY não configurada no backend. Por favor, adicione GEMINI_API_KEY no arquivo .env.',
              });
              return;
            }

            const model = msg.model || this.voiceService.getDefaultModel();
            const voice = msg.voice || this.voiceService.getDefaultVoice();
            session.model = model;

            const systemPrompt =
              msg.systemPrompt ||
              'Você é a Helena, assistente de voz do Synexa. Fale de forma prestativa, educada, natural e inteligente em português do Brasil.';

            this.logger.log(
              `🔗 [Live API] Conectando ao Gemini Live... | Modelo: ${model} | Voz: ${voice} (Plug & Play Managed)`,
            );
            sendToClient({ type: 'status', state: 'connecting' });

            const googleUrl = `${GOOGLE_LIVE_API_URL}?key=${apiKey}`;
            const googleWs = new WebSocket(googleUrl);
            session.googleWs = googleWs;

            googleWs.on('error', (err: any) => {
              this.logger.error(`❌ [Google WS] Erro: ${err.message}`);
              sendToClient({
                type: 'error',
                message: `Erro no WebSocket do Gemini Live: ${err.message}`,
              });
            });

            googleWs.on('open', () => {
              this.logger.log(
                '✅ [Google WS] Conexão estabelecida com Google Live API. Enviando setup...',
              );
              const setupMessage = {
                setup: {
                  model: `models/${model}`,
                  generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                      voiceConfig: {
                        prebuiltVoiceConfig: {
                          voiceName: voice,
                        },
                      },
                      languageCode: 'pt-BR',
                    },
                  },
                  systemInstruction: {
                    parts: [{ text: systemPrompt }],
                  },
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                  realtimeInputConfig: {
                    automaticActivityDetection: {
                      disabled: false,
                      silenceDurationMs: 500,
                    },
                  },
                },
              };
              googleWs.send(JSON.stringify(setupMessage));
            });

            googleWs.on('message', (googleData: any) => {
              try {
                const googleMsg = JSON.parse(googleData.toString());

                if (googleMsg.setupComplete) {
                  this.logger.log(
                    '🎉 [Google WS] Setup concluído! Sessão de voz Synexa pronta.',
                  );
                  session.isGoogleReady = true;
                  sendToClient({ type: 'status', state: 'connected' });
                  return;
                }

                if (googleMsg.usageMetadata) {
                  const usage = googleMsg.usageMetadata;
                  session.inputTokens += usage.promptTokenCount || 0;
                  session.outputTokens += usage.candidatesTokenCount || 0;
                  session.totalTokens += usage.totalTokenCount || 0;

                  sendToClient({
                    type: 'usage',
                    metadata: usage,
                  });
                }

                if (googleMsg.serverContent) {
                  const content = googleMsg.serverContent;
                  if (content.interrupted) {
                    this.logger.log(
                      '⚡ [Barge-in] Modelo interrompido pela fala do usuário',
                    );
                    sendToClient({ type: 'interrupted' });
                  }
                  if (content.turnComplete) {
                    sendToClient({ type: 'turn_complete' });
                  }
                  if (content.inputTranscription?.text) {
                    sendToClient({
                      type: 'transcription',
                      role: 'user',
                      text: content.inputTranscription.text,
                    });
                  }
                  if (content.outputTranscription?.text) {
                    sendToClient({
                      type: 'transcription',
                      role: 'ai',
                      text: content.outputTranscription.text,
                    });
                  }
                  if (content.modelTurn?.parts) {
                    for (const part of content.modelTurn.parts) {
                      if (part.inlineData?.data) {
                        sendToClient({
                          type: 'audio',
                          data: part.inlineData.data,
                        });
                      }
                    }
                  }
                }
              } catch (err: any) {
                this.logger.error(
                  `Erro ao processar mensagem do Google: ${err.message}`,
                );
              }
            });

            googleWs.on('close', async (code: number, reason: any) => {
              const reasonStr = reason
                ? Buffer.isBuffer(reason)
                  ? reason.toString('utf-8')
                  : String(reason)
                : 'sem motivo';
              this.logger.warn(
                `🔌 [Google WS] Conexão encerrada | Código: ${code} | Motivo: ${reasonStr}`,
              );
              session.isGoogleReady = false;
              await persistVoiceUsage();

              if (code !== 1000 && reasonStr && reasonStr !== 'sem motivo') {
                sendToClient({
                  type: 'error',
                  message: `Conexão com Gemini Live encerrada (${code}): ${reasonStr}`,
                });
              }
              sendToClient({
                type: 'status',
                state: 'disconnected',
                reason: reasonStr,
              });
            });
            break;
          }

          case 'audio': {
            if (session.mockSession) {
              session.mockSession.handleClientMessage(msg);
              break;
            }
            if (
              session.googleWs &&
              session.isGoogleReady &&
              session.googleWs.readyState === WebSocket.OPEN
            ) {
              session.googleWs.send(
                JSON.stringify({
                  realtimeInput: {
                    audio: {
                      mimeType: 'audio/pcm;rate=16000',
                      data: msg.data,
                    },
                  },
                }),
              );
            }
            break;
          }

          case 'text': {
            if (session.mockSession) {
              session.mockSession.handleClientMessage(msg);
              break;
            }
            if (
              session.googleWs &&
              session.isGoogleReady &&
              session.googleWs.readyState === WebSocket.OPEN
            ) {
              this.logger.log(
                `📝 [Texto] Enviando texto para o Gemini: "${msg.text}"`,
              );
              session.googleWs.send(
                JSON.stringify({
                  realtimeInput: {
                    text: msg.text,
                  },
                }),
              );
            }
            break;
          }

          case 'stop': {
            this.logger.log('🛑 [VoiceGateway] Encerrando chamada solicitada');
            if (session.mockSession) {
              session.mockSession.close();
              session.mockSession = null;
            }
            await closeGoogleSession();
            sendToClient({ type: 'status', state: 'disconnected' });
            break;
          }

          default:
            this.logger.warn(
              `[VoiceGateway] Tipo de mensagem não reconhecido: ${msg.type}`,
            );
        }
      } catch (err: any) {
        this.logger.error(
          `Erro ao processar mensagem do cliente: ${err.message}`,
        );
      }
    });

    clientWs.on('close', async () => {
      this.logger.log('🔴 [VoiceGateway] Cliente desconectado');
      if (session.mockSession) {
        session.mockSession.close();
        session.mockSession = null;
      }
      await closeGoogleSession();
      this.sessions.delete(clientWs);
    });
  }

  async handleDisconnect(clientWs: WebSocket) {
    const session = this.sessions.get(clientWs);
    if (session) {
      if (session.mockSession) {
        session.mockSession.close();
      }
      if (session.googleWs) {
        try {
          session.googleWs.close();
        } catch (_) {}
      }
      this.sessions.delete(clientWs);
    }
  }
}
