// FakeClock (design-07 3.1): the Clock of every polling test. Time moves only through advance()
// and runUntilIdle(), so no test ever waits for real time.

import type { Clock } from '../../../services/orchestrator/kubernetes/deps';

export const FAKE_CLOCK_START = '2026-01-01T00:00:00Z';

// Code woken by a sleep usually awaits a fake executor (which answers on a later macrotask) before
// it sleeps again; these turns let it reach that next sleep before time moves on.
const DRAIN_TURNS = 10;

interface Sleeper {
  due: number;
  seq: number;
  resolve(): void;
  detach(): void;
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  private current: number;
  private readonly sleepers: Sleeper[] = [];
  private readonly requested: number[] = [];
  private seq = 0;

  constructor(start: Date = new Date(FAKE_CLOCK_START)) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  /** every sleep requested, in order, in ms (polling cadence assertions: 2 s -> 5 s) */
  get sleeps(): readonly number[] {
    return this.requested;
  }

  /** sleepers still waiting for their time */
  get pending(): number {
    return this.sleepers.length;
  }

  /** resolves when the fake time reaches now+ms, or as soon as `signal` aborts; never waits for real time */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.requested.push(ms);
    if (signal?.aborted || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.remove(sleeper);
        resolve();
      };
      const sleeper: Sleeper = {
        due: this.current + ms,
        seq: this.seq++,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /** advances time by ms, resolving due sleeps in order and draining pending work between them */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`FakeClock.advance needs a non-negative duration, got ${ms}`);
    const target = this.current + ms;
    await this.drain();
    await this.wakeUntil(target);
    this.current = target;
    await this.drain();
  }

  /** runs until no sleeper is pending or maxMs elapsed; returns the elapsed fake ms */
  async runUntilIdle(maxMs: number): Promise<number> {
    const start = this.current;
    const limit = start + maxMs;
    await this.drain();
    await this.wakeUntil(limit);
    if (this.sleepers.length > 0) this.current = limit;
    return this.current - start;
  }

  private async wakeUntil(limit: number): Promise<void> {
    for (let next = this.nextDue(limit); next !== null; next = this.nextDue(limit)) {
      this.current = next.due;
      this.remove(next);
      next.detach();
      next.resolve();
      await this.drain();
    }
  }

  private nextDue(limit: number): Sleeper | null {
    let best: Sleeper | null = null;
    for (const sleeper of this.sleepers) {
      if (sleeper.due > limit) continue;
      if (best === null || sleeper.due < best.due || (sleeper.due === best.due && sleeper.seq < best.seq)) best = sleeper;
    }
    return best;
  }

  private remove(sleeper: Sleeper): void {
    const index = this.sleepers.indexOf(sleeper);
    if (index !== -1) this.sleepers.splice(index, 1);
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < DRAIN_TURNS; i++) await turn();
  }
}
