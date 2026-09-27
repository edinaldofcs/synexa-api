/** PCM s16le mono, 24 kHz input. One instance per continuous audio stream. */
export class StreamingPcmResampler {
  private readonly up: number;
  private readonly down: number;
  private readonly coefficients: Float64Array;
  private readonly history = new Float64Array(255);
  private head = 0;
  private inputIndex = -1;
  private nextOutputTime = 0;
  private byte: number | undefined;

  constructor(readonly outputRate: number) {
    if (![8000, 16000, 24000].includes(outputRate)) {
      throw new RangeError('Unsupported telephony PCM output rate');
    }
    this.up = outputRate === 16000 ? 2 : 1;
    this.down = outputRate === 24000 ? 1 : 3;
    // Hamming-windowed sinc, evaluated only at output instants (polyphase).
    // 8 kHz: passband through 3.4 kHz, cutoff 3.7 kHz, delay 5.3 ms.
    const cutoff = (outputRate * 0.4625) / (24000 * this.up);
    this.coefficients = new Float64Array(255);
    let sum = 0;
    for (let i = 0; i < this.coefficients.length; i++) {
      const x = i - 127;
      const sinc =
        x === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 254);
      sum += this.coefficients[i] = sinc * window;
    }
    for (let i = 0; i < this.coefficients.length; i++) {
      this.coefficients[i] *= this.up / sum;
    }
  }

  get pendingBytes(): number {
    return this.byte === undefined ? 0 : 1;
  }

  push(chunk: Buffer): Buffer {
    if (!chunk.length) return Buffer.alloc(0);
    const input =
      this.byte === undefined
        ? chunk
        : Buffer.concat([Buffer.from([this.byte]), chunk]);
    const usable = input.length - (input.length % 2);
    this.byte = usable < input.length ? input[usable] : undefined;
    if (this.outputRate === 24000) return input.subarray(0, usable);
    const output = Buffer.allocUnsafe(
      (Math.ceil(((usable / 2) * this.up) / this.down) + 1) * 2,
    );
    let offset = 0;
    for (let i = 0; i < usable; i += 2) {
      this.inputIndex++;
      this.head = (this.head + this.history.length - 1) % this.history.length;
      this.history[this.head] = input.readInt16LE(i);
      while (Math.floor(this.nextOutputTime / this.up) === this.inputIndex) {
        const phase = this.nextOutputTime % this.up;
        let sample = 0;
        let index = this.head;
        for (let tap = phase; tap < this.coefficients.length; tap += this.up) {
          sample += this.coefficients[tap] * this.history[index];
          if (++index === this.history.length) index = 0;
        }
        output.writeInt16LE(
          Math.max(-32768, Math.min(32767, Math.round(sample))),
          offset,
        );
        offset += 2;
        this.nextOutputTime += this.down;
      }
    }
    return output.subarray(0, offset);
  }

  /** Drain the FIR tail once at end of turn; an incomplete final sample is discarded. */
  finish(): Buffer {
    this.byte = undefined;
    const tail =
      this.inputIndex >= 0 && this.outputRate !== 24000
        ? this.push(Buffer.alloc(Math.ceil(254 / this.up) * 2))
        : Buffer.alloc(0);
    this.reset();
    return tail;
  }

  reset(): void {
    this.history.fill(0);
    this.head = 0;
    this.inputIndex = -1;
    this.nextOutputTime = 0;
    this.byte = undefined;
  }
}
