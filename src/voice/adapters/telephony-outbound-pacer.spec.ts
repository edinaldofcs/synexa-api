import { TelephonyOutboundPacer } from './telephony-outbound-pacer';
import { Logger } from '@nestjs/common';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function constant(samples: number, value = 10000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
}

it.each([8000, 16000, 24000])(
  'drains short turns and the final partial frame at %i Hz',
  (sampleRate) => {
    const frames: Buffer[] = [];
    const pacer = new TelephonyOutboundPacer((frame) => frames.push(frame), {
      sampleRate,
    });
    pacer.enqueue(constant(240)); // 10ms: too short for the initial prebuffer.
    jest.advanceTimersByTime(100);
    expect(frames).toHaveLength(0);
    pacer.finish();
    pacer.finish(); // Idempotent, no duplicate tail.
    jest.advanceTimersByTime(100);
    expect(frames).toHaveLength(5);
    expect(frames[0].some((byte) => byte !== 0)).toBe(true);
    expect(
      frames.every((frame) => frame.length === sampleRate * 2 * 0.02),
    ).toBe(true);
    expect(frames.at(-1)!.every((byte) => byte === 0)).toBe(true);
    expect(pacer.getMetrics().underflowFrames).toBe(0);
    pacer.dispose();
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('produces identical playback for whole and fragmented input, including odd byte boundaries', () => {
  const render = (size: number) => {
    const frames: Buffer[] = [];
    const pacer = new TelephonyOutboundPacer((frame) => frames.push(frame));
    const pcm = constant(24000);
    for (let i = 0; i < pcm.length; i += size)
      pacer.enqueue(pcm.subarray(i, i + size));
    pacer.finish();
    jest.advanceTimersByTime(1100);
    pacer.dispose();
    return Buffer.concat(frames);
  };
  expect(render(317)).toEqual(render(48000));
});

it('resets FIR state and pending bytes on interruption', () => {
  const frames: Buffer[] = [];
  const pacer = new TelephonyOutboundPacer((frame) => frames.push(frame));
  pacer.enqueue(constant(100));
  pacer.enqueue(Buffer.from([255]));
  pacer.clear();
  pacer.enqueue(constant(240, 0));
  pacer.finish();
  jest.advanceTimersByTime(100);
  expect(Buffer.concat(frames).every((byte) => byte === 0)).toBe(true);
  pacer.dispose();
});

it('keeps waiting music conversion independent from speech', () => {
  const render = (withMusic: boolean) => {
    const frames: Buffer[] = [];
    const pacer = new TelephonyOutboundPacer((frame) => frames.push(frame));
    pacer.enqueue(constant(720));
    if (withMusic) pacer.setWaitingMusic(constant(500, -20000), 20);
    pacer.enqueue(constant(720));
    pacer.finish();
    jest.advanceTimersByTime(100);
    pacer.dispose();
    return Buffer.concat(frames);
  };
  expect(render(true)).toEqual(render(false));
});

it('counts starvation only while generation is open and reports numeric metrics once', () => {
  const log = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  const pacer = new TelephonyOutboundPacer(() => undefined);
  pacer.enqueue(constant(1440));
  jest.advanceTimersByTime(100);
  expect(pacer.getMetrics().underflowFrames).toBe(2);
  pacer.finish();
  jest.advanceTimersByTime(100);
  expect(pacer.getMetrics().underflowFrames).toBe(2);
  pacer.dispose();
  pacer.dispose();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'telephony_output_summary',
      underflowFrames: 2,
    }),
  );
  log.mockRestore();
});

it('bounds the queue and counts overflow and malformed trailing PCM', () => {
  const pacer = new TelephonyOutboundPacer(() => undefined, {
    sampleRate: 24000,
  });
  pacer.enqueue(constant(24000 * 16));
  pacer.enqueue(Buffer.from([1]));
  pacer.finish();
  expect(pacer.getMetrics()).toMatchObject({
    droppedFrames: 50,
    maxQueueMs: 15000,
    invalidPcmBytes: 1,
  });
  pacer.dispose();
});

it('counts a delayed tick and reanchors rather than sending a burst', () => {
  const frames: Buffer[] = [];
  const now = jest.spyOn(performance, 'now');
  now.mockReturnValue(0);
  const pacer = new TelephonyOutboundPacer((frame) => frames.push(frame));
  pacer.enqueue(constant(4800));
  now.mockReturnValue(120);
  jest.advanceTimersByTime(20);
  expect(frames).toHaveLength(1);
  expect(pacer.getMetrics()).toMatchObject({
    lateTicks: 1,
    maxLatenessMs: 100,
  });
  jest.advanceTimersByTime(19);
  expect(frames).toHaveLength(1);
  now.mockReturnValue(140);
  jest.advanceTimersByTime(1);
  expect(frames).toHaveLength(2);
  pacer.dispose();
  now.mockRestore();
});
it('loops background independently, pauses for speech and stops without clearing queued speech', () => {
  const frames: Buffer[] = [];
  const pacer = new TelephonyOutboundPacer(
    (frame) => frames.push(Buffer.from(frame)),
    { sampleRate: 24000 },
  );
  const music = Buffer.alloc(960);
  for (let i = 0; i < music.length; i += 2) music.writeInt16LE(1000, i);
  pacer.setWaitingMusic(music, 20);
  pacer.setWaiting(true);
  jest.advanceTimersByTime(60);
  expect(frames).toHaveLength(3);
  expect(frames[2].readInt16LE(100)).toBe(200);
  pacer.setSpeechActive(true);
  jest.advanceTimersByTime(20);
  expect(frames.at(-1)!.readInt16LE(100)).toBe(0);
  pacer.setSpeechActive(false);
  jest.advanceTimersByTime(20);
  expect(frames.at(-1)!.readInt16LE(100)).toBe(200);
  pacer.enqueue(music);
  pacer.setWaiting(false);
  jest.advanceTimersByTime(20);
  expect(frames.at(-1)!.readInt16LE(100)).toBe(1000);
  jest.advanceTimersByTime(60);
  expect(frames.at(-1)!.readInt16LE(100)).toBe(0);
  pacer.dispose();
  expect(jest.getTimerCount()).toBe(0);
});
