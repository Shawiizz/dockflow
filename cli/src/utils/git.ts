/** Branch and commit lookups. In CI the provider's env vars win over git, which is often in detached HEAD. */

import { spawnSync } from 'child_process';
import { getProjectRoot } from './config';

/** The current branch; on a CI tag build, which has no branch, the default branch instead. */
export function getCurrentBranch(): string {
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REF_NAME) {
    // a tag trigger leaves git in detached HEAD with no branch context: use the default branch
    // (the base branch outside of pushes)
    if (process.env.GITHUB_REF_TYPE === 'tag') return process.env.GITHUB_EVENT_NAME === 'push' ? getDefaultBranch() : (process.env.GITHUB_BASE_REF || getDefaultBranch());
    return process.env.GITHUB_REF_NAME;
  }
  if (process.env.GITLAB_CI) {
    // on tag pipelines CI_COMMIT_REF_NAME is the tag name, which is no branch
    if (process.env.CI_COMMIT_TAG) return process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || getDefaultBranch();
    if (process.env.CI_COMMIT_REF_NAME) return process.env.CI_COMMIT_REF_NAME;
  }
  if (process.env.BRANCH_NAME) {
    return process.env.BRANCH_NAME;
  }
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
      // a detached HEAD prints the literal 'HEAD': fall through to the default
      if (branch !== 'HEAD') return branch;
    }
  } catch {
    // a failing git must not break the lookup: fall through to the default
  }
  return getDefaultBranch();
}

/** What origin/HEAD points at, or 'main' when git cannot say. */
function getDefaultBranch(): string {
  try {
    const result = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
      encoding: 'utf-8',
      cwd: getProjectRoot(),
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().replace(/^origin\//, '');
    }
  } catch {
    // a failing git must not break the lookup
  }
  return 'main';
}

/** The short commit sha (8 characters from a CI variable); 'unknown' when git cannot say. */
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
    // a failing git must not break the lookup
  }
  return 'unknown';
}
