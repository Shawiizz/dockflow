/**
 * CI environment detection utilities
 * Auto-detects CI provider, tag/branch, and resolves deploy parameters.
 */

export interface CIEnvironment {
  provider: 'github' | 'gitlab' | 'jenkins' | 'buildkite' | 'generic';
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

  // Generic CI detection (CI=true but no known provider)
  if (process.env.CI) {
    return {
      provider: 'generic',
      isTag: false,
      tag: null,
      branch: null,
      commitSha: '',
      shortSha: '',
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
 *
 * The suffix is treated as an environment name only if it contains
 * at least one letter and is NOT a common pre-release pattern (rc, alpha, beta, dev + digits).
 */
export function parseTagForDeployment(tag: string): { env: string; version: string } {
  // Strip leading 'v'
  const version = tag.startsWith('v') ? tag.slice(1) : tag;

  const lastDash = version.lastIndexOf('-');
  if (lastDash === -1) {
    return { env: 'production', version };
  }

  const suffix = version.slice(lastDash + 1);

  // Pure numeric suffix (e.g., 1.0.0-1) → not an env
  if (/^\d+$/.test(suffix)) {
    return { env: 'production', version };
  }

  // Common pre-release patterns → not an env
  if (/^(rc|alpha|beta|dev|pre|canary)\d*$/i.test(suffix)) {
    return { env: 'production', version };
  }

  return { env: suffix, version };
}

/**
 * Resolve deploy parameters (env + version) from CI environment.
 * For tags: parses env from tag suffix.
 * For branches: defaults to production with branch-sha as version.
 */
export function resolveDeployParams(ci: CIEnvironment): { env: string; version: string } {
  if (ci.isTag && ci.tag) {
    return parseTagForDeployment(ci.tag);
  }

  // Branch deploy
  const branch = ci.branch ?? 'main';
  const version = ci.shortSha ? `${branch}-${ci.shortSha}` : branch;
  return { env: 'production', version };
}
