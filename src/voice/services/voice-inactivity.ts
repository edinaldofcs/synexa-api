export interface InactivityTurn {
  text: string;
  waitSeconds: number;
  endCall: boolean;
}

export function readInactivityTurns(raw: unknown): InactivityTurn[] {
  if (!raw || typeof raw !== 'object') return [];
  const config = raw as Record<string, unknown>;
  if (config.idleEnabled !== true || !Array.isArray(config.turns)) return [];
  const turns: InactivityTurn[] = [];
  for (const item of config.turns.slice(0, 100)) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
    turns.push({
      text: item.text.trim().slice(0, 1000),
      waitSeconds:
        typeof item.waitSeconds === 'number' &&
        Number.isFinite(item.waitSeconds)
          ? Math.max(5, Math.min(600, item.waitSeconds))
          : 15,
      endCall: item.endCall === true,
    });
    if (item.endCall === true) break;
  }
  return turns;
}

/** Shared by browser and telephony, independent of the speech provider. */
export class VoiceInactivity {
  private timer?: ReturnType<typeof setTimeout>;
  private index = 0;
  private active = false;
  private ending = false;
  private playbackUntil = 0;

  constructor(
    private readonly turns: InactivityTurn[],
    private readonly speak: (text: string) => void,
    private readonly hangup: () => void,
    private readonly onTimeout: () => void = () => {},
  ) {}

  start() {
    this.active = this.turns.length > 0;
    this.schedule();
  }
  stop() {
    this.active = false;
    this.clear();
  }
  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private later(callback: () => void, ms: number) {
    this.clear();
    if (this.active) this.timer = setTimeout(callback, ms);
  }
  userActivity() {
    if (!this.active) return;
    this.index = 0;
    this.ending = false;
    this.schedule();
  }
  inputAudio(pcm: Buffer) {
    if (!this.active || pcm.length < 2) return;
    let energy = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2)
      energy += pcm.readInt16LE(i) ** 2;
    if (Math.sqrt(energy / Math.floor(pcm.length / 2)) >= 700)
      this.userActivity();
  }
  outputStarted() {
    this.later(() => {
      this.onTimeout();
      if (this.ending) {
        this.stop();
        this.hangup();
      } else this.schedule();
    }, 60000);
  }
  outputAudio(bytes: number) {
    this.playbackUntil = Math.max(Date.now(), this.playbackUntil) + bytes / 48;
    this.outputStarted();
  }
  interrupted() {
    this.playbackUntil = 0;
    this.userActivity();
  }
  outputComplete() {
    const delay = Math.max(0, this.playbackUntil - Date.now()) + 300;
    this.later(() => {
      if (this.ending) {
        this.stop();
        this.hangup();
      } else this.schedule();
    }, delay);
  }
  private schedule() {
    this.clear();
    const turn = this.turns[this.index];
    if (!this.active || !turn) return;
    this.later(() => {
      this.index++;
      this.ending = turn.endCall;
      this.outputStarted();
      try {
        this.speak(turn.text);
      } catch {
        this.onTimeout();
        if (this.ending) {
          this.stop();
          this.hangup();
        } else this.schedule();
      }
    }, turn.waitSeconds * 1000);
  }
}
