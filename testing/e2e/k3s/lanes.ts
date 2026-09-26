/**
 * k3s e2e lanes (design-07 16.9): which topology a lane's preload provisions, which test directory
 * `run.ts` walks, its documented time budget, and its failure mode.
 *
 * `failFast: true` (every shared-cluster lane) stops the lane at the first file that fails, since a
 * broken shared cluster would otherwise fail every later file for an unrelated reason (K67 (a)).
 * `failFast: false` lanes give each file its own containers (`topology: null`, k3s-setup) or run
 * independent one-off scenarios (nightly), so one file's failure cannot affect another.
 *
 * `k3s-rollback` was split off design-07's `k3s-lifecycle`, whose two files took 37 min together.
 *
 * `nightly` is not part of design-07's own LANES table (16.9 lists the gated lanes only): it is
 * added here so `run.ts nightly --file <name>` (P85's contract, WORK-PACKAGES §3) resolves to a lane
 * like any other. Its files provision what they individually need, so it carries no shared topology.
 */

import type { TopologyName } from "../helpers/topology";

export interface Lane {
  /** the shared topology the preload provisions, or null when each file manages its own containers */
  readonly topology: TopologyName | null;
  /** relative to this file's directory */
  readonly dir: string;
  readonly budgetMin: number;
  readonly failFast: boolean;
}

export const LANES = {
  "k3s-core": { topology: "duo", dir: "tests/core", budgetMin: 25, failFast: true },
  "k3s-lifecycle": { topology: "duo", dir: "tests/lifecycle", budgetMin: 12, failFast: true },
  "k3s-rollback": { topology: "duo", dir: "tests/rollback", budgetMin: 35, failFast: true },
  "k3s-day2": { topology: "duo", dir: "tests/day2", budgetMin: 25, failFast: true },
  "k3s-multinode": { topology: "trio", dir: "tests/multinode", budgetMin: 25, failFast: true },
  "k3s-proxy-helm": { topology: "duo", dir: "tests/proxy-helm", budgetMin: 28, failFast: true },
  "k3s-ha": { topology: "ha", dir: "tests/ha", budgetMin: 25, failFast: true },
  "k3s-setup": { topology: null, dir: "tests/setup", budgetMin: 45, failFast: false },
  nightly: { topology: null, dir: "tests/nightly", budgetMin: 60, failFast: false },
} as const satisfies Record<string, Lane>;

export type LaneName = keyof typeof LANES;

export const LANE_NAMES: readonly LaneName[] = Object.keys(LANES) as LaneName[];

export function isLaneName(value: string): value is LaneName {
  return Object.hasOwn(LANES, value);
}
