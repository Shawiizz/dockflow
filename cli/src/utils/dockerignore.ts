/**
 * .dockerignore parser.
 * Uses the `ignore` library (same syntax as .gitignore).
 */

import ignore from 'ignore';

// Always excluded from build context regardless of .dockerignore content.
const ALWAYS_EXCLUDED = ['.env.dockflow', '**/.env.dockflow'];

/**
 * Parse .dockerignore content and return a filter function.
 * @returns `shouldInclude(relativePath)` — true if the file should be in the context
 */
export function parseDockerignore(content: string): (relativePath: string) => boolean {
  const ig = ignore().add(content).add(ALWAYS_EXCLUDED);
  return (relativePath: string) => !ig.ignores(relativePath.replace(/\\/g, '/'));
}
