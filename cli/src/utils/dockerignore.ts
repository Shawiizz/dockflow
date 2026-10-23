/** Builds the .dockerignore filter (gitignore syntax, through the `ignore` library). */

import ignore from 'ignore';

// kept out of the build context whatever the .dockerignore says
const ALWAYS_EXCLUDED = ['.env.dockflow', '**/.env.dockflow'];

/**
 * Returns `shouldInclude(relativePath)`, true when the file belongs in the build context.
 * Backslashes in the path are read as separators.
 */
export function parseDockerignore(content: string): (relativePath: string) => boolean {
  const ig = ignore().add(content).add(ALWAYS_EXCLUDED);
  return (relativePath: string) => !ig.ignores(relativePath.replace(/\\/g, '/'));
}
