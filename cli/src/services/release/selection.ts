/**
 * Pure release logic without SSH: name validation, metadata parsing, release ordering, and the
 * choice of the rollback target and of the releases to keep. Unit-tested in __tests__/release.test.ts.
 */

import { DeployError, ErrorCode } from '../../utils/errors';
import { CURRENT_LINK, type ReleaseMetadata } from './layout';

/**
 * Stack names and versions become paths under `rm -rf`: each must be one plain path segment (no
 * `/`, no control character, not hidden, and a version cannot shadow `current`).
 */
export function assertReleaseName(value: string, kind: 'stack' | 'version'): void {
  let plain = value !== '' && !value.startsWith('.') && !value.includes('/');
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) plain = false;
  }
  if (kind === 'version' && value === CURRENT_LINK) plain = false;
  if (plain) return;
  const shown = JSON.stringify(value);
  if (kind === 'version') {
    throw new DeployError(
      `Version ${shown} cannot be used as a release directory name`,
      ErrorCode.DEPLOY_FAILED,
      'Use a version without `/` or control characters that does not start with `.` and is not `current`.',
    );
  }
  throw new DeployError(
    `Stack name ${shown} cannot be used as a directory name`,
    ErrorCode.DEPLOY_FAILED,
    'Use a project name and environment without `/` or control characters that do not start with `.`.',
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** newest first: epoch descending, then version descending */
function newestFirst(list: readonly ReleaseMetadata[]): ReleaseMetadata[] {
  return [...list].sort((a, b) => b.epoch - a.epoch || compareText(b.version, a.version));
}

/**
 * Parse the output of the release listing command (one `<directory>\t<metadata JSON>` per line)
 * into ReleaseMetadata entries, newest first. A directory whose metadata is unreadable or names
 * another version is reported through `onCorrupted` and left out: its name is what prune deletes.
 */
export function parseReleaseList(stdout: string, onCorrupted?: (directory: string) => void): ReleaseMetadata[] {
  const releases: ReleaseMetadata[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const directory = tab >= 0 ? line.slice(0, tab) : line;
    const metadata = tab >= 0 ? parseMetadata(line.slice(tab + 1)) : null;
    if (metadata && metadata.version === directory) {
      releases.push(metadata);
    } else {
      onCorrupted?.(directory);
    }
  }
  return newestFirst(releases);
}

export function parseMetadata(text: string): ReleaseMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as ReleaseMetadata;
  if (typeof metadata.version !== 'string' || metadata.version === '') return null;
  if (typeof metadata.epoch === 'number') return metadata;
  return { ...metadata, epoch: Number(metadata.epoch) || 0 };
}

/**
 * The epoch of a new release: the time it is deployed, but always after every stored release, which
 * another machine may have written with its clock ahead of this one. Deploys are serialized by the
 * deploy lock, so the history, ordered by epoch, keeps the order of the deploys.
 */
export function releaseEpoch(now: Date, stored: readonly ReleaseMetadata[]): number {
  return stored.reduce((epoch, release) => Math.max(epoch, release.epoch + 1), Math.floor(now.getTime() / 1000));
}

/** The newest `keep` releases, plus current when it is older; everything else is removed. */
export function selectRetention(
  list: readonly ReleaseMetadata[],
  current: string | null,
  keep: number,
): { kept: ReleaseMetadata[]; removed: ReleaseMetadata[] } {
  const sorted = newestFirst(list);
  const kept = sorted.slice(0, Math.max(0, keep));
  if (current !== null && !kept.some((r) => r.version === current)) {
    const currentRelease = sorted.find((r) => r.version === current);
    if (currentRelease) kept.push(currentRelease);
  }
  const keptVersions = new Set(kept.map((r) => r.version));
  return { kept, removed: sorted.filter((r) => !keptVersions.has(r.version)) };
}

/**
 * The newest release strictly older than current, so a second rollback goes further back. With the
 * failed version known, the newest release other than it. Without a current record, the newest is
 * skipped (it is what runs).
 */
export function selectRollbackTarget(
  list: readonly ReleaseMetadata[],
  current: string | null,
  failedVersion?: string | null,
): ReleaseMetadata | null {
  const sorted = newestFirst(list);
  if (failedVersion) return sorted.find((r) => r.version !== failedVersion) ?? null;
  const index = sorted.findIndex((r) => r.version === current);
  return index === -1 ? (sorted[1] ?? null) : (sorted[index + 1] ?? null);
}
