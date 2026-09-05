import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  IVoiceProvider,
  VoiceProviderConnectOptions,
} from './voice-provider.interface';
import { CartesiaTtsService } from '../services/cartesia-tts.service';
import { GroqWhisperSttService } from '../services/groq-whisper-stt.service';
import {
  SileroVadService,
  SileroVadSession,
} from '../services/silero-vad.service';

const DEFAULT_CARTESIA_VOICE = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
const DEFAULT_LLM_MODEL = 'gemini-2.5-flash-lite';

export class CascadeVoiceProvider implements IVoiceProvider {
  private readonly logger = new Logger(CascadeVoiceProvider.name);
  private options: VoiceProviderConnectOptions | null = null;
  private cartesiaSession: ReturnType<CartesiaTtsService['createSession']> | null = null;
  private vadSession: SileroVadSession | null = null;
  private isReady = false;
  private isSpeaking = false;
  private activeContextId: string | null = null;
  private abortController: AbortController | null = null;

  private inboundAudioBuffers: Buffer[] = [];
  private preRollBuffers: Buffer[] = [];
  private consecutiveBargeInFrames = 0;
  private hasVoiceInCurrentTurn = false;

  private conversationHistory: Array<{
    role: 'user' | 'model';
    parts: Array<{ text?: string; functionCall?: any; functionResponse?: any }>;
  }> = [];

  constructor(
    private readonly cartesiaTtsService: CartesiaTtsService,
    private readonly groqWhisperSttService: GroqWhisperSttService,
    private readonly sileroVadService?: SileroVadService,
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

    // Inicializa a sessão WebSocket com a Cartesia em 24kHz (padrão de saída do Synexa)
    this.cartesiaSession = this.cartesiaTtsService.createSession({
      apiKey: cartesiaKey,
      voiceId,
      modelId: 'sonic-3.6',
      sampleRate: 24000,
      language: 'pt',
    });

    // Inicializa Silero VAD v5 se disponível (Rede Neural via ONNX Runtime)
    if (this.sileroVadService) {
      this.vadSession = this.sileroVadService.createSession({
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        minSpeechFrames: 3, // ~96ms para confirmar voz
        redemptionFrames: 12, // ~384ms de silêncio para fechar turno
        preRollFrames: 6, // ~192ms de áudio pré-fala
        onSpeechStart: () => {
          if (this.isSpeaking) {
            this.logger.log(
              '⚡ [CascadeVoice] Barge-in confirmado pelo Silero VAD. Abortando áudio da IA.',
            );
            this.handleInterruption();
          }
        },
        onSpeechEnd: (speechAudio: Buffer) => {
          void this.handleSpeechTurnCompleted(speechAudio);
        },
      });
      this.logger.log(
        '🧠 [CascadeVoice] Silero VAD v5 ativado para detecção neural e barge-in',
      );
    }

    this.isReady = true;
    this.logger.log('🎉 [CascadeVoice] Provedor em Cascata conectado (Cartesia Sonic + Groq)');
    this.options.onSetupComplete?.();
  }

