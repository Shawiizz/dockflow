import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The current release of Dockflow, read at build time from what a release commit updates:
 * `.github/release` when the repository is there, else (in the image build, which sees only site/)
 * the Introduction's "The current release is **…**". The build fails rather than show a stale version.
 */
export function currentVersion(): string {
  const release = join(process.cwd(), '..', '.github', 'release');
  if (existsSync(release)) return readFileSync(release, 'utf8').trim().replace(/^v/, '');

  const intro = readFileSync(join(process.cwd(), 'content/docs/start/introduction.mdx'), 'utf8');
  const m = intro.match(/The current release is \*\*([^*]+)\*\*/);
  if (!m) throw new Error('the current version is neither in ../.github/release nor in the Introduction');
  return m[1];
}
