import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';

@Injectable()
export class MockVoiceProvider {
  private readonly logger = new Logger(MockVoiceProvider.name);

  constructor(private readonly configService: ConfigService) {}

  createSession(callbacks: {
    onAudio: (data: string) => void;
    onUserTranscript: (text: string) => void;
    onAiTranscript: (text: string) => void;
    onTurnComplete: () => void;
    onError: (err: any) => void;
  }) {
    this.logger.log(
      '🎙️ [MockVoiceProvider] Iniciando sessão simulada de voz (createSession)',
    );
    let audioDebounceTimer: NodeJS.Timeout | null = null;
    let receivedAudioChunks = 0;

    setTimeout(() => {
      callbacks.onAiTranscript(
        'Olá! Sou o assistente no modo simulado local. Para conversar com voz real via IA, configure VOICE_PROVIDER=gemini com uma GEMINI_API_KEY válida.',
      );
      callbacks.onTurnComplete();
    }, 100);

    return {
      handleClientMessage: (msg: any) => {
        if (msg.type === 'audio') {
          receivedAudioChunks++;
          if (audioDebounceTimer) clearTimeout(audioDebounceTimer);
          audioDebounceTimer = setTimeout(() => {
            if (receivedAudioChunks > 2) {
              callbacks.onUserTranscript('(Áudio captado pelo microfone)');
              setTimeout(() => {
                callbacks.onAiTranscript(
                  'Recebi sua fala! (Modo Mock ativo: áudio simulado sem chamada de API externa).',
                );
                callbacks.onTurnComplete();
              }, 200);
            }
            receivedAudioChunks = 0;
          }, 500);
        } else if (msg.type === 'text') {
          callbacks.onUserTranscript(msg.text || '');
          setTimeout(() => {
            callbacks.onAiTranscript(`Resposta simulada para: "${msg.text}"`);
            callbacks.onTurnComplete();
          }, 100);
        }
      },
      close: () => {
        if (audioDebounceTimer) {
          clearTimeout(audioDebounceTimer);
          audioDebounceTimer = null;
        }
        this.logger.log('🎙️ [MockVoiceProvider] Sessão mock encerrada');
      },
    };
  }

  handleMockSession(clientWs: WebSocket, sendToClient: (payload: any) => void) {
    this.logger.log('🎙️ [MockVoiceProvider] Iniciando sessão simulada de voz');

    const latencyMs = this.configService.get<number>(
      'MOCK_VOICE_LATENCY_MS',
      40,
    );

    let audioDebounceTimer: NodeJS.Timeout | null = null;
    let receivedAudioChunks = 0;

    // Mensagem de boas-vindas inicial da sessão simulada
    setTimeout(() => {
      sendToClient({ type: 'status', state: 'connected' });
      sendToClient({
        type: 'transcription',
        role: 'ai',
        text: 'Olá! Sou a Helena no modo simulado local. Para conversar com voz real via IA, configure VOICE_PROVIDER=gemini com uma GEMINI_API_KEY.',
      });
      sendToClient({ type: 'turn_complete' });
    }, latencyMs);

    return {
      handleClientMessage: (msg: any) => {
        if (msg.type === 'audio') {
          receivedAudioChunks++;

          // Debounce do streaming contínuo de áudio para evitar flood de mensagens
          if (audioDebounceTimer) {
            clearTimeout(audioDebounceTimer);
          }

          audioDebounceTimer = setTimeout(() => {
            if (receivedAudioChunks > 5) {
              sendToClient({
                type: 'transcription',
                role: 'user',
                text: '(Áudio de voz recebido)',
              });
              setTimeout(() => {
                sendToClient({
                  type: 'transcription',
                  role: 'ai',
                  text: 'Recebi seu áudio! (Modo Mock ativo: áudio simulado sem custo de API externa).',
                });
                sendToClient({ type: 'turn_complete' });
              }, 200);
            }
            receivedAudioChunks = 0;
          }, 800);
        } else if (msg.type === 'text') {
          sendToClient({
            type: 'transcription',
            role: 'user',
            text: msg.text || '',
          });
          setTimeout(() => {
            sendToClient({
              type: 'transcription',
              role: 'ai',
              text: `Resposta simulada para: "${msg.text}"`,
            });
            sendToClient({ type: 'turn_complete' });
          }, latencyMs);
        }
      },
      close: () => {
        if (audioDebounceTimer) {
          clearTimeout(audioDebounceTimer);
          audioDebounceTimer = null;
        }
        this.logger.log('🎙️ [MockVoiceProvider] Sessão mock encerrada');
      },
    };
  }
}
