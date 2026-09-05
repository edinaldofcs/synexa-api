import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

let ortModule: any = null;

export interface SileroVadSessionOptions {
  positiveSpeechThreshold?: number; // Padrão: 0.50 (início de fala)
  negativeSpeechThreshold?: number; // Padrão: 0.35 (silêncio)
  minSpeechFrames?: number; // Padrão: 3 frames (~96ms) para confirmar fala
  redemptionFrames?: number; // Padrão: 10 frames (~320ms) de silêncio para fechar turno
  preRollFrames?: number; // Padrão: 6 frames (~192ms) de áudio pré-fala
  onSpeechStart?: () => void;
  onSpeechEnd?: (speechBuffer: Buffer) => void;
  onSpeechProbability?: (probability: number) => void;
}

export class SileroVadSession {
  private readonly logger = new Logger(SileroVadSession.name);
  private readonly positiveThreshold: number;
  private readonly negativeThreshold: number;
  private readonly minSpeechFrames: number;
  private readonly redemptionFrames: number;
  private readonly preRollFrames: number;

  private stateTensor: any = null;
  private readonly srTensor: any = null;
  private context: Float32Array = new Float32Array(64);

  private pcmAccumulator: Buffer = Buffer.alloc(0);
  private preRollQueue: Buffer[] = [];
  private speechFrames: Buffer[] = [];

  private isSpeaking = false;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;
  private lastProbability = 0;
  private frameCount = 0;

  constructor(
    private readonly inferenceSession: any | null,
    private readonly ort: any | null,
    private readonly options: SileroVadSessionOptions = {},
  ) {
    this.positiveThreshold = options.positiveSpeechThreshold ?? 0.4;
    this.negativeThreshold = options.negativeSpeechThreshold ?? 0.25;
    this.minSpeechFrames = options.minSpeechFrames ?? 2;
    this.redemptionFrames = options.redemptionFrames ?? 12;
    this.preRollFrames = options.preRollFrames ?? 8;

    if (this.inferenceSession && this.ort) {
      // Inicializa o estado recorrente do Silero v5: [2, 1, 128] com zeros
      this.stateTensor = new this.ort.Tensor(
        'float32',
        Array.from(new Float32Array(2 * 1 * 128)),
        [2, 1, 128],
      );
      this.srTensor = new this.ort.Tensor('int64', [16000n], [1]);
    }
  }

  public get speaking(): boolean {
    return this.isSpeaking;
  }

  public get probability(): number {
    return this.lastProbability;
  }

