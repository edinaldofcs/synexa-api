import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  IVoiceProvider,
  VoiceProviderConnectOptions,
} from './voice-provider.interface';
import { CartesiaTtsService } from '../services/cartesia-tts.service';
import { GroqWhisperSttService } from '../services/groq-whisper-stt.service';

const DEFAULT_CARTESIA_VOICE = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
const DEFAULT_LLM_MODEL = 'gemini-2.5-flash-lite';

export class CascadeVoiceProvider implements IVoiceProvider {
  private readonly logger = new Logger(CascadeVoiceProvider.name);
  private options: VoiceProviderConnectOptions | null = null;
  private cartesiaSession: ReturnType<CartesiaTtsService['createSession']> | null = null;
  private isReady = false;
  private isSpeaking = false;
  private activeContextId: string | null = null;
  private abortController: AbortController | null = null;

  private inboundAudioBuffers: Buffer[] = [];
  private conversationHistory: Array<{
    role: 'user' | 'model';
    parts: Array<{ text?: string; functionCall?: any; functionResponse?: any }>;
  }> = [];

  constructor(
    private readonly cartesiaTtsService: CartesiaTtsService,
    private readonly groqWhisperSttService: GroqWhisperSttService,
  ) {}

  public get ready(): boolean {
    return this.isReady;
  }

  public get droppedAudioFrames(): number {
    return 0;
  }

  public connect(options: VoiceProviderConnectOptions): void {
    this.options = options;
    const cartesiaKey =
      options.cartesiaApiKey || process.env.CARTESIA_API_KEY || '';
    const voiceId = options.voiceName || DEFAULT_CARTESIA_VOICE;

    if (!cartesiaKey) {
      this.logger.warn(
        '⚠️ [CascadeVoice] CARTESIA_API_KEY não encontrada. Síntese de voz pode falhar.',
      );
    }

    // Inicializa a sessão WebSocket com a Cartesia
    this.cartesiaSession = this.cartesiaTtsService.createSession({
      apiKey: cartesiaKey,
      voiceId,
      modelId: 'sonic-3.6',
      sampleRate: 16000,
      language: 'pt',
    });

    this.isReady = true;
    this.logger.log('🎉 [CascadeVoice] Provedor em Cascata conectado (Cartesia Sonic + Groq)');
    this.options.onSetupComplete?.();
  }

  public sendAudio(base64Pcm16: string, _sampleRate = 16000): void {
    if (!base64Pcm16) return;

    // Se a IA estiver falando e o usuário emitir som (áudio pelo gate), ativa barge-in imediato
    if (this.isSpeaking) {
      this.handleInterruption();
    }

    try {
      const buffer = Buffer.from(base64Pcm16, 'base64');
      this.inboundAudioBuffers.push(buffer);
    } catch (err: any) {
      this.logger.error(`Erro ao decodificar buffer de áudio: ${err.message}`);
    }
  }

  public sendAudioStreamEnd(): void {
    if (this.inboundAudioBuffers.length === 0) return;

    const fullBuffer = Buffer.concat(this.inboundAudioBuffers);
    this.inboundAudioBuffers = [];

    // Ignora buffers minúsculos que sejam apenas ruído estático (< 100ms = 3200 bytes a 16kHz)
    if (fullBuffer.length < 3200) {
      return;
    }

    void this.processUserSpeech(fullBuffer);
  }

  public sendText(text: string): void {
    if (!text || !text.trim()) return;
    this.logger.log(`🤖 [CascadeVoice] Enviando texto de entrada (saudação): "${text}"`);
    void this.executeLlmAndSpeak(text);
  }

  public sendToolResponse(
    functionResponses: {
      name: string;
      id: string;
      response: Record<string, any>;
    }[],
  ): void {
    if (!functionResponses || functionResponses.length === 0) return;

    // Adiciona as respostas das ferramentas ao histórico e retoma o LLM
    this.conversationHistory.push({
      role: 'user',
      parts: functionResponses.map((r) => ({
        functionResponse: {
          name: r.name,
          response: r.response,
        },
      })),
    });

    void this.continueLlmAfterToolResponse();
  }

  public close(): void {
    this.isReady = false;
    this.handleInterruption();
    if (this.cartesiaSession) {
      this.cartesiaSession.close();
      this.cartesiaSession = null;
    }
    this.inboundAudioBuffers = [];
    this.conversationHistory = [];
    this.options?.onClose?.();
  }

  // ── MÉTODOS INTERNOS DO PIPELINE ────────────────────────────────

  private handleInterruption(): void {
    if (this.isSpeaking) {
      this.logger.debug('⚡ [CascadeVoice] Barge-in detectado: abortando fala da IA');
      this.isSpeaking = false;
      if (this.activeContextId && this.cartesiaSession) {
        this.cartesiaSession.cancelContext(this.activeContextId);
        this.activeContextId = null;
      }
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.options?.onInterrupted?.();
    }
  }

