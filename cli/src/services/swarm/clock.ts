/** The time the Swarm waits and polls run on, injectable so tests do not wait. */
export interface SwarmClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: SwarmClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};