  /**
   * Processa um chunk de áudio PCM16 mono a 16kHz.
   * Acumula até 512 amostras (1024 bytes = 32ms) e executa inferência neural Silero VAD v5.
   */
  public async processChunk(
    pcm16Chunk: Buffer,
  ): Promise<{ isSpeech: boolean; probability: number }> {
    if (!pcm16Chunk || pcm16Chunk.length === 0) {
      return { isSpeech: this.isSpeaking, probability: this.lastProbability };
    }

    // Se o modelo ONNX não estiver carregado, faz fallback gracioso para VAD acústico (RMS)
    if (!this.inferenceSession) {
      return this.fallbackRmsVad(pcm16Chunk);
    }

    this.pcmAccumulator = Buffer.concat([this.pcmAccumulator, pcm16Chunk]);

    // Silero VAD v5 opera em janelas de 512 amostras a 16kHz (1024 bytes) com 64 amostras de contexto (576 total)
    const FRAME_BYTES = 1024;
    const SAMPLES_PER_FRAME = 512;
    const CONTEXT_SAMPLES = 64;
    const TOTAL_INPUT_SAMPLES = CONTEXT_SAMPLES + SAMPLES_PER_FRAME;

    while (this.pcmAccumulator.length >= FRAME_BYTES) {
      const frameBuffer = this.pcmAccumulator.subarray(0, FRAME_BYTES);
      this.pcmAccumulator = this.pcmAccumulator.subarray(FRAME_BYTES);

      // Converte PCM 16-bit inteiro (-32768 a 32767) para Float32 normalizado (-1.0 a 1.0)
      // e avalia energia acústica da janela (Peak / RMS)
      const float32 = new Float32Array(SAMPLES_PER_FRAME);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const s = frameBuffer.readInt16LE(i * 2);
        const abs = Math.abs(s);
        if (abs > peak) peak = abs;
        sum += s * s;
        float32[i] = s / 32768.0;
      }
      const rms = Math.sqrt(sum / SAMPLES_PER_FRAME);

      try {
        // Silero VAD v5 exige concatenação: 64 amostras de contexto anterior + 512 novas = 576 amostras
        const inputBuffer = new Float32Array(TOTAL_INPUT_SAMPLES);
        inputBuffer.set(this.context, 0);
        inputBuffer.set(float32, CONTEXT_SAMPLES);

        const inputTensor = new this.ort.Tensor(
          'float32',
          Array.from(inputBuffer),
          [1, TOTAL_INPUT_SAMPLES],
        );
        const results = await this.inferenceSession.run({
          input: inputTensor,
          state: this.stateTensor,
          sr: this.srTensor,
        });

        const prob = Number(results.output.data[0]);
        this.lastProbability = prob;
        this.options.onSpeechProbability?.(prob);

        // Atualiza estado recorrente e buffer de contexto rotativo para o próximo frame
        this.stateTensor = results.stateN;
        this.context = new Float32Array(
          float32.subarray(SAMPLES_PER_FRAME - CONTEXT_SAMPLES),
        );

        // Diagnóstico: a cada ~1s (30 frames de 32ms), loga métricas para monitoramento
        this.frameCount++;
        if (this.frameCount % 30 === 0) {
          this.logger.log(
            `📊 [SileroVAD] Diagnóstico: frame=${this.frameCount} prob=${(prob * 100).toFixed(1)}% peak=${peak} rms=${Math.round(rms)} speaking=${this.isSpeaking} speechFrames=${this.consecutiveSpeechFrames} silenceFrames=${this.consecutiveSilenceFrames}`,
          );
        }

        this.updateStateMachine(frameBuffer, prob, peak, rms);
      } catch (err: any) {
        this.logger.error(
          `Erro na inferência do Silero VAD: ${err.stack || err.message}`,
        );
        this.fallbackRmsVad(frameBuffer);
      }
    }

