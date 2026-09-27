import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { CallFlexAdapter, CallFlexAdapterConfig } from './callflex.adapter';
import { G711Codec } from '../../audio/g711-codec.util';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it.each([
  ['g711_ulaw', 160, 8000],
  ['g711_alaw', 160, 8000],
  ['pcm_8k', 320, 8000],
  ['pcm_16k', 640, 16000],
] as const)(
  'sends filtered 20ms %s frames and drains the final turn',
  (format, bytes, rate) => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn(),
    });
    const adapter = new CallFlexAdapter({
      audioFormat: format,
      wsSocket: socket as unknown as CallFlexAdapterConfig['wsSocket'],
    });
    const pcm = Buffer.alloc(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(10000, i);
    adapter.sendAudio(pcm);
    adapter.finishAudio();
    jest.advanceTimersByTime(200);
    expect(adapter.sampleRate).toBe(rate);
    const frames = socket.send.mock.calls.map(([frame]) => frame as Buffer);
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.length === bytes)).toBe(true);
    const stable =
      format === 'g711_ulaw'
        ? G711Codec.decodeUlaw(frames[1])
        : format === 'g711_alaw'
          ? G711Codec.decodeAlaw(frames[1])
          : frames[1];
    expect(Math.abs(stable.readInt16LE(100) - 10000)).toBeLessThan(500);
    socket.emit('close');
    expect(jest.getTimerCount()).toBe(0);
    adapter.sendAudio(pcm);
    adapter.finishAudio();
    expect(jest.getTimerCount()).toBe(0);
  },
);
