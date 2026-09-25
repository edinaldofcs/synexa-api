/** Wait for already-started persistence/tool callbacks before freezing a call export. */
export class VoiceWorkTracker {
  private readonly pending = new Set<Promise<unknown>>();
  run<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
