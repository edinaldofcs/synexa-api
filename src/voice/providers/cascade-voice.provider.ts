import { resolveVoiceFlowSettings } from '../services/voice-flow-settings';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  IVoiceProvider,
  VoiceProviderConnectOptions,
} from './voice-provider.interface';
import {
  CustomSttConfig,
  SttTranscriber,
  StreamingTtsSession,
  StreamingTtsSessionFactory,
} from './custom-voice.types';
import {
  SileroVadService,
  SileroVadSession,
} from '../services/silero-vad.service';

const DEFAULT_CARTESIA_VOICE = 'cb2694c3-715f-4da9-99f3-1c974fff2928';
const DEFAULT_LLM_MODEL = 'gemini-2.5-flash-lite';
const MAX_CONVERSATION_HISTORY = 20;

export class CascadeVoiceProvider implements IVoiceProvider {
  private readonly logger = new Logger(CascadeVoiceProvider.name);
  private options: VoiceProviderConnectOptions | null = null;
  private ttsSession: StreamingTtsSession | null = null;
  private vadSession: SileroVadSession | null = null;
  private isReady = false;
  private generation = 0;
  private hasPendingSpeech = false;
  private pendingTtsPhrases = 0;
  private isSpeaking = false;
  private aiPlaybackUntil = 0;
  private turnCompleteTimer: NodeJS.Timeout | null = null;
  private activeContextId: string | null = null;
  private abortController: AbortController | null = null;

  private inboundAudioBuffers: Buffer[] = [];
  private preRollBuffers: Buffer[] = [];
  private consecutiveBargeInFrames = 0;
  private hasVoiceInCurrentTurn = false;
  private _firstAudioLogged = false;
  private isInterruptionBlocked = false;

  private conversationHistory: Array<{
    role: 'user' | 'model';
    parts: Array<{ text?: string; functionCall?: any; functionResponse?: any }>;
  }> = [];

  constructor(
    // Contratos estruturais: CartesiaTtsService e GroqWhisperSttService (ou
    // os serviços custom HTTP BYO) satisfazem estas assinaturas sem acoplamento.
    private readonly ttsSessionFactory: StreamingTtsSessionFactory,
    private readonly sttTranscriber: SttTranscriber,
    private readonly sileroVadService?: SileroVadService,
  ) {}

  public get ready(): boolean {
    return this.isReady;
  }

  public get droppedAudioFrames(): number {
    return 0;
  }

