import { Logger } from '@nestjs/common';
import { StreamingPcmResampler } from '../audio/streaming-pcm-resampler';

/**
 * Pacer de saída compartilhado pelos adapters de telefonia (AudioSocket,
 * Twilio Media Streams...).
 *
 * Entrada: PCM 16-bit LE 24kHz (áudio do Gemini Live), em chunks de
 * qualquer tamanho. Saída: frames PCM 16-bit LE 8kHz de 20ms entregues ao
 * `sink` em cadência constante.
 *
 * Responsabilidades:
 * - Resto entre chunks preservado: sem padding de silêncio no meio da fala
 * - Pre-buffer mínimo antes de iniciar (colchão p/ jitter buffer do cliente)
 * - Pacer contínuo: fila vazia → silêncio; underflow durante geração é contado
 * - Silêncio com decay do último sample + fade-in na retomada (sem cliques)
 * - Fila com teto alto (o Gemini gera mais rápido que o tempo real; teto
 *   baixo descartava frames = "só os últimos segundos tocavam limpos")
 * - `clear()` para barge-in: descarta áudio não reproduzido
 */
export interface TelephonyOutboundPacerOptions {
  /** Taxa do lado telefônico (default 8000 Hz; Vonage L16 usa 16000) */
  sampleRate?: number;
  /** Duração de cada frame (default 20ms) */
  frameMs?: number;
}

const MAX_QUEUE_SECONDS = 15;
const PREBUFFER_FRAMES = 3;
const DECAY_SAMPLES = 20;
const FADE_IN_SAMPLES = 16;

export class TelephonyOutboundPacer {
  private readonly logger = new Logger(TelephonyOutboundPacer.name);
  private readonly resampler: StreamingPcmResampler;
  private readonly frameMs: number;
  private inputActive = false;
  private readonly metrics = {
    inputBytes: 0,
    speechFrames: 0,
    underflowFrames: 0,
    droppedFrames: 0,
    lateTicks: 0,
    maxLatenessMs: 0,
    invalidPcmBytes: 0,
    maxQueueMs: 0,
  };
  private readonly sampleRate: number;
  private readonly frameBytes: number;
  private readonly maxQueueBytes: number;

  /** Resto (< 1 frame) do chunk anterior — evita padding de silêncio */
  private pending: Buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private queueBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOutSample = 0;
  private disposed = false;
  private music?: Buffer;
  private musicOffset = 0;
  private musicActive = false;
  private speechActive = false;
  private speechUntil = 0;
  private musicGain = 0.2;

  public setWaitingMusic(pcm24k: Buffer, volume: number): void {
    const converter = new StreamingPcmResampler(this.sampleRate);
    this.music = Buffer.concat([converter.push(pcm24k), converter.finish()]);
    this.musicOffset = 0;
    this.musicGain = Math.max(0, Math.min(100, volume)) / 100;
    if (this.musicActive) this.startPacer();
  }
  public setWaiting(active: boolean): void {
    this.musicActive = active;
    if (!active) this.musicOffset = 0;
    else this.startPacer();
  }
  public setSpeechActive(active: boolean): void {
    this.speechActive = active;
  }
  private musicFrame(): Buffer | undefined {
    if (
      !this.musicActive ||
      this.speechActive ||
      Date.now() < this.speechUntil ||
      !this.music?.length
    )
      return;
    const frame = Buffer.alloc(this.frameBytes);
    for (let offset = 0; offset < frame.length; offset += 2) {
      frame.writeInt16LE(
        Math.round(this.music.readInt16LE(this.musicOffset) * this.musicGain),
        offset,
      );
      this.musicOffset = (this.musicOffset + 2) % this.music.length;
    }
    return frame;
  }

  constructor(
    private readonly sink: (pcmFrame: Buffer) => void,
    options?: TelephonyOutboundPacerOptions,
  ) {
    this.sampleRate = options?.sampleRate ?? 8000;
    const frameMs = options?.frameMs ?? 20;
    if (!Number.isInteger(frameMs) || frameMs < 10 || frameMs > 60) {
      throw new RangeError('PCM frame duration must be 10–60 ms');
    }
    this.frameMs = frameMs;
    this.resampler = new StreamingPcmResampler(this.sampleRate);
    this.frameBytes = Math.round((this.sampleRate * 2 * frameMs) / 1000);
    // O Gemini gera mais rápido que o tempo real: teto baixo descartava
    // frames no meio da fala. 15s ≈ 240KB por chamada.
    this.maxQueueBytes = this.sampleRate * 2 * MAX_QUEUE_SECONDS;
  }

  /** Enfileira áudio do Gemini (PCM 16-bit LE 24kHz) resampleado à taxa alvo. */
  public enqueue(pcm24k: Buffer): void {
    if (this.disposed || !pcm24k.length) return;
    this.inputActive = true;
    this.metrics.inputBytes += pcm24k.length;
    this.appendPcm(this.resampler.push(pcm24k));
    this.startPacer();
  }

  /** Complete the turn, including short utterances below the prebuffer threshold. */
  public finish(): void {
    if (this.disposed || !this.inputActive) return;
    this.metrics.invalidPcmBytes += this.resampler.pendingBytes;
    this.appendPcm(this.resampler.finish());
    if (this.pending.length) {
      const frame = Buffer.alloc(this.frameBytes);
      this.pending.copy(frame);
      this.enqueueFrame(frame);
      this.pending = Buffer.alloc(0);
    }
    this.inputActive = false;
    this.startPacer(true);
  }

