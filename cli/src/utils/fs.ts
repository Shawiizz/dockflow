import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/** Recursively walk a directory and return all file paths. */
export function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Creates the directory (and its parents) and gives it exactly `mode`, whatever the umask: a
 * restrictive umask must not hide a directory the deploy user has to traverse, and a directory
 * created under one earlier is repaired.
 */
export function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
}