  public connect(options: VoiceProviderConnectOptions): void {
    this.generation++;
    const generation = this.generation;
    this.options = options;
    this.isInterruptionBlocked = options.allowInterruption === false;
    const customTts = options.customTts;
    const voiceId = options.voiceName || DEFAULT_CARTESIA_VOICE;

    if (options.ttsProvider === 'inworld') {
      this.ttsSession = this.ttsSessionFactory.createSession({
        apiKey: options.inworldApiKey || '',
        voiceId:
          options.voiceName ||
          resolveVoiceFlowSettings(options.voiceSettings).inworldVoice,
        sampleRate: 24000,
      });
    } else if (customTts?.baseUrl) {
      // BYO TTS: sessão HTTP do cliente (chave/config já resolvidas pelo factory)
      this.logger.log(
        `🎙️ [CascadeVoice] TTS customizado (BYO) ativado: ${customTts.baseUrl}`,
      );
      this.ttsSession = this.ttsSessionFactory.createSession({
        apiKey: customTts.apiKey,
        voiceId: customTts.voice || voiceId,
        sampleRate: 24000,
        language: resolveVoiceFlowSettings(options.voiceSettings).language,
        baseUrl: customTts.baseUrl,
        outputSampleRate: customTts.sampleRate,
        timeoutMs: customTts.timeoutMs,
      });
    } else {
      const cartesiaKey =
        options.cartesiaApiKey || process.env.CARTESIA_API_KEY || '';
      if (!cartesiaKey) {
        this.logger.warn(
          '⚠️ [CascadeVoice] CARTESIA_API_KEY não encontrada. Síntese de voz pode falhar.',
        );
      }
      // Inicializa a sessão WebSocket com a Cartesia em 24kHz (padrão de saída do Synexa)
      this.ttsSession = this.ttsSessionFactory.createSession({
        apiKey: cartesiaKey,
        voiceId,
        modelId: resolveVoiceFlowSettings(options.voiceSettings).cartesiaModel,
        sampleRate: 24000,
        language: resolveVoiceFlowSettings(options.voiceSettings).language,
      });
    }

    // Inicializa Silero VAD v5 se disponível (Rede Neural via ONNX Runtime)
    if (this.sileroVadService) {
      this.vadSession = this.sileroVadService.createSession({
        positiveSpeechThreshold: 0.45,
        negativeSpeechThreshold: 0.25,
        minSpeechFrames: 2, // ~64ms para confirmar voz rapidamente
        redemptionFrames: 12, // ~384ms de silêncio para fechar turno
        preRollFrames: 8, // ~256ms de áudio pré-fala
        onSpeechStart: () => {
          if (!this.isReady || generation !== this.generation) return;
          if (this.isInterruptionBlocked) return;
          // Barge-in só quando há áudio da IA REALMENTE enfileirado/reproduzindo.
          // `isSpeaking` fica true desde o início da geração do LLM (janela
          // morta de 1-2s antes do primeiro chunk de TTS) — usá-lo aqui fazia
          // qualquer ruído de ambiente abortar a saudação logo na conexão.
          const isAiAudible = Date.now() < this.aiPlaybackUntil;
          if (isAiAudible) {
            this.logger.log(
              '⚡ [CascadeVoice] Barge-in confirmado pelo Silero VAD. Abortando áudio da IA.',
            );
            this.handleInterruption();
          }
        },
        onSpeechEnd: (speechAudio: Buffer) => {
          if (!this.isReady || generation !== this.generation) return;
          void this.handleSpeechTurnCompleted(speechAudio);
        },
      });
      this.logger.log(
        '🧠 [CascadeVoice] Silero VAD v5 ativado para detecção neural e barge-in',
      );
    }

    this.isReady = true;
    this.logger.log(
      `[CascadeVoice] Cascata conectada: TTS=${options.ttsProvider || 'cartesia'}, STT=${options.sttProvider || 'groq'}`,
    );
    this.options.onSetupComplete?.();
  }