  public sendAudio(base64Pcm16: string, _sampleRate = 16000): void {
    if (!base64Pcm16) return;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64Pcm16, 'base64');
    } catch (err: any) {
      this.logger.error(`Erro ao decodificar buffer de áudio: ${err.message}`);
      return;
    }

    // Pipeline 1: Silero VAD v5 Neural
    if (this.vadSession) {
      void this.vadSession.processChunk(buffer);
      return;
    }

    // Pipeline 2: Fallback Acústico RMS/Peak
    const { peak, rms } = this.getBufferEnergy(buffer);
    const isSpeechChunk = peak >= 1000 || rms >= 180;

    // Cenário 1: A IA está falando no momento
    if (this.isSpeaking) {
      if (!isSpeechChunk) {
        this.consecutiveBargeInFrames = 0;
        return;
      }

      this.consecutiveBargeInFrames++;
      this.inboundAudioBuffers.push(buffer);

      if (this.consecutiveBargeInFrames >= 2) {
        this.logger.log(
          `⚡ [CascadeVoice] Barge-in confirmado por fallback acústico (Peak: ${peak}, RMS: ${Math.round(rms)}). Abortando áudio da IA.`,
        );
        this.handleInterruption();
        this.consecutiveBargeInFrames = 0;
        this.hasVoiceInCurrentTurn = true;
      }
      return;
    }

    // Cenário 2: É a vez do usuário falar (IA calada)
    if (isSpeechChunk) {
      if (!this.hasVoiceInCurrentTurn) {
        this.hasVoiceInCurrentTurn = true;
        if (this.preRollBuffers.length > 0) {
          this.inboundAudioBuffers.push(...this.preRollBuffers);
          this.preRollBuffers = [];
        }
      }
      this.inboundAudioBuffers.push(buffer);
    } else {
      if (this.hasVoiceInCurrentTurn) {
        this.inboundAudioBuffers.push(buffer);
      } else {
        this.preRollBuffers.push(buffer);
        if (this.preRollBuffers.length > 6) {
          this.preRollBuffers.shift();
        }
      }
    }
  }

  public sendAudioStreamEnd(): void {
    if (this.vadSession) {
      const flushedAudio = this.vadSession.flush();
      if (flushedAudio && flushedAudio.length > 0) {
        void this.handleSpeechTurnCompleted(flushedAudio);
      }
      return;
    }

    // Fallback acústico: Se não houve fala real no turno atual ou se o buffer está vazio, descarta silêncio
    if (!this.hasVoiceInCurrentTurn || this.inboundAudioBuffers.length === 0) {
      this.inboundAudioBuffers = [];
      this.preRollBuffers = [];
      this.hasVoiceInCurrentTurn = false;
      return;
    }

    const fullBuffer = Buffer.concat(this.inboundAudioBuffers);
    this.inboundAudioBuffers = [];
    this.preRollBuffers = [];
    this.hasVoiceInCurrentTurn = false;

    const durationMs = Math.round(fullBuffer.length / 32);

    // Ignora buffers menores que 300ms (ruído transiente ou estalo)
    if (durationMs < 300) {
      this.logger.debug(`[CascadeVoice] Áudio muito curto descartado (${durationMs}ms)`);
      return;
    }

    const { peak, rms } = this.getBufferEnergy(fullBuffer);

    // VAD de nível de energia global: se a energia média for de sala silenciosa, não gasta STT
    if (peak < 800 && rms < 150) {
      this.logger.debug(
        `[CascadeVoice] Áudio descartado por baixa energia (RMS: ${Math.round(rms)}, Peak: ${peak}, Dur: ${durationMs}ms)`,
      );
      return;
    }

    void this.processUserSpeech(fullBuffer, rms, durationMs);
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
    if (this.vadSession) {
      this.vadSession.reset();
      this.vadSession = null;
    }
    this.inboundAudioBuffers = [];
    this.preRollBuffers = [];
    this.consecutiveBargeInFrames = 0;
    this.hasVoiceInCurrentTurn = false;
    this.conversationHistory = [];
    this.options?.onClose?.();
  }

  // ── MÉTODOS INTERNOS DO PIPELINE ────────────────────────────────

  private async handleSpeechTurnCompleted(speechAudio: Buffer): Promise<void> {
    const durationMs = Math.round(speechAudio.length / 32);
    if (durationMs < 200) {
      this.logger.log(
        `[CascadeVoice] Segmento Silero VAD descartado por duração mínima (${durationMs}ms)`,
      );
      return;
    }

    const { peak, rms } = this.getBufferEnergy(speechAudio);
    // VAD acústico secundário: descarta ruído inaudível de fundo que não seja fala audível
    if (peak < 150 && rms < 25) {
      this.logger.log(
        `[CascadeVoice] Segmento Silero VAD descartado por ruído inaudível (RMS: ${Math.round(rms)}, Peak: ${peak})`,
      );
      return;
    }

    this.logger.log(
      `🎙️ [CascadeVoice] Turno de fala fechado (${durationMs}ms, RMS: ${Math.round(rms)}, Peak: ${peak}). Despachando para Groq Whisper...`,
    );
    await this.processUserSpeech(speechAudio, rms, durationMs);
  }

  private getBufferEnergy(buffer: Buffer): { peak: number; rms: number } {
    let peak = 0;
    let sumSquares = 0;
    const sampleCount = Math.floor(buffer.length / 2);
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    return { peak, rms };
  }

  private isWhisperHallucination(
    text: string,
    rms: number,
    durationMs: number,
  ): boolean {
    const clean = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/gi, '')
      .trim();

    if (!clean) return true;

    // Alucinações clássicas do Whisper geradas em trechos de silêncio ou ruído de microfone
    const knownHallucinations = new Set([
      'obrigado',
      'obrigada',
      'muito obrigado',
      'muito obrigada',
      'e ai',
      'voce',
      'amem',
      'tchau',
      'valeu',
      'de nada',
      'ate a proxima',
      'ate logo',
      'bom dia',
      'boa tarde',
      'boa noite',
      'subtitles by',
      'legendas',
      'legendas pela comunidade',
    ]);

    if (knownHallucinations.has(clean)) {
      // Se a energia foi relativamente baixa ou a duração foi curta, é ruído/alucinação de silêncio
      if (rms < 350 || durationMs < 1200) {
        return true;
      }
    }

    if (clean.includes('subtitles') || clean.includes('legendas')) {
      return true;
    }

    return false;
  }

  private handleInterruption(): void {
    if (this.isSpeaking) {
      this.logger.debug('⚡ [CascadeVoice] Barge-in detectado: abortando fala da IA');
      this.isSpeaking = false;
      this.consecutiveBargeInFrames = 0;
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

  private async processUserSpeech(
    pcmBuffer: Buffer,
    rms: number,
    durationMs: number,
  ): Promise<void> {
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

      if (!userText || !userText.trim()) {
        this.logger.log('[CascadeVoice] Whisper retornou texto vazio para o áudio');
        return;
      }

      // Filtro Anti-Alucinação do Whisper em áudios de baixa energia/curtos
      if (this.isWhisperHallucination(userText, rms, durationMs)) {
        this.logger.warn(
          `⚠️ [CascadeVoice] Alucinação do Whisper suprimida: "${userText}" (RMS: ${Math.round(rms)}, Dur: ${durationMs}ms)`,
        );
        return;
      }

      this.logger.log(`📝 [CascadeVoice] Fala transcrita pelo Groq Whisper: "${userText}"`);
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
