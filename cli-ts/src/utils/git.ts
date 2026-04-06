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
  // GitHub Actions
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REF_NAME) {
    // On tag triggers GITHUB_REF_TYPE=tag and git is in detached HEAD.
    // Return the default branch name since there is no branch context.
    if (process.env.GITHUB_REF_TYPE === 'tag') return process.env.GITHUB_EVENT_NAME === 'push' ? getDefaultBranch() : (process.env.GITHUB_BASE_REF || getDefaultBranch());
    return process.env.GITHUB_REF_NAME;
  }
  // GitLab CI
  if (process.env.GITLAB_CI) {
    // On tag pipelines CI_COMMIT_TAG is set but CI_COMMIT_BRANCH is not.
    // CI_COMMIT_REF_NAME equals the tag name — not useful as a branch.
    if (process.env.CI_COMMIT_TAG) return process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || getDefaultBranch();
    if (process.env.CI_COMMIT_REF_NAME) return process.env.CI_COMMIT_REF_NAME;
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
      const branch = result.stdout.trim();
      // Detached HEAD returns literal 'HEAD' — fall through to default
      if (branch !== 'HEAD') return branch;
    }
  } catch {
    // Ignore errors
  }
  return getDefaultBranch();
}

/**
 * Get the default branch name from git (usually 'main' or 'master').
 */
function getDefaultBranch(): string {
  try {
    const result = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
      encoding: 'utf-8',
      cwd: getProjectRoot(),
    });
    if (result.status === 0 && result.stdout) {
      // Returns 'origin/main' or 'origin/master' — strip 'origin/'
      return result.stdout.trim().replace(/^origin\//, '');
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
