/**
 * Version utilities
 * Functions for version management and auto-increment
 */

import type { Orchestrator } from '../services/orchestrator/interfaces';

/**
 * Increment version string
 * Examples:
 *   1.0.0 -> 1.0.1
 *   1.0.0-beta -> 1.0.0-beta2
 *   1.0.0-beta2 -> 1.0.0-beta3
 *   main-abc123 -> main-abc123-2
 */
export function incrementVersion(version: string): string {
  // Branch-SHA pattern (e.g., main-abc12345, develop-f3a1b2c8) — append -2 counter
  // Must be checked first to avoid the suffixMatch regex corrupting hex SHAs
  if (/^.+-[0-9a-f]{6,}$/i.test(version)) {
    return `${version}-2`;
  }

  // Check if version ends with a number after a letter (e.g., beta2, rc3)
  const suffixMatch = version.match(/^(.+[a-zA-Z])(\d+)$/);
  if (suffixMatch) {
    const [, base, num] = suffixMatch;
    return `${base}${parseInt(num) + 1}`;
  }

  // Check if version is semver-like (ends with .number)
  const semverMatch = version.match(/^(.+)\.(\d+)$/);
  if (semverMatch) {
    const [, base, num] = semverMatch;
    return `${base}.${parseInt(num) + 1}`;
  }

  // Check if version ends with -number (e.g., main-abc123-2)
  const dashNumMatch = version.match(/^(.+)-(\d+)$/);
  if (dashNumMatch) {
    const [, base, num] = dashNumMatch;
    return `${base}-${parseInt(num) + 1}`;
  }

  // Pre-release label ending in letters with a dash separator (e.g., 1.0.0-beta)
  if (/[a-zA-Z]$/.test(version) && /-[a-zA-Z]/.test(version)) {
    return `${version}2`;
  }

  // Default: append -2
  return `${version}-2`;
}

/**
 * The newest release recorded for the stack, null when it has none. An unreachable store is an
 * error, never "no release": with the in-cluster store that would restart versioning at 1.0.0 (I-21).
 */
export async function getLatestVersion(orchestrator: Orchestrator, stackName: string): Promise<string | null> {
  return orchestrator.releases.latestVersion(stackName);
}
