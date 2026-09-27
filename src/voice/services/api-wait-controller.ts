/** One controller per call; a root execution includes all recursively chained APIs. */
export class ApiWaitController {
  private pending = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private disposed = false;
  private generation = 0;
  constructor(
    private readonly change: (active: boolean) => void,
    private readonly onError: () => void = () => {},
  ) {}
  private notify(active: boolean) {
    try {
      this.change(active);
    } catch {
      this.onError();
    }
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (!this.disposed && ++this.pending === 1) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.disposed && this.pending) {
          this.active = true;
          this.notify(true);
        }
      }, 1000);
    }
    try {
      return await operation();
    } finally {
      if (
        !this.disposed &&
        generation === this.generation &&
        --this.pending === 0
      )
        this.stop();
    }
  }
  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active) {
      this.active = false;
      this.notify(false);
    }
  }
  cancel() {
    this.generation++;
    this.pending = 0;
    this.stop();
  }
  dispose() {
    this.disposed = true;
    this.cancel();
  }
}
