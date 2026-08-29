import { AudioResampler } from '../audio/audio-resampler.util';

/**
 * Pacer de saída compartilhado pelos adapters de telefonia (AudioSocket,
 * Twilio Media Streams...).
 *
 * Entrada: PCM 16-bit LE 24kHz (áudio do Gemini Live), em chunks de
 * qualquer tamanho. Saída: frames PCM 16-bit LE 8kHz de 20ms entregues ao
 * `sink` em cadência constante.
 *
 * Propriedades (validadas em chamadas reais — ver specs do AudioSocket):
 * - Resto entre chunks preservado: sem padding de silêncio no meio da fala
 * - Pre-buffer mínimo antes de iniciar (colchão p/ jitter buffer do cliente)
 * - Pacer contínuo: fila vazia → silêncio (sem underflow picotado)
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

const MAX_QUEUE_SECONDS = 120;
const PREBUFFER_FRAMES = 3;
const PACER_INTERVAL_MS = 20;
const DECAY_SAMPLES = 20;
const FADE_IN_SAMPLES = 16;

export class TelephonyOutboundPacer {
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

  constructor(
    private readonly sink: (pcmFrame: Buffer) => void,
    options?: TelephonyOutboundPacerOptions,
  ) {
    this.sampleRate = options?.sampleRate ?? 8000;
    const frameMs = options?.frameMs ?? 20;
    this.frameBytes = Math.round((this.sampleRate * 2 * frameMs) / 1000);
    // O Gemini gera mais rápido que o tempo real: teto baixo descartava
    // frames no meio da fala. 120s ≈ 1,9MB por chamada — sem descarte.
    this.maxQueueBytes = this.sampleRate * 2 * MAX_QUEUE_SECONDS;
  }

  /** Enfileira áudio do Gemini (PCM 16-bit LE 24kHz) resampleado à taxa alvo. */
  public enqueue(pcm24k: Buffer): void {
    if (this.disposed) return;
    const pcmTel =
      this.sampleRate === 24000
        ? pcm24k
        : AudioResampler.resample(pcm24k, 24000, this.sampleRate);

    // Acumula com o resto do chunk anterior: só frame completo é enviado —
    // sem padding de silêncio entre chunks do Gemini.
    let buffer =
      this.pending.length > 0 ? Buffer.concat([this.pending, pcmTel]) : pcmTel;
    while (buffer.length >= this.frameBytes) {
      this.enqueueFrame(Buffer.from(buffer.subarray(0, this.frameBytes)));
      buffer = buffer.subarray(this.frameBytes);
    }
    this.pending = buffer;
    this.startPacer();
  }

  /** Barge-in: descarta o áudio ainda não reproduzido. */
  public clear(): void {
    this.queue = [];
    this.queueBytes = 0;
    this.pending = Buffer.alloc(0);
  }

  /** Encerra o pacer (fim da chamada). */
  public dispose(): void {
    this.disposed = true;
    this.clear();
    this.stopTimer();
  }

  private enqueueFrame(frame: Buffer): void {
    while (this.queueBytes + frame.length > this.maxQueueBytes) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queueBytes -= dropped.length;
    }
    this.queue.push(frame);
    this.queueBytes += frame.length;
  }

  /**
   * Envia 1 frame (20ms) por tick com agendamento por prazo absoluto (sem
   * drift do event loop), iniciado após pre-buffer mínimo.
   *
   * Contínuo: com a fila vazia envia silêncio em vez de parar — o fluxo
   * nunca entra em underflow no meio da fala. Encerra apenas no dispose().
   */
  private startPacer(): void {
    if (this.timer) return;
    if (this.queue.length < PREBUFFER_FRAMES) return;

    let deadline = Date.now();
    const tick = () => {
      const frame = this.queue.shift();
      if (frame) {
        this.queueBytes -= frame.length;
        // Retomada após silêncio: fade-in curto elimina o clique
        if (this.lastOutSample === 0) this.applyFadeIn(frame);
        this.sink(frame);
        this.lastOutSample =
          frame.length >= 2 ? frame.readInt16LE(frame.length - 2) : 0;
      } else {
        // Fila vazia: silêncio mantém o fluxo contínuo, com cauda decaindo
        // do último sample para não estalar
        this.sink(this.buildSilenceFrame());
      }
      if (this.disposed) {
        this.timer = null;
        return;
      }
      deadline += PACER_INTERVAL_MS;
      this.timer = setTimeout(
        tick,
        Math.max(1, deadline - Date.now()),
      ) as unknown as ReturnType<typeof setInterval>;
      this.timer.unref?.();
    };

    deadline += PACER_INTERVAL_MS;
    this.timer = setTimeout(tick, PACER_INTERVAL_MS) as unknown as ReturnType<
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
