/** Texts both lock stores print, so Swarm and Kubernetes say the same thing. */

import type { LockData } from './interfaces';

/** A stale takeover is worth saying: the holder's deploy most likely died without releasing it. */
export function staleTakeoverMessage(holder: LockData | null, minutes: number | null): string {
  if (holder === null) return 'Lock could not be read and is treated as stale; taking it over';
  const age = minutes === null || !Number.isFinite(minutes) ? '' : ` (${minutes} min old)`;
  return `Lock of ${holder.performer}${age} is stale; taking it over`;
}
