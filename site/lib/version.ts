import { execFileSync } from 'node:child_process';

let resolved: string | undefined;

/**
 * The current release of Dockflow, without its `v`, resolved once at build time from the latest
 * release tag: DOCKFLOW_RELEASE when set (the image build, which sees only site/, gets it as a
 * build argument), else `git describe` in the repository. The build fails rather than show a
 * stale version. The landing page and the `{{version}}` markers of the docs (lib/remark-version.ts)
 * both read it here.
 */
export function currentVersion(): string {
  if (resolved) return resolved;

  let version = process.env.DOCKFLOW_RELEASE?.trim();
  if (!version) {
    try {
      version = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new Error(
        'cannot resolve the current Dockflow version: set DOCKFLOW_RELEASE (such as 1.0.0), ' +
          'or build from a git clone that has the release tags (git fetch --tags)',
      );
    }
  }

  version = version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error(`the current Dockflow version is not a version: "${version}"`);
  }
  resolved = version;
  return version;
}
