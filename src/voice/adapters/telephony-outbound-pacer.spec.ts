import { TelephonyOutboundPacer } from './telephony-outbound-pacer';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
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
