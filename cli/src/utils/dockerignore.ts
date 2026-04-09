/**
 * .dockerignore parser.
 * Uses the `ignore` library (same syntax as .gitignore).
 */

import ignore from 'ignore';

/**
 * Parse .dockerignore content and return a filter function.
 * @returns `shouldInclude(relativePath)` — true if the file should be in the context
 */
export function parseDockerignore(content: string): (relativePath: string) => boolean {
  const ig = ignore().add(content);
  return (relativePath: string) => !ig.ignores(relativePath.replace(/\\/g, '/'));
}