  public sendAudio(base64Pcm16: string, _sampleRate = 16000): void {
    if (!this.isReady || !base64Pcm16) return;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64Pcm16, 'base64');
    } catch (err: any) {
      this.logger.error(`Erro ao decodificar buffer de áudio: ${err.message}`);
      return;
    }

    // Pipeline 1: Silero VAD v5 Neural
    if (this.vadSession) {
      if (!this._firstAudioLogged) {
        this._firstAudioLogged = true;
        this.logger.log(
          `🔊 [CascadeVoice] Primeiro chunk de áudio recebido (${buffer.length} bytes). Encaminhando ao Silero VAD.`,
        );
      }
      void this.vadSession.processChunk(buffer);
      return;
    }

    // Pipeline 2: Fallback Acústico RMS/Peak
    const { peak, rms } = this.getBufferEnergy(buffer);
    const isSpeechChunk = peak >= 1000 || rms >= 180;
    const isAiAudible = this.isSpeaking || Date.now() < this.aiPlaybackUntil;

    // Cenário 1: A IA está falando no momento ou áudio ainda está tocando no cliente
    if (isAiAudible) {
      if (this.isInterruptionBlocked) {
        return;
      }
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
      this.logger.debug(
        `[CascadeVoice] Áudio muito curto descartado (${durationMs}ms)`,
      );
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
    if (!this.isReady || !text || !text.trim()) return;
    this.logger.log(
      `[CascadeVoice] Enviando saudação (${text.length} caracteres)`,
    );
    void this.executeLlmAndSpeak(text);
  }

  public setInterruptionBlocked(blocked: boolean): void {
    this.isInterruptionBlocked = blocked;
    this.logger.debug(
      `[CascadeVoice] Bloqueio de interrupção definido como: ${blocked}`,
    );
    if (!blocked) {
      // Ao liberar a fala do usuário, descarta qualquer ruído acumulado durante a saudação
      this.vadSession?.reset();
      this.inboundAudioBuffers = [];
      this.preRollBuffers = [];
      this.consecutiveBargeInFrames = 0;
      this.hasVoiceInCurrentTurn = false;
    }
  }

  public seedGreetingTurn(text: string): void {
    if (!text || !text.trim()) return;
    this.logger.log(
      `[CascadeVoice] Saudação inicial registrada (${text.trim().length} caracteres)`,
    );
    // Para respeitar o protocolo da API Gemini (onde contents deve iniciar com role 'user'),
    // registramos o par inicial: trigger de início do atendimento -> fala da saudação pela IA.
    // A IA NÃO gera fala proativa adicional e aguarda a fala real do usuário.
    this.conversationHistory.push(
      {
        role: 'user',
        parts: [{ text: '[INÍCIO DA LIGAÇÃO / ATENDIMENTO INICIADO]' }],
      },
      {
        role: 'model',
        parts: [{ text: text.trim() }],
      },
    );
  }

  public sendToolResponse(
    functionResponses: {
      name: string;
      id: string;
      response: Record<string, any>;
    }[],
  ): void {
    if (!this.isReady || !functionResponses || functionResponses.length === 0)
      return;

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
    this.generation++;
    // Shutdown is unconditional; allowInterruption only controls user barge-in.
    this.abortController?.abort();
    this.abortController = null;
    this.activeContextId = null;
    this.isSpeaking = false;
    this.hasPendingSpeech = false;
    this.pendingTtsPhrases = 0;
    if (this.turnCompleteTimer) {
      clearTimeout(this.turnCompleteTimer);
      this.turnCompleteTimer = null;
    }
    this.aiPlaybackUntil = 0;
    if (this.ttsSession) {
      this.ttsSession.close();
      this.ttsSession = null;
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
    this.isInterruptionBlocked = false;
    this.options?.onClose?.();
  }

  public async waitForOutput(): Promise<void> {
    const generation = this.generation;
    const deadline = Date.now() + 15000;
    while (
      this.isReady &&
      generation === this.generation &&
      this.hasPendingSpeech
    ) {
      if (Date.now() >= deadline) {
        this.logger.warn('[CascadeVoice] Timed out waiting for transfer audio');
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  // ── MÉTODOS INTERNOS DO PIPELINE ────────────────────────────────

  private async handleSpeechTurnCompleted(speechAudio: Buffer): Promise<void> {
    if (this.isInterruptionBlocked) {
      this.logger.debug(
        '[CascadeVoice] Segmento Silero VAD descartado por bloqueio de interrupção (saudação ininterrupta)',
      );
      return;
    }
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
      `🎙️ [CascadeVoice] Turno de fala fechado (${durationMs}ms, RMS: ${Math.round(rms)}, Peak: ${peak}). Despachando para STT...`,
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
    if (this.isInterruptionBlocked) {
      this.logger.debug(
        '[CascadeVoice] Interrupção suprimida (saudação inicial ininterrupta em reprodução)',
      );
      return;
    }
    const wasSpeaking = this.isSpeaking || Date.now() < this.aiPlaybackUntil;
    if (wasSpeaking) {
      this.logger.log(
        '⚡ [CascadeVoice] Barge-in detectado: abortando fala da IA',
      );
      this.isSpeaking = false;
      this.hasPendingSpeech = false;
      this.pendingTtsPhrases = 0;
      this.aiPlaybackUntil = 0;
      this.consecutiveBargeInFrames = 0;
      if (this.turnCompleteTimer) {
        clearTimeout(this.turnCompleteTimer);
        this.turnCompleteTimer = null;
      }
      if (this.activeContextId && this.ttsSession) {
        this.ttsSession.cancelContext(this.activeContextId);
        this.activeContextId = null;
      }
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      // Limpa o estado do VAD para não fechar segmentos fantasmas (8ms)
      // com o áudio de eco/ruído acumulado durante a fala abortada
      this.vadSession?.reset();
      this.inboundAudioBuffers = [];
      this.preRollBuffers = [];
      this.consecutiveBargeInFrames = 0;
      this.hasVoiceInCurrentTurn = false;
      this.options?.onInterrupted?.();
    }
  }

  private async processUserSpeech(
    pcmBuffer: Buffer,
    rms: number,
    durationMs: number,
  ): Promise<void> {
    const generation = this.generation;
    if (!this.isReady) return;
    const customStt: CustomSttConfig | undefined = this.options?.customStt;
    const isInworld = this.options?.sttProvider === 'inworld';
    const groqKey = isInworld
      ? this.options?.inworldApiKey || ''
      : this.options?.groqApiKey || process.env.GROQ_API_KEY || '';

    if (customStt?.baseUrl) {
      this.logger.log(
        `🎙️ [CascadeVoice] Turno de fala (${durationMs}ms) despachado para STT customizado (BYO)...`,
      );
    } else if (!groqKey) {
      this.logger.error('Credencial do provedor STT não configurada');
      return;
    }

    try {
      const sttInput = customStt?.baseUrl
        ? {
            apiKey: customStt.apiKey,
            baseUrl: customStt.baseUrl,
            timeoutMs: customStt.timeoutMs,
          }
        : {
            apiKey: groqKey,
            model: resolveVoiceFlowSettings(this.options?.voiceSettings)
              .groqModel,
            language: resolveVoiceFlowSettings(this.options?.voiceSettings)
              .language,
            prompt: resolveVoiceFlowSettings(this.options?.voiceSettings)
              .sttPrompt,
          };

      const userText = await this.sttTranscriber.transcribePcm(
        pcmBuffer,
        sttInput,
      );

      if (!this.isReady || generation !== this.generation) return;
      if (!userText || !userText.trim()) {
        this.logger.log('[CascadeVoice] STT retornou texto vazio para o áudio');
        return;
      }

      // Filtro Anti-Alucinação do Whisper em áudios de baixa energia/curtos
      if (
        !isInworld &&
        this.isWhisperHallucination(userText, rms, durationMs)
      ) {
        this.logger.warn(
          `[CascadeVoice] Alucinação do Whisper suprimida (RMS: ${Math.round(rms)}, Dur: ${durationMs}ms)`,
        );
        return;
      }

      this.logger.log(
        `[CascadeVoice] Transcrição recebida: provider=${this.options?.sttProvider || 'groq'}, caracteres=${userText.length}`,
      );
      this.options?.onUserTranscript?.(userText);
      await this.executeLlmAndSpeak(userText);
    } catch (err: any) {
      if (!this.isReady || generation !== this.generation) return;
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
    const generation = this.generation;
    await this.waitForOutput();
    if (!this.isReady || generation !== this.generation) return;
    await this.streamLlmResponse();
  }

  private async streamLlmResponse(): Promise<void> {
    if (!this.isReady) return;
    const generation = this.generation;
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

    this.abortController?.abort();
    if (this.activeContextId)
      this.ttsSession?.cancelContext(this.activeContextId);
    const controller = new AbortController();
    this.abortController = controller;
    const contextId = uuidv4();
    this.activeContextId = contextId;
    this.hasPendingSpeech = false;
    this.pendingTtsPhrases = 0;
    const isCurrent = () =>
      this.isReady &&
      generation === this.generation &&
      this.activeContextId === contextId &&
      !controller.signal.aborted;
    this.isSpeaking = true;
    this.aiPlaybackUntil = Date.now();
    if (this.turnCompleteTimer) {
      clearTimeout(this.turnCompleteTimer);
      this.turnCompleteTimer = null;
    }

    // Janela deslizante: limita o histórico para evitar explosão de memória, latência e custo
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
      this.conversationHistory = this.conversationHistory.slice(
        -MAX_CONVERSATION_HISTORY,
      );
      while (
        this.conversationHistory.length > 0 &&
        (this.conversationHistory[0].role !== 'user' ||
          this.conversationHistory[0].parts.some((p) => p.functionResponse))
      ) {
        this.conversationHistory.shift();
      }
    }

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
        signal: controller.signal,
      });

      if (!isCurrent()) return;
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
        if (!isCurrent()) return;
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

      // Envia o restante do buffer para o TTS ativo
      if (sentenceBuffer.trim().length > 0) {
        this.pushToCartesia(contextId, sentenceBuffer, false);
      } else if (this.ttsSession) {
        this.ttsSession.finalizeContext(contextId);
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
      if (
        !this.isReady ||
        generation !== this.generation ||
        this.activeContextId !== contextId
      )
        return;
      if (err.name === 'AbortError') {
        this.logger.debug(
          '🛑 [CascadeVoice] Stream do LLM abortado por interrupção',
        );
        if (fullAiResponse.trim()) {
          this.conversationHistory.push({
            role: 'model',
            parts: [
              { text: fullAiResponse + '... [interrompido pelo usuário]' },
            ],
          });
        }
      } else {
        this.logger.error(
          `❌ [CascadeVoice] Erro no stream do LLM: ${err.message}`,
        );
        this.options?.onError?.(err);
      }
    }
  }

  private pushToCartesia(
    contextId: string,
    text: string,
    continueStream: boolean,
  ): void {
    if (!this.ttsSession || !text.trim()) return;

    const generation = this.generation;
    const isCurrent = () =>
      this.isReady &&
      generation === this.generation &&
      this.activeContextId === contextId;
    if (!isCurrent()) return;
    this.hasPendingSpeech = true;
    this.pendingTtsPhrases++;
    if (this.turnCompleteTimer) {
      clearTimeout(this.turnCompleteTimer);
      this.turnCompleteTimer = null;
    }

    this.ttsSession.pushText(contextId, text, continueStream, {
      onAudioChunk: (pcmChunk) => {
        if (!isCurrent()) return;
        // Envia o PCM 24kHz base64 para o telephonyAdapter / web client
        // 24kHz 16-bit mono = 48 bytes/ms
        const chunkDurationMs = Math.round(pcmChunk.length / 48);
        const now = Date.now();
        this.aiPlaybackUntil =
          Math.max(now, this.aiPlaybackUntil) + chunkDurationMs;
        this.options?.onAudio?.(pcmChunk.toString('base64'));
      },
      onDone: () => {
        if (!isCurrent()) return;
        // HTTP and Inworld complete each phrase; Cartesia completes the context.
        this.pendingTtsPhrases =
          this.options?.customTts?.baseUrl ||
          this.options?.ttsProvider === 'inworld'
            ? Math.max(0, this.pendingTtsPhrases - 1)
            : 0;
        if (this.pendingTtsPhrases > 0) return;
        // Aguarda a janela de reprodução acústica no cliente terminar antes de fechar o turno
        const remainingPlaybackMs = Math.max(
          0,
          this.aiPlaybackUntil - Date.now(),
        );
        if (this.turnCompleteTimer) {
          clearTimeout(this.turnCompleteTimer);
        }
        this.turnCompleteTimer = setTimeout(() => {
          if (!isCurrent()) return;
          this.hasPendingSpeech = false;
          this.isSpeaking = false;
          this.turnCompleteTimer = null;
          this.options?.onTurnComplete?.();
        }, remainingPlaybackMs);
      },
      onError: (err) => {
        if (!isCurrent()) return;
        this.hasPendingSpeech = false;
        this.logger.error(
          `❌ [CascadeVoice] Erro no Cartesia TTS: ${err.message}`,
        );
        this.isSpeaking = false;
        this.aiPlaybackUntil = 0;
        if (this.turnCompleteTimer) {
          clearTimeout(this.turnCompleteTimer);
          this.turnCompleteTimer = null;
        }
        this.options?.onError?.(err);
      },
    });
  }
}
