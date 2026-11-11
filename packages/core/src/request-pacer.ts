/** Foreground and background lanes for AI requests, so the person's own requests come first.
 *  Ported from Skim's CloudAIPacer. Background work runs one request at a time (or `width` at once,
 *  for work that streams results the person is watching) and waits while any foreground request is in
 *  flight, so a burst of background work can't fill a rate limit just before the person asks for
 *  something. Cooldowns after a 429 live in `BusyCooldowns` (provider-busy). */
import type { RequestLane } from './provider-busy.js';

type Waiter = { width: number; resolve: () => void };

export class RequestPacer {
  private foreground = 0;
  private background = 0;
  private readonly waiters: Waiter[] = [];

  /** Waits for a slot in `lane`. Pair every call with `finish(lane)`; `run` does both. */
  async start(lane: RequestLane, width = 1): Promise<void> {
    if (lane === 'foreground') { this.foreground += 1; return; }
    const w = Math.max(1, Math.floor(width));
    if (!this.waiters.length && this.foreground === 0 && this.background < w) { this.background += 1; return; }
    await new Promise<void>(resolve => this.waiters.push({ width: w, resolve }));
  }

  finish(lane: RequestLane): void {
    if (lane === 'foreground') this.foreground = Math.max(0, this.foreground - 1);
    else this.background = Math.max(0, this.background - 1);
    this.resumeWaiting();
  }

  /** Runs `work` in `lane`, holding its slot until it settles. */
  async run<T>(lane: RequestLane, work: () => Promise<T>, width = 1): Promise<T> {
    await this.start(lane, width);
    try { return await work(); } finally { this.finish(lane); }
  }

  get waitingInBackground(): number { return this.waiters.length; }
  get inFlightInBackground(): number { return this.background; }
  get inFlightInForeground(): number { return this.foreground; }

  /** Starts waiting background requests in order while their width allows. */
  private resumeWaiting(): void {
    while (this.foreground === 0 && this.waiters.length && this.background < this.waiters[0]!.width) {
      const next = this.waiters.shift()!;
      this.background += 1;
      next.resolve();
    }
  }
}

/** One pacer per app unless tests need their own. */
export const requestPacer = new RequestPacer();
