/**
 * The FileResolver of a deploy (design-01 1.5, DESIGN-CORE 6.1): the files compose reads
 * (env_file, label_file, secrets and configs), relative to the compose file's directory and never
 * outside the project. A file Nunjucks rendered is returned as rendered text when the source is
 * valid UTF-8, and as its raw bytes otherwise, because renderTemplates decodes every file as UTF-8
 * and would corrupt a keystore or a DER certificate kept under `.dockflow/`. Every path it resolved
 * is recorded with the digest of what it returned, so a memoized render can tell whether the files
 * it read have changed since (design-03 4).
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256Hex } from '../../utils/hash';
import type { FileResolveFailure, FileResolver } from './interfaces';

type Resolution = ReturnType<FileResolver>;

export type RecordingFileResolver = FileResolver & {
  /** every path resolved so far -> resolutionDigest of the last result, keys in code-unit order */
  digests(): Record<string, string>;
};

/** sha256 of the returned bytes, or `!<reason>` for a failure (never a valid sha256). */
export function resolutionDigest(result: Resolution): string {
  return result.ok ? sha256Hex(result.bytes) : `!${result.reason}`;
}

/** Wraps a resolver so that it records what it returned for every path. */
export function withDigests(resolver: FileResolver): RecordingFileResolver {
  const seen = new Map<string, string>();
  const recording = (path: string): Resolution => {
    const result = resolver(path);
    seen.set(path, resolutionDigest(result));
    return result;
  };
  const digests = (): Record<string, string> =>
    Object.fromEntries([...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return Object.assign(recording, { digests });
}

/**
 * `renderedMap`: renderTemplates output, keyed by project-relative POSIX path. `composeDir`: the
 * directory of the compose file (absolute, or relative to `projectRoot`); paths are resolved
 * against it, which is the project root only in the flat layout.
 */
export function createFileResolver(
  renderedMap: ReadonlyMap<string, string>,
  projectRoot: string,
  composeDir: string = projectRoot,
): RecordingFileResolver {
  const root = resolve(projectRoot);
  const base = resolve(root, composeDir);
  const realRoot = realOr(root);
  return withDigests((path) => resolveFile(path, renderedMap, root, realRoot, base));
}

type DiskFile = { kind: 'file'; bytes: Uint8Array } | { kind: FileResolveFailure };

function fail(reason: FileResolveFailure): Resolution {
  return { ok: false, reason };
}

function resolveFile(path: string, renderedMap: ReadonlyMap<string, string>, root: string, realRoot: string, base: string): Resolution {
  const absolute = resolve(base, path);
  if (outside(root, absolute)) return fail('outside-project');
  const key = relative(root, absolute).replace(/\\/g, '/');
  if (key === '') return fail('directory');

  const disk = readDisk(absolute, realRoot);
  const rendered = renderedMap.get(key);
  if (rendered !== undefined) {
    // a symlink leading out of the project is refused even when rendering followed it
    if (disk.kind === 'outside-project') return fail('outside-project');
    if (disk.kind === 'file' && !isUtf8(disk.bytes)) return { ok: true, bytes: disk.bytes, rendered: false };
    return { ok: true, bytes: new TextEncoder().encode(rendered), rendered: true };
  }
  if (disk.kind === 'file') return { ok: true, bytes: disk.bytes, rendered: false };
  return fail(disk.kind);
}

function outside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The file at `absolute`, following symlinks, provided the real path stays inside the project. */
function readDisk(absolute: string, realRoot: string): DiskFile {
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    const code = errorCode(error);
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  if (outside(realRoot, real)) return { kind: 'outside-project' };
  try {
    const stats = statSync(real);
    if (stats.isDirectory()) return { kind: 'directory' };
    // a FIFO or a device would block the read or never end
    if (!stats.isFile()) return { kind: 'unreadable' };
    return { kind: 'file', bytes: new Uint8Array(readFileSync(real)) };
  } catch (error) {
    return { kind: errorCode(error) === 'EISDIR' ? 'directory' : 'unreadable' };
  }
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
