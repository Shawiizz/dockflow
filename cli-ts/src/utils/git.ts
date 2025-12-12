/**
 * Git utilities
 * Functions for git operations
 */

import { spawnSync } from 'child_process';
import { getProjectRoot } from './config';

/**
 * Get current git branch name
 */
export function getCurrentBranch(): string {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      cwd: getProjectRoot(),
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore errors
  }
  return 'main';
}

/**
 * Get current git commit SHA (short)
 */
export function getCommitSha(): string {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      cwd: getProjectRoot(),
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore errors
  }
  return 'unknown';
}

/**
 * Check if git repository has uncommitted changes
 */
export function hasUncommittedChanges(): boolean {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      cwd: getProjectRoot(),
    });
    if (result.status === 0) {
      return result.stdout.trim().length > 0;
    }
  } catch {
    // Ignore errors
  }
  return false;
}
