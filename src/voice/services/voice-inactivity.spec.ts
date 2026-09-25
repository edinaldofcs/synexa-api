import { readInactivityTurns, VoiceInactivity } from './voice-inactivity';
describe('VoiceInactivity (all providers)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const setup = (final = true) => {
    const speak = jest.fn(),
      hangup = jest.fn(),
      timeout = jest.fn();
    const controller = new VoiceInactivity(
      [{ text: 'Está aí?', waitSeconds: 5, endCall: final }],
      speak,
      hangup,
      timeout,
    );
    controller.start();
    return { controller, speak, hangup, timeout };
  };
  it('ends after the first configured farewell and waits for audio playback', () => {
    const { controller, speak, hangup } = setup();
    jest.advanceTimersByTime(5000);
    expect(speak).toHaveBeenCalledWith('Está aí?');
    controller.outputAudio(48000);
    controller.outputComplete();
    jest.advanceTimersByTime(1000);
    expect(hangup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(300);
    expect(hangup).toHaveBeenCalledTimes(1);
  });
  it('restarts the sequence on user speech and cancels a pending end', () => {
    const { controller, hangup, speak } = setup();
    jest.advanceTimersByTime(5000);
    controller.outputComplete();
    controller.interrupted();
    jest.advanceTimersByTime(300);
    expect(hangup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(4700);
    expect(speak).toHaveBeenCalledTimes(2);
    controller.stop();
  });
  it('supports multiple turns, measures delay after playback and closes only the final one', () => {
    const speak = jest.fn(),
      end = jest.fn();
    const controller = new VoiceInactivity(
      [
        { text: 'Primeira', waitSeconds: 5, endCall: false },
        { text: 'Tchau', waitSeconds: 10, endCall: true },
      ],
      speak,
      end,
    );
    controller.start();
    jest.advanceTimersByTime(5000);
    controller.outputAudio(96000);
    controller.outputComplete();
    jest.advanceTimersByTime(12299);
    expect(speak).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(speak).toHaveBeenLastCalledWith('Tchau');
    expect(end).not.toHaveBeenCalled();
    controller.outputComplete();
    jest.advanceTimersByTime(300);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an exhausted non-final sequence or fire after stop', () => {
    const { controller, speak, hangup } = setup(false);
    jest.advanceTimersByTime(5000);
    controller.outputComplete();
    jest.advanceTimersByTime(100000);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(hangup).not.toHaveBeenCalled();
    controller.userActivity();
    controller.stop();
    jest.advanceTimersByTime(100000);
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('times out failed generation without leaving a final call open', () => {
    const { hangup, timeout } = setup();
    jest.advanceTimersByTime(65000);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(hangup).toHaveBeenCalledTimes(1);
  });
  it('stays disabled with no valid turns, including while provider output arrives', () => {
    const end = jest.fn();
    const controller = new VoiceInactivity([], jest.fn(), end, end);
    controller.start();
    controller.outputStarted();
    jest.advanceTimersByTime(100000);
    expect(end).not.toHaveBeenCalled();
  });
  it('ignores silence but resets the clock on incoming speech', () => {
    const { controller, speak } = setup();
    jest.advanceTimersByTime(4000);
    controller.inputAudio(Buffer.alloc(320));
    const speech = Buffer.alloc(320);
    for (let i = 0; i < 320; i += 2) speech.writeInt16LE(1000, i);
    controller.inputAudio(speech);
    jest.advanceTimersByTime(4000);
    expect(speak).not.toHaveBeenCalled();
    controller.stop();
  });
  it('validates settings, skips blank text and truncates after the terminal turn', () => {
    expect(readInactivityTurns({ idleEnabled: false, turns: [{}] })).toEqual(
      [],
    );
    expect(
      readInactivityTurns({
        idleEnabled: true,
        turns: [
          { text: '' },
          { text: 'Tchau', waitSeconds: -4, endCall: true },
          { text: 'Nunca' },
        ],
      }),
    ).toEqual([{ text: 'Tchau', waitSeconds: 5, endCall: true }]);
  });
});