  private async processUserSpeech(pcmBuffer: Buffer): Promise<void> {
    const groqKey =
      this.options?.groqApiKey || process.env.GROQ_API_KEY || '';

    if (!groqKey) {
      this.logger.error('❌ [CascadeVoice] GROQ_API_KEY não configurada para STT');
      return;
    }

    try {
      const userText = await this.groqWhisperSttService.transcribePcm(
        pcmBuffer,
        { apiKey: groqKey },
      );

      if (!userText || !userText.trim()) return;

      this.options?.onUserTranscript?.(userText);
      await this.executeLlmAndSpeak(userText);
    } catch (err: any) {
      this.logger.error(`❌ [CascadeVoice] Falha no STT: ${err.message}`);
      this.options?.onError?.(err);
    }
  }

  private async executeLlmAndSpeak(userText: string): Promise<void> {
    this.conversationHistory.push({
      role: 'user',
      parts: [{ text: userText }],
    });

    await this.streamLlmResponse();
  }

  private async continueLlmAfterToolResponse(): Promise<void> {
    await this.streamLlmResponse();
  }

  private async streamLlmResponse(): Promise<void> {
    const geminiKey = this.options?.apiKey || process.env.GEMINI_API_KEY || '';
    if (!geminiKey) {
      this.logger.error('❌ [CascadeVoice] GEMINI_API_KEY não configurada');
      return;
    }

    let model = this.options?.model || DEFAULT_LLM_MODEL;
    // O endpoint da Google Generative Language API só aceita modelos da família gemini- de texto.
    // Modelos de texto externos (ex: openai/gpt-oss-120b, llama-*) ou da Live API (live-preview)
    // são automaticamente mapeados para o modelo de voz ultrarrápido oficial: gemini-2.5-flash-lite.
    const isGeminiTextModel =
      model.toLowerCase().startsWith('gemini-') &&
      !model.includes('live') &&
      !model.includes('native-audio');

    if (!isGeminiTextModel) {
      model = DEFAULT_LLM_MODEL;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${geminiKey}`;

    this.abortController = new AbortController();
    const contextId = uuidv4();
    this.activeContextId = contextId;
    this.isSpeaking = true;

    // Formata o payload com histórico, system prompt e declarações de ferramentas
    const contents = this.conversationHistory.map((h) => ({
      role: h.role,
      parts: h.parts,
    }));

    const tools = this.options?.tools?.map((t) => ({
      functionDeclarations: t.functionDeclarations,
    }));

    const body: Record<string, any> = {
      contents,
      systemInstruction: {
        parts: [{ text: this.options?.systemPrompt || '' }],
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 800,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    let sentenceBuffer = '';
    let fullAiResponse = '';
    const functionCallsToDispatch: any[] = [];

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Erro Gemini (${res.status}): ${errText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Não foi possível ler o stream do Gemini');

      const decoder = new TextDecoder();
      let streamBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const candidate = chunk.candidates?.[0];
            const parts = candidate?.content?.parts;

            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  const tokenText = part.text;
                  fullAiResponse += tokenText;
                  sentenceBuffer += tokenText;
                  this.options?.onAiTranscript?.(tokenText);

                  // Sentence Chunking: envia para Cartesia a cada pontuação natural
                  if (/[.!?;:\n]/.test(tokenText)) {
                    this.pushToCartesia(contextId, sentenceBuffer, true);
                    sentenceBuffer = '';
                  }
                }

                if (part.functionCall) {
                  functionCallsToDispatch.push(part.functionCall);
                }
              }
            }
          } catch {
            // Ignora fragmentos JSON incompletos do SSE
          }
        }
      }

      // Envia o restante do buffer para a Cartesia
      if (sentenceBuffer.trim().length > 0) {
        this.pushToCartesia(contextId, sentenceBuffer, false);
      } else if (this.cartesiaSession) {
        this.cartesiaSession.finalizeContext(contextId);
      }

      if (fullAiResponse) {
        this.conversationHistory.push({
          role: 'model',
          parts: [{ text: fullAiResponse }],
        });
      }

      // Se houver chamadas de ferramenta
      if (functionCallsToDispatch.length > 0) {
        this.logger.log(
          `🔧 [CascadeVoice] Tool call solicitada pelo agente: ${functionCallsToDispatch
            .map((f) => f.name)
            .join(', ')}`,
        );
        this.options?.onToolCall?.(functionCallsToDispatch);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.logger.debug('🛑 [CascadeVoice] Stream do LLM abortado por interrupção');
      } else {
        this.logger.error(`❌ [CascadeVoice] Erro no stream do LLM: ${err.message}`);
        this.options?.onError?.(err);
      }
    }
  }

  private pushToCartesia(
    contextId: string,
    text: string,
    continueStream: boolean,
  ): void {
    if (!this.cartesiaSession || !text.trim()) return;

    this.cartesiaSession.pushText(contextId, text, continueStream, {
      onAudioChunk: (pcmChunk) => {
        // Envia o PCM 16kHz base64 para o telephonyAdapter / web client
        this.options?.onAudio?.(pcmChunk.toString('base64'));
      },
      onDone: () => {
        this.isSpeaking = false;
        this.options?.onTurnComplete?.();
      },
      onError: (err) => {
        this.logger.error(`❌ [CascadeVoice] Erro no Cartesia TTS: ${err.message}`);
        this.isSpeaking = false;
        this.options?.onError?.(err);
      },
    });
  }
}
