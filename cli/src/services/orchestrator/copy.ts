/**
 * `dockflow cp` planning: argument parsing, docker cp rules for both directions, the `SRC/.`
 * contents form, the destination probe, and the error reported when a container path cannot be
 * copied.
 */

import { basename as localBasename, dirname as localDirname, posix, resolve as localResolve } from 'path';
import type { Readable } from 'stream';
import tar from 'tar-stream';
import { CLIError, ErrorCode, ValidationError } from '../../utils/errors';

export type ContainerPathReason = 'not-found' | 'not-a-directory' | 'other';

/** A container path could not be archived or extracted; `reason` tells a missing path from the rest. */
export class ContainerPathError extends CLIError {
  constructor(
    message: string,
    readonly reason: ContainerPathReason,
    suggestion?: string,
  ) {
    super(message, reason === 'not-found' ? ErrorCode.CONTAINER_NOT_FOUND : ErrorCode.COMMAND_FAILED, suggestion);
    this.name = 'ContainerPathError';
  }
}

export interface ContainerEndpoint {
  kind: 'container';
  service: string;
  /** absolute container path, without a trailing `/.` */
  path: string;
  /** the source ended with `/.`: copy the directory's entries, not the directory */
  contents: boolean;
}

export interface LocalEndpoint {
  kind: 'local';
  /** path on the CLI machine, without a trailing `/.` */
  path: string;
  contents: boolean;
}

export type CopyEndpoint = ContainerEndpoint | LocalEndpoint;

const REMOTE = /^([A-Za-z0-9][A-Za-z0-9_.-]*):([\s\S]*)$/;

function stripContents(path: string, separators: RegExp): { path: string; contents: boolean } {
  const match = new RegExp(`${separators.source}\\.$`).exec(path);
  if (!match) return { path, contents: false };
  const stripped = path.slice(0, match.index);
  return { path: stripped === '' ? path.slice(0, match.index + 1) : stripped, contents: true };
}

/**
 * `<service>:<absolute path>` is a container endpoint, except a one-letter prefix on Windows (a
 * drive); anything else is a local path. A trailing `/.` sets `contents`.
 */
