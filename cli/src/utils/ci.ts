/** Detects the CI provider and turns its tag or branch into deploy parameters. */

import { getCommitSha } from './git';

export interface CIEnvironment {
  provider: 'github' | 'gitlab' | 'jenkins' | 'buildkite' | 'bitbucket' | 'generic';
  isTag: boolean;
  tag: string | null;
  branch: string | null;
  commitSha: string;
  shortSha: string;
}

/**
 * Detect CI environment from provider-specific env vars.
 * Returns null if not running in CI.
 */
export function detectCIEnvironment(): CIEnvironment | null {
  if (process.env.GITHUB_ACTIONS) {
    const isTag = process.env.GITHUB_REF_TYPE === 'tag';
    const refName = process.env.GITHUB_REF_NAME ?? '';
    const sha = process.env.GITHUB_SHA ?? '';
    return {
      provider: 'github',
      isTag,
      tag: isTag ? refName : null,
      branch: isTag ? null : refName,
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  if (process.env.GITLAB_CI) {
    const tag = process.env.CI_COMMIT_TAG ?? null;
    const sha = process.env.CI_COMMIT_SHA ?? '';
    return {
      provider: 'gitlab',
      isTag: !!tag,
      tag,
      branch: tag ? null : (process.env.CI_COMMIT_REF_NAME ?? null),
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  if (process.env.JENKINS_URL) {
    const tag = process.env.TAG_NAME ?? null;
    const sha = process.env.GIT_COMMIT ?? '';
    return {
      provider: 'jenkins',
      isTag: !!tag,
      tag,
      branch: tag ? null : (process.env.BRANCH_NAME ?? null),
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  if (process.env.BITBUCKET_BUILD_NUMBER) {
    const tag = process.env.BITBUCKET_TAG || null;
    const sha = process.env.BITBUCKET_COMMIT ?? '';
    return {
      provider: 'bitbucket',
      isTag: !!tag,
      tag,
      branch: tag ? null : (process.env.BITBUCKET_BRANCH ?? null),
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  if (process.env.BUILDKITE) {
    const tag = process.env.BUILDKITE_TAG || null;
    const sha = process.env.BUILDKITE_COMMIT ?? '';
    return {
      provider: 'buildkite',
      isTag: !!tag,
      tag,
      branch: tag ? null : (process.env.BUILDKITE_BRANCH ?? null),
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  // CI=true without a known provider: ask git for the sha so the version stays unique
  if (process.env.CI) {
    const sha = getCommitSha();
    return {
      provider: 'generic',
      isTag: false,
      tag: null,
      branch: null,
      commitSha: sha,
      shortSha: sha.slice(0, 8),
    };
  }

  return null;
}

/**
 * Parse a git tag into environment and version.
 *
 * Convention:
 * - `1.0.0` → env=production, version=1.0.0
 * - `1.0.0-staging` → env=staging, version=1.0.0-staging
 * - `v2.0.0-preview` → env=preview, version=2.0.0-preview
 * - `1.0.0-rc1` → env=production (rc1 looks like a pre-release, not an env)
 * - `release/1.0.0` → env=production, version=1.0.0 (prefix stripped)
 *
 * The suffix is an environment name unless it is all digits or a pre-release word
 * (rc, alpha, beta, nightly and the like, optionally followed by digits).
 */
export function parseTagForDeployment(tag: string): { env: string; version: string } {
  let version = tag.startsWith('v') ? tag.slice(1) : tag;

  const slashIdx = version.lastIndexOf('/');
  if (slashIdx !== -1) {
    version = version.slice(slashIdx + 1);
  }

  const lastDash = version.lastIndexOf('-');
  if (lastDash === -1) {
    return { env: 'production', version };
  }

  const suffix = version.slice(lastDash + 1);

  if (/^\d+$/.test(suffix)) {
    return { env: 'production', version };
  }

  if (/^(rc|alpha|beta|dev|pre|canary|hotfix|fix|patch|nightly|snapshot)\d*$/i.test(suffix)) {
    return { env: 'production', version };
  }

  return { env: suffix, version };
}

/**
 * Env and version for a CI run: a tag is parsed by parseTagForDeployment, a branch deploys to
 * production as `<branch>-<short sha>`.
 */
export function resolveDeployParams(ci: CIEnvironment): { env: string; version: string } {
  if (ci.isTag && ci.tag) {
    return parseTagForDeployment(ci.tag);
  }

  const branch = ci.branch ?? 'main';
  const version = ci.shortSha ? `${branch}-${ci.shortSha}` : `${branch}-${Date.now()}`;
  return { env: 'production', version };
}