  public getMetrics(): Readonly<typeof this.metrics & { queuedMs: number }> {
    return {
      ...this.metrics,
      queuedMs: (this.queueBytes * 1000) / (this.sampleRate * 2),
    };
  }

  private appendPcm(pcmTel: Buffer): void {
    // Acumula com o resto do chunk anterior: só frame completo é enviado —
    // sem padding de silêncio entre chunks do Gemini.
    let buffer =
      this.pending.length > 0 ? Buffer.concat([this.pending, pcmTel]) : pcmTel;
    while (buffer.length >= this.frameBytes) {
      this.enqueueFrame(Buffer.from(buffer.subarray(0, this.frameBytes)));
      buffer = buffer.subarray(this.frameBytes);
    }
    this.pending = buffer;
  }

  /** Barge-in: descarta o áudio ainda não reproduzido. */
  public clear(): void {
    this.queue = [];
    this.queueBytes = 0;
    this.pending = Buffer.alloc(0);
    this.resampler.reset();
    this.inputActive = false;
    this.speechUntil = 0;
  }

  /** Encerra o pacer (fim da chamada). */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.music = undefined;
    this.musicActive = false;
    this.clear();
    this.stopTimer();
    this.logger.log({
      event: 'telephony_output_summary',
      sampleRate: this.sampleRate,
      ...this.metrics,
    });
  }

  private enqueueFrame(frame: Buffer): void {
    while (this.queueBytes + frame.length > this.maxQueueBytes) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queueBytes -= dropped.length;
      this.metrics.droppedFrames++;
    }
    this.queue.push(frame);
    this.queueBytes += frame.length;
    this.metrics.maxQueueMs = Math.max(
      this.metrics.maxQueueMs,
      (this.queueBytes * 1000) / (this.sampleRate * 2),
    );
  }

  /**
   * Envia 1 frame (20ms) por tick com agendamento por prazo absoluto (sem
   * drift do event loop), iniciado após pre-buffer mínimo.
   *
   * Contínuo: com a fila vazia envia silêncio e contabiliza falta de áudio
   * durante geração. Encerra apenas no dispose().
   */
  private startPacer(force = false): void {
    if (this.timer || this.disposed) return;
    if (
      this.queue.length < PREBUFFER_FRAMES &&
      !(force && this.queue.length > 0) &&
      !(this.musicActive && this.music?.length)
    )
      return;

    let deadline = performance.now();
    const tick = () => {
      const now = performance.now();
      const lateness = Math.max(0, now - deadline);
      this.metrics.maxLatenessMs = Math.max(
        this.metrics.maxLatenessMs,
        lateness,
      );
      if (lateness >= this.frameMs) {
        this.metrics.lateTicks++;
        // After an event-loop stall do not burst old frames into the transport.
        deadline = now;
      }
      const frame = this.queue.shift();
      if (frame) {
        this.metrics.speechFrames++;
        this.speechUntil = Date.now() + 150;
        this.queueBytes -= frame.length;
        // Retomada após silêncio: fade-in curto elimina o clique
        if (this.lastOutSample === 0) this.applyFadeIn(frame);
        this.sink(frame);
        this.lastOutSample =
          frame.length >= 2 ? frame.readInt16LE(frame.length - 2) : 0;
      } else {
        if (this.inputActive) this.metrics.underflowFrames++;
        // Fila vazia: silêncio mantém o fluxo contínuo, com cauda decaindo
        // do último sample para não estalar
        this.sink(this.musicFrame() || this.buildSilenceFrame());
      }
      if (this.disposed) {
        this.timer = null;
        return;
      }
      deadline += this.frameMs;
      this.timer = setTimeout(
        tick,
        Math.max(1, deadline - performance.now()),
      ) as unknown as ReturnType<typeof setInterval>;
      this.timer.unref?.();
    };

    deadline += this.frameMs;
    this.timer = setTimeout(tick, this.frameMs) as unknown as ReturnType<
      typeof setInterval
    >;
    this.timer.unref?.();
  }

  /**
   * Frame de silêncio; na 1ª ocorrência após áudio, inicia com a cauda do
   * último sample decaindo exponencialmente (~2,5ms) — elimina o clique da
   * transição áudio→silêncio.
   */
  private buildSilenceFrame(): Buffer {
    const buf = Buffer.alloc(this.frameBytes, 0x00);
    if (this.lastOutSample !== 0) {
      let v = this.lastOutSample;
      for (let i = 0; i < DECAY_SAMPLES && v !== 0; i++) {
        v = Math.round(v * 0.8);
        buf.writeInt16LE(v, i * 2);
      }
      this.lastOutSample = 0;
    }
    return buf;
  }

  /** Fade-in linear de ~2ms no início do frame (retomada após silêncio). */
  private applyFadeIn(frame: Buffer): void {
    const samples = Math.min(FADE_IN_SAMPLES, frame.length >> 1);
    for (let i = 0; i < samples; i++) {
      const v = frame.readInt16LE(i * 2);
      frame.writeInt16LE(Math.round((v * i) / samples), i * 2);
    }
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
