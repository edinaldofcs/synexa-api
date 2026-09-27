import { ApiWaitController } from './api-wait-controller';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('does not fail an API when the music transport disappears', async () => {
  const onError = jest.fn();
  const wait = new ApiWaitController(() => {
    throw new Error('closed');
  }, onError);
  let finish!: (value: string) => void;
  const result = wait.run(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  jest.advanceTimersByTime(1000);
  finish('ok');
  await expect(result).resolves.toBe('ok');
  expect(onError).toHaveBeenCalledTimes(2);
});
it('avoids fast queries and waits for all overlapping executions, including rejection', async () => {
  const change = jest.fn();
  const wait = new ApiWaitController(change);
  await wait.run(async () => 1);
  jest.advanceTimersByTime(1000);
  expect(change).not.toHaveBeenCalled();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const one = wait.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const two = wait
    .run(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    )
    .catch(() => undefined);
  jest.advanceTimersByTime(999);
  expect(change).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(change.mock.calls).toEqual([[true]]);
  finish();
  await one;
  expect(change.mock.calls).toEqual([[true]]);
  fail(new Error('timeout'));
  await two;
  expect(change.mock.calls).toEqual([[true], [false]]);
  expect(jest.getTimerCount()).toBe(0);
});
it('ignores results from a transferred/disconnected generation and releases timers', async () => {
  const change = jest.fn();
  const wait = new ApiWaitController(change);
  let finish!: () => void;
  const old = wait.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  jest.advanceTimersByTime(1000);
  wait.cancel();
  await wait.run(async () => 2);
  finish();
  await old;
  expect(change.mock.calls).toEqual([[true], [false]]);
  wait.dispose();
  await wait.run(async () => 3);
  jest.advanceTimersByTime(2000);
  expect(jest.getTimerCount()).toBe(0);
});