export function parseCopyEndpoint(raw: string, platform: NodeJS.Platform): CopyEndpoint {
  const match = REMOTE.exec(raw);
  if (match && !(platform === 'win32' && /^[A-Za-z]$/.test(match[1]))) {
    const [, service, rest] = match;
    if (!rest.startsWith('/')) throw new ValidationError(`Container paths must be absolute: ${raw}`);
    const { path, contents } = stripContents(rest, /\//);
    return { kind: 'container', service, path, contents };
  }
  const { path, contents } = stripContents(raw, platform === 'win32' ? /[\\/]/ : /\//);
  return { kind: 'local', path, contents };
}

export type CopyRequest =
  | { direction: 'out'; source: ContainerEndpoint; destination: LocalEndpoint }
  | { direction: 'in'; source: LocalEndpoint; destination: ContainerEndpoint };

/** Exactly one side names a container; a destination never ends with `/.`. */
export function parseCopyArguments(src: string, dest: string, platform: NodeJS.Platform): CopyRequest {
  const source = parseCopyEndpoint(src, platform);
  const destination = parseCopyEndpoint(dest, platform);
  if (source.kind === destination.kind) {
    throw new ValidationError(
      `Exactly one of ${src} and ${dest} must be <service>:<path>`,
      'For example: `dockflow cp production web:/app/logs ./logs`.',
    );
  }
  if (destination.contents) {
    const itself = destination.kind === 'container' ? `${dest.slice(0, dest.indexOf(':') + 1)}${destination.path}` : destination.path;
    throw new ValidationError('A destination must not end with /.', `Use \`${itself}\` for the directory itself.`);
  }
  return source.kind === 'container'
    ? { direction: 'out', source, destination: destination as LocalEndpoint }
    : { direction: 'in', source, destination: destination as ContainerEndpoint };
}

/** The path `copyOut` receives: `/.` appended for the contents form; the root is always its entries. */
export function remoteSourcePath(source: Pick<ContainerEndpoint, 'path' | 'contents'>): string {
  if (source.path === '/') return '/.';
  if (!source.contents) return source.path;
  return source.path.endsWith('/') ? `${source.path}.` : `${source.path}/.`;
}

export interface LocalPathState {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** for a missing path: whether its parent directory exists; unknown when absent */
  parentExists?: boolean;
}

export interface CopyOutPlan {
  /** what to pass to `ContainerBackend.copyOut` */
  remotePath: string;
  /** local directory the archive is extracted into */
  extractDir: string;
  /** name the archive's top entry takes locally; null keeps it */
  renameTopEntry: string | null;
}

/**
 * container -> local, docker cp rules: into an existing directory; to a missing path under a new
 * name; over an existing file (a directory source is refused by `extractTar` there). The contents
 * form needs an existing local directory.
 */
export function planCopyOut(source: ContainerEndpoint, local: LocalPathState): CopyOutPlan {
  const remotePath = remoteSourcePath(source);
  if (remotePath.endsWith('/.')) {
    if (!local.exists) {
      if (local.parentExists === false) throw new ValidationError(`Parent directory ${localDirname(local.path)} does not exist`);
      throw new ValidationError(`${local.path} must be an existing directory to receive the contents of ${source.path}`);
    }
    if (!local.isDirectory) throw new ValidationError(`Cannot copy a directory onto the file ${local.path}`);
    return { remotePath, extractDir: local.path, renameTopEntry: null };
  }
  if (local.exists && local.isDirectory) return { remotePath, extractDir: local.path, renameTopEntry: null };
  if (!local.exists && local.parentExists === false) {
    throw new ValidationError(`Parent directory ${localDirname(local.path)} does not exist`);
  }
  return { remotePath, extractDir: localDirname(local.path), renameTopEntry: localBasename(local.path) };
}

export interface ContainerPathState {
  service: string;
  path: string;
  type: 'directory' | 'file' | 'missing';
  /** for a missing path: whether its parent directory exists */
  parentExists?: boolean;
}

export interface CopyInPlan {
  /** what to pass to `ContainerBackend.copyIn` */
  destDir: string;
  /** name the packed entry takes (`packPathToTar`); null packs a directory's entries */
  entryName: string | null;
}

/** local -> container, the same rules with the destination learned from `probeContainerPath`. */
export function planCopyIn(local: { path: string; isDirectory: boolean; contents: boolean }, dest: ContainerPathState): CopyInPlan {
  if (local.contents) {
    if (!local.isDirectory) throw new ValidationError(`${local.path}/. ends with /. but is not a directory`);
    if (dest.type !== 'directory') {
      throw new ValidationError(`${dest.path} must be an existing directory in ${dest.service} to receive the contents of ${local.path}`);
    }
    return { destDir: dest.path, entryName: null };
  }
  switch (dest.type) {
    case 'directory': {
      const name = localBasename(localResolve(local.path));
      if (name === '') throw new ValidationError(`${local.path} has no name to copy under`, `Use \`${local.path}/.\` to copy its contents.`);
      return { destDir: dest.path, entryName: name };
    }
    case 'file':
      if (local.isDirectory) throw new ValidationError(`Cannot copy a directory onto the file ${dest.path}`);
      return { destDir: posix.dirname(dest.path), entryName: posix.basename(dest.path) };
    case 'missing':
      if (dest.parentExists === false) {
        throw new ValidationError(`Parent directory ${posix.dirname(dest.path)} does not exist in ${dest.service}`);
      }
      return { destDir: posix.dirname(dest.path), entryName: posix.basename(dest.path) };
  }
}

type FirstEntry = 'directory' | 'file' | 'symlink' | null;

/** type of the first entry of a tar stream; the stream is destroyed after it */
async function firstEntryType(archive: Readable): Promise<FirstEntry> {
  const extract = tar.extract();
  archive.on('error', (error) => extract.destroy(error));
  archive.pipe(extract);
  try {
    for await (const entry of extract) {
      entry.resume();
      const type = entry.header.type;
      return type === 'directory' || type === 'symlink' ? type : 'file';
    }
    return null;
  } finally {
    archive.unpipe(extract);
    archive.destroy();
    extract.destroy();
  }
}

/**
 * Destination probe that needs no shell in the image: archive the path with the backend's
 * `copyOut`, read the first header, destroy the stream. A missing path (or one below a file)
 * probes its parent, a symbolic link is followed through `<path>/.`.
 */
export async function probeContainerPath(
  open: (path: string) => Promise<Readable>,
  service: string,
  path: string,
): Promise<ContainerPathState> {
  const probe = async (target: string): Promise<'directory' | 'file' | 'missing'> => {
    try {
      const type = await firstEntryType(await open(target));
      if (type === null) return 'missing';
      if (type !== 'symlink') return type;
      return (await probe(`${target}/.`)) === 'directory' ? 'directory' : 'file';
    } catch (error) {
      if (error instanceof ContainerPathError && error.reason !== 'other') return 'missing';
      throw error;
    }
  };
  const type = await probe(path);
  if (type !== 'missing') return { service, path, type };
  const parent = posix.dirname(path);
  const parentType = parent === path ? 'directory' : await probe(parent);
  return { service, path, type, parentExists: parentType === 'directory' };
}
