import { InitialSpeechGuard } from './initial-speech-guard';

describe('InitialSpeechGuard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('protects only the first speech through the actual telephone queue', () => {
    const blocked = jest.fn();
    const guard = new InitialSpeechGuard(true, blocked);
    guard.begin();
    guard.audio(48000);
    guard.complete(600);
    expect(blocked.mock.calls).toEqual([[true]]);
    jest.advanceTimersByTime(799);
    expect(blocked).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(blocked.mock.calls).toEqual([[true], [false]]);
    guard.begin();
    guard.audio(48000);
    guard.complete(1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(blocked).toHaveBeenCalledTimes(2);
  });

  it('does not block the first speech of a non-initial or transferred agent', () => {
    const blocked = jest.fn();
    const guard = new InitialSpeechGuard(false, blocked);
    guard.begin();
    guard.audio(48000);
    guard.complete();
    expect(blocked).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('tracks streamed or cached PCM playback when the transport has no queue counter', () => {
    const blocked = jest.fn();
    const guard = new InitialSpeechGuard(true, blocked);
    guard.audio(48000);
    jest.advanceTimersByTime(100);
    guard.audio(48000);
    guard.complete();
    jest.advanceTimersByTime(2099);
    expect(blocked.mock.calls).toEqual([[true]]);
    jest.advanceTimersByTime(1);
    expect(blocked.mock.calls).toEqual([[true], [false]]);
  });

  it('cancels the timer on transfer or hangup without blocking a later agent', () => {
    const blocked = jest.fn();
    const guard = new InitialSpeechGuard(true, blocked);
    guard.audio(48000);
    guard.complete();
    guard.cancel();
    expect(jest.getTimerCount()).toBe(0);
    guard.audio(48000);
    expect(blocked.mock.calls).toEqual([[true], [false]]);
  });
});
