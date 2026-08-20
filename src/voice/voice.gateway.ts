import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket, WebSocketServer as WsServer } from 'ws';
import { VoiceService } from './voice.service';

const GOOGLE_LIVE_API_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface ClientSession {
  clientWs: WebSocket;
  googleWs: WebSocket | null;
  isGoogleReady: boolean;
}

@WebSocketGateway({ path: '/ws/voice' })
export class VoiceGateway
  implements OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(VoiceGateway.name);
  private sessions = new Map<WebSocket, ClientSession>();

  @WebSocketServer()
  server: WsServer;

  constructor(private readonly voiceService: VoiceService) {}

  handleConnection(clientWs: WebSocket) {
    this.logger.log('🟢 [VoiceGateway] Cliente conectado');

    const session: ClientSession = {
      clientWs,
      googleWs: null,
      isGoogleReady: false,
    };
    this.sessions.set(clientWs, session);

    const sendToClient = (payload: any) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const closeGoogleSession = () => {
      if (session.googleWs) {
        const wsToClose = session.googleWs;
        session.googleWs = null;
        session.isGoogleReady = false;
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
            closeGoogleSession();
            const serverApiKey = this.voiceService.getGeminiApiKey();
            const clientApiKey = msg.apiKey && String(msg.apiKey).trim();
            const apiKey =
              clientApiKey &&
              !clientApiKey.startsWith('AIzaSyA2lDfZkwpZtPI7WnTobaM0T9B6iFoXFiY')
                ? clientApiKey
                : serverApiKey;

            if (!apiKey) {
              sendToClient({
                type: 'error',
                message:
                  'GEMINI_API_KEY não configurada no backend ou no painel de configuração do Synexa.',
              });
              return;
            }

            const model = msg.model || this.voiceService.getDefaultModel();
            const voice = msg.voice || this.voiceService.getDefaultVoice();
            const systemPrompt =
              msg.systemPrompt ||
              'Você é um assistente virtual Synexa prestativo, educado e inteligente falando em português do Brasil.';

            this.logger.log(
              `🔗 [Live API] Conectando ao Gemini Live... | Modelo: ${model} | Voz: ${voice}`,
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
                  sendToClient({
                    type: 'usage',
                    metadata: googleMsg.usageMetadata,
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

            googleWs.on('close', (code: number, reason: any) => {
              const reasonStr = reason
                ? Buffer.isBuffer(reason)
                  ? reason.toString('utf-8')
                  : String(reason)
                : 'sem motivo';
              this.logger.warn(
                `🔌 [Google WS] Conexão encerrada | Código: ${code} | Motivo: ${reasonStr}`,
              );
              session.isGoogleReady = false;
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
            closeGoogleSession();
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

    clientWs.on('close', () => {
      this.logger.log('🔴 [VoiceGateway] Cliente desconectado');
      closeGoogleSession();
      this.sessions.delete(clientWs);
    });
  }

  handleDisconnect(clientWs: WebSocket) {
    const session = this.sessions.get(clientWs);
    if (session) {
      if (session.googleWs) {
        try {
          session.googleWs.close();
        } catch (_) {}
      }
      this.sessions.delete(clientWs);
    }
  }
}
