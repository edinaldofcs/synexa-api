import { VoiceWorkTracker } from './voice-work-tracker';
it('waits for pending work even when another callback fails', async () => {
  const tracker = new VoiceWorkTracker();
  let finish!: () => void;
  const work = tracker.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  void tracker
    .run(async () => {
      throw new Error('failed callback');
    })
    .catch(() => undefined);
  let drained = false;
  const drain = tracker.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await work;
  await drain;
  expect(drained).toBe(true);
});
