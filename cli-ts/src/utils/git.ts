/**
 * Git utilities
 * Functions for git operations.
 * In CI environments, prefers CI provider env vars over git commands
 * (avoids detached HEAD issues).
 */

import { spawnSync } from 'child_process';
import { getProjectRoot } from './config';

/**
 * Get current git branch name.
 * In CI, reads from provider env vars first to avoid detached HEAD.
 */
export function getCurrentBranch(): string {
  // GitHub Actions: GITHUB_REF_NAME is branch when GITHUB_REF_TYPE=branch
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REF_TYPE === 'branch' && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  // GitLab CI: CI_COMMIT_REF_NAME is branch when no CI_COMMIT_TAG
  if (process.env.GITLAB_CI && !process.env.CI_COMMIT_TAG && process.env.CI_COMMIT_REF_NAME) {
    return process.env.CI_COMMIT_REF_NAME;
  }
  // Jenkins
  if (process.env.BRANCH_NAME) {
    return process.env.BRANCH_NAME;
  }
  // Buildkite
  if (process.env.BUILDKITE_BRANCH) {
    return process.env.BUILDKITE_BRANCH;
  }

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
 * Get current git commit SHA (short).
 * In CI, reads from provider env vars first.
 */
export function getCommitSha(): string {
  const ciSha = process.env.GITHUB_SHA
    ?? process.env.CI_COMMIT_SHA
    ?? process.env.GIT_COMMIT
    ?? process.env.BUILDKITE_COMMIT;
  if (ciSha) {
    return ciSha.slice(0, 8);
  }

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
