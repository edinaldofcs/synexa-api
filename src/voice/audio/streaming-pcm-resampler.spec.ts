import { StreamingPcmResampler } from './streaming-pcm-resampler';

function tone(hz: number, count = 24000): Buffer {
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    pcm.writeInt16LE(
      Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / 24000)),
      i * 2,
    );
  }
  return pcm;
}

function rms(pcm: Buffer): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

describe('StreamingPcmResampler', () => {
  it.each([8000, 16000, 24000])(
    'is byte-identical across arbitrary chunks at %i Hz',
    (rate) => {
      const input = tone(1234, 24007);
      const batch = new StreamingPcmResampler(rate);
      const expected = Buffer.concat([batch.push(input), batch.finish()]);
      for (const size of [1, 3, 317, 2920, 8191]) {
        const stream = new StreamingPcmResampler(rate);
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < input.length; offset += size) {
          chunks.push(stream.push(input.subarray(offset, offset + size)));
        }
        chunks.push(stream.finish());
        expect(Buffer.concat(chunks)).toEqual(expected);
        expect(stream.finish()).toHaveLength(0);
      }
    },
  );

  it.each([5000, 7000])('attenuates %i Hz by at least 40 dB at 8 kHz', (hz) => {
    const input = tone(hz);
    const output = new StreamingPcmResampler(8000).push(input);
    const gainDb = 20 * Math.log10(rms(output.subarray(800)) / rms(input));
    expect(gainDb).toBeLessThan(-40);
  });

  it('preserves 300–3400 Hz within 1 dB at 8 kHz', () => {
    for (let hz = 300; hz <= 3400; hz += 100) {
      const input = tone(hz);
      const output = new StreamingPcmResampler(8000).push(input);
      expect(
        Math.abs(20 * Math.log10(rms(output.subarray(800)) / rms(input))),
      ).toBeLessThan(1);
    }
  });

  it('filters frequencies above the 16 kHz Nyquist limit', () => {
    const input = tone(10000);
    const output = new StreamingPcmResampler(16000).push(input);
    expect(
      20 * Math.log10(rms(output.subarray(1600)) / rms(input)),
    ).toBeLessThan(-40);
  });

  it.each([8000, 16000, 24000])(
    'preserves duration before draining and exact silence at %i Hz',
    (rate) => {
      const stream = new StreamingPcmResampler(rate);
      const output = stream.push(Buffer.alloc(48000));
      expect(output).toHaveLength(rate * 2);
      expect(
        Buffer.concat([output, stream.finish()]).every((byte) => byte === 0),
      ).toBe(true);
    },
  );

  it('discards old filter history and a partial sample on interruption', () => {
    const stream = new StreamingPcmResampler(8000);
    stream.push(tone(1000, 150));
    stream.push(Buffer.from([127]));
    expect(stream.pendingBytes).toBe(1);
    stream.reset();
    expect(stream.pendingBytes).toBe(0);
    expect(stream.push(Buffer.alloc(960)).every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it('drains a final impulse and does not leak it into the next turn', () => {
    const stream = new StreamingPcmResampler(8000);
    const input = Buffer.alloc(480);
    input.writeInt16LE(30000, 478);
    stream.push(input);
    expect(stream.finish().some((byte) => byte !== 0)).toBe(true);
    expect(stream.push(Buffer.alloc(960)).every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it('passes 24 kHz through exactly and discards incomplete final samples', () => {
    const stream = new StreamingPcmResampler(24000);
    const input = tone(1000);
    expect(stream.push(input)).toEqual(input);
    expect(stream.push(Buffer.from([1]))).toHaveLength(0);
    expect(stream.finish()).toHaveLength(0);
    expect(stream.pendingBytes).toBe(0);
  });

  it('rejects unsupported formats', () => {
    expect(() => new StreamingPcmResampler(44100)).toThrow(RangeError);
  });
});
