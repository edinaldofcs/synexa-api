/** Protects only the first audible response, through the end of playback. */
export class InitialSpeechGuard {
  private pending: boolean;
  private active = false;
  private playbackUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    enabled: boolean,
    private readonly setBlocked: (blocked: boolean) => void,
  ) {
    this.pending = enabled;
  }

  begin(): void {
    if (this.pending) {
      this.pending = false;
      this.active = true;
      this.setBlocked(true);
    }
  }

  audio(bytes: number): void {
    if (bytes <= 0 || (!this.pending && !this.active)) return;
    this.begin();
    if (this.timer) clearTimeout(this.timer);
    this.playbackUntil = Math.max(Date.now(), this.playbackUntil) + bytes / 48;
  }

  complete(queuedMs?: number): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    const remaining = queuedMs ?? this.playbackUntil - Date.now();
    this.timer = setTimeout(() => this.cancel(), Math.max(0, remaining) + 200);
  }

  /** End or transfer: never carry the opening protection to another agent. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
    if (this.active) {
      this.active = false;
      this.setBlocked(false);
    }
  }
}
