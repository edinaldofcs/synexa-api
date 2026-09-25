import { VoiceCallSession } from './voice-call-session';
describe('Inactivity telephony hangup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it.each(['live_api', 'hybrid'])(
    'requests physical hangup for %s after the final utterance',
    async (engine) => {
      const adapter = {
        id: 'call',
        hangup: jest.fn().mockResolvedValue(undefined),
      };
      const provider = { sendText: jest.fn() };
      const onAiHangupRequest = jest.fn().mockResolvedValue(undefined);
      const session = new VoiceCallSession({
        telephonyAdapter: adapter as any,
        liveProvider: provider as any,
        audioGateService: {} as any,
        pricingService: {} as any,
        prisma: {} as any,
        config: {
          voiceEngine: engine as 'live_api' | 'hybrid',
          onAiHangupRequest,
          voiceBehavior: {
            idleEnabled: true,
            turns: [{ text: 'Tchau', waitSeconds: 5, endCall: true }],
          },
        },
      });
      const inactivity = (session as any).inactivity;
      inactivity.start();
      jest.advanceTimersByTime(5000);
      expect(provider.sendText).toHaveBeenCalledWith(
        expect.stringContaining('Tchau'),
      );
      expect(adapter.hangup).not.toHaveBeenCalled();
      inactivity.outputComplete();
      await jest.advanceTimersByTimeAsync(300);
      expect(onAiHangupRequest).toHaveBeenCalledTimes(1);
      expect(adapter.hangup).toHaveBeenCalledWith('inactivity');
    },
  );
});