    return { isSpeech: this.isSpeaking, probability: this.lastProbability };
  }

  private updateStateMachine(
    frame: Buffer,
    prob: number,
    peak = 0,
    rms = 0,
  ): void {
    // Fusão Híbrida: Silero VAD neural v5 como árbitro primário,
    // com salvaguarda acústica se voz humana audível for confirmada por RMS/Peak
    const isNeuralSpeech = prob >= this.positiveThreshold;
    const isAcousticVoice = peak >= 1500 && rms >= 250;
    const isSpeech = isNeuralSpeech || (isAcousticVoice && prob >= 0.2);

    if (isSpeech) {
      this.consecutiveSpeechFrames++;
      this.consecutiveSilenceFrames = 0;

      if (!this.isSpeaking) {
        // Fala humana em ascensão
        if (this.consecutiveSpeechFrames >= this.minSpeechFrames) {
          this.isSpeaking = true;
          this.logger.log(
            `🎙️ [SileroVAD] Fala humana detectada (Prob: ${(prob * 100).toFixed(1)}%, Peak: ${peak}, RMS: ${Math.round(rms)}). Ativando turno.`,
          );
          this.speechFrames = [...this.preRollQueue, frame];
          this.preRollQueue = [];
          this.options.onSpeechStart?.();
        } else {
          this.preRollQueue.push(frame);
          if (this.preRollQueue.length > this.preRollFrames) {
            this.preRollQueue.shift();
          }
        }
      } else {
        this.speechFrames.push(frame);
      }
    } else if (prob < this.negativeThreshold && !isAcousticVoice) {
      this.consecutiveSilenceFrames++;
      this.consecutiveSpeechFrames = 0;

      if (this.isSpeaking) {
        // Usuário estava falando e pausou; acumula frames de silêncio breve (hangover)
        this.speechFrames.push(frame);

        if (this.consecutiveSilenceFrames >= this.redemptionFrames) {
          this.isSpeaking = false;
          const fullAudio = Buffer.concat(this.speechFrames);
          this.logger.log(
            `🛑 [SileroVAD] Fim de fala detectado após ${this.redemptionFrames * 32}ms de silêncio neural (${fullAudio.length} bytes, ${(fullAudio.length / 32).toFixed(0)}ms).`,
          );
          this.speechFrames = [];
          this.preRollQueue = [];
          this.options.onSpeechEnd?.(fullAudio);
        }
      } else {
        // Usuário continua em silêncio; mantém pre-roll deslizante
        this.preRollQueue.push(frame);
        if (this.preRollQueue.length > this.preRollFrames) {
          this.preRollQueue.shift();
        }
      }
    } else {
      // Região intermediária de histerese (entre negativeThreshold e positiveThreshold)
      if (this.isSpeaking) {
        this.speechFrames.push(frame);
      } else {
        this.preRollQueue.push(frame);
        if (this.preRollQueue.length > this.preRollFrames) {
          this.preRollQueue.shift();
        }
      }
    }
  }

  /**
   * Fallback acústico caso o runtime ONNX não esteja disponível
   */
  private fallbackRmsVad(chunk: Buffer): {
    isSpeech: boolean;
    probability: number;
  } {
    let peak = 0;
    let sum = 0;
    const count = Math.floor(chunk.length / 2);
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const s = Math.abs(chunk.readInt16LE(i));
      if (s > peak) peak = s;
      sum += s * s;
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    const isSpeech = peak >= 1000 || rms >= 180;
    const probability = isSpeech ? 0.8 : 0.05;
    this.lastProbability = probability;

    if (isSpeech && !this.isSpeaking) {
      this.isSpeaking = true;
      this.options.onSpeechStart?.();
    } else if (!isSpeech && this.isSpeaking) {
      this.isSpeaking = false;
      this.options.onSpeechEnd?.(chunk);
    }

    return { isSpeech, probability };
  }

  /**
   * Reseta o estado da sessão de voz.
   */
  public reset(): void {
    this.pcmAccumulator = Buffer.alloc(0);
    this.preRollQueue = [];
    this.speechFrames = [];
    this.isSpeaking = false;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.lastProbability = 0;
    this.context = new Float32Array(64).fill(0);
    if (this.ort) {
      this.stateTensor = new this.ort.Tensor(
        'float32',
        Array.from(new Float32Array(2 * 1 * 128)),
        [2, 1, 128],
      );
    }
  }

  /**
   * Descarrega e retorna qualquer buffer de fala acumulado na sessão atual.
   */
  public flush(): Buffer | null {
    if (this.speechFrames.length > 0) {
      const fullAudio = Buffer.concat(this.speechFrames);
      this.reset();
      return fullAudio;
    }
    this.reset();
    return null;
  }
}

@Injectable()
export class SileroVadService implements OnModuleInit {
  private readonly logger = new Logger(SileroVadService.name);
  private inferenceSession: any | null = null;
  private isInitialized = false;

  public async onModuleInit(): Promise<void> {
    await this.initSession();
  }

  public get available(): boolean {
    return this.isInitialized && this.inferenceSession !== null;
  }

  private async initSession(): Promise<void> {
    const candidatePaths = [
      path.resolve(__dirname, '../models/silero_vad.onnx'),
      path.resolve(process.cwd(), 'src/voice/models/silero_vad.onnx'),
      path.resolve(process.cwd(), 'dist/voice/models/silero_vad.onnx'),
      path.resolve(process.cwd(), 'dist/src/voice/models/silero_vad.onnx'),
    ];

    let resolvedPath = '';
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        resolvedPath = p;
        break;
      }
    }

    if (!resolvedPath) {
      this.logger.warn(
        '⚠️ [SileroVAD] Modelo silero_vad.onnx não encontrado nos caminhos padrão. Operando com VAD acústico.',
      );
      return;
    }

    try {
      if (!ortModule) {
        ortModule = await import('onnxruntime-node');
      }
      this.inferenceSession = await ortModule.InferenceSession.create(
        resolvedPath,
        {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        },
      );
      this.isInitialized = true;
      this.logger.log(
        `🧠 [SileroVAD] Silero VAD v5 inicializado com sucesso via onnxruntime-node (${resolvedPath})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `⚠️ [SileroVAD] onnxruntime-node indisponível (${err.message}). Operando com fallback acústico.`,
      );
    }
  }

  /**
   * Cria uma sessão isolada de VAD neural com estado recorrente independente.
   */
  public createSession(options?: SileroVadSessionOptions): SileroVadSession {
    return new SileroVadSession(this.inferenceSession, ortModule, options);
  }
}
