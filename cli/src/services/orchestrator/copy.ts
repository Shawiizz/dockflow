/**
 * `dockflow cp` planning (design-06 3.3), shared by both orchestrators: argument parsing, docker cp
 * rules for both directions, the `SRC/.` contents form, the destination probe, and the error a
 * backend reports when a container path cannot be copied.
 */

import { basename as localBasename, dirname as localDirname, posix } from 'path';
import type { Readable } from 'stream';
import tar from 'tar-stream';
import { CLIError, ErrorCode, ValidationError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ContainerPathReason = 'not-found' | 'no-tar' | 'not-a-directory' | 'other';

/** R-19 suggestion */
export const NO_TAR_SUGGESTION = 'Add tar to the image, or copy through a volume.';

/**
 * A container path could not be archived or extracted. `reason` lets `cp` tell a missing path from
 * an image without `tar` instead of reporting an empty archive.
 */
export class ContainerPathError extends CLIError {
  constructor(
    message: string,
    readonly reason: ContainerPathReason,
    suggestion?: string,
  ) {
    super(
      message,
      reason === 'not-found' ? ErrorCode.CONTAINER_NOT_FOUND : ErrorCode.COMMAND_FAILED,
      suggestion ?? (reason === 'no-tar' ? NO_TAR_SUGGESTION : undefined),
    );
    this.name = 'ContainerPathError';
  }
}

/** R-19 */
export function noTarError(service: string): ContainerPathError {
  return new ContainerPathError(`Copying files requires tar in the container image of ${service}`, 'no-tar');
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ContainerEndpoint {
  kind: 'container';
  /** compose service name, or Helm release name when `workload` is set */
  service: string;
  workload?: string;
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

const REMOTE = /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)?):([\s\S]*)$/;

function stripContents(path: string, separators: RegExp): { path: string; contents: boolean } {
  const match = new RegExp(`${separators.source}\\.$`).exec(path);
  if (!match) return { path, contents: false };
  const stripped = path.slice(0, match.index);
  return { path: stripped === '' ? path.slice(0, match.index + 1) : stripped, contents: true };
}

/**
 * `<service>:<absolute path>` or `<release>/<workload>:<absolute path>` is a container endpoint,
 * except a one-letter prefix on Windows (a drive); anything else is a local path. A trailing `/.`
 * sets `contents`.
 */
export function parseCopyEndpoint(raw: string, platform: NodeJS.Platform): CopyEndpoint {
  const match = REMOTE.exec(raw);
  if (match && !(platform === 'win32' && /^[A-Za-z]$/.test(match[1]))) {
    const [service, workload] = match[1].split('/');
    const rest = match[2];
    if (!rest.startsWith('/')) throw new ValidationError(`Container paths must be absolute: ${raw}`);
    const { path, contents } = stripContents(rest, /\//);
    return { kind: 'container', service, ...(workload !== undefined ? { workload } : {}), path, contents };
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

// ---------------------------------------------------------------------------
// Container tar arguments
// ---------------------------------------------------------------------------

/**
 * `-C <dir> <entry>` for a container path: the directory's entries (`.`) when the path ends with
 * `/.` or is the root, else the last path component from its parent.
 */
export function containerTarArgs(path: string): string[] {
  if (path.endsWith('/.')) return ['-C', path.slice(0, -2) || '/', '.'];
  const entry = posix.basename(path);
  if (entry === '') return ['-C', '/', '.'];
  return ['-C', posix.dirname(path), entry];
}

/** the path a backend's copyOut receives: `/.` appended for the contents form */
export function remoteSourcePath(source: Pick<ContainerEndpoint, 'path' | 'contents'>): string {
  if (!source.contents) return source.path;
  return source.path.endsWith('/') ? `${source.path}.` : `${source.path}/.`;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

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
  /** `tar cf -` arguments the Kubernetes backend runs for `remotePath` */
  tarArgs: string[];
}

/**
 * container -> local, docker cp rules: into an existing directory; to a missing path under a new
 * name; over an existing file (a directory source is refused by `extractTar` there). The contents
 * form needs an existing local directory.
 */
export function planCopyOut(source: ContainerEndpoint, local: LocalPathState): CopyOutPlan {
  const remotePath = remoteSourcePath(source);
  const tarArgs = containerTarArgs(remotePath);
  const wholeRoot = tarArgs[2] === '.';
  if (wholeRoot) {
    if (!local.exists) {
      if (local.parentExists === false) throw new ValidationError(`Parent directory ${localDirname(local.path)} does not exist`);
      if (source.contents) {
        throw new ValidationError(`${local.path} must be an existing directory to receive the contents of ${source.path}`);
      }
    } else if (!local.isDirectory) {
      throw new ValidationError(`Cannot copy a directory onto the file ${local.path}`);
    }
    return { remotePath, extractDir: local.path, renameTopEntry: null, tarArgs };
  }
  if (local.exists && local.isDirectory) return { remotePath, extractDir: local.path, renameTopEntry: null, tarArgs };
  if (!local.exists && local.parentExists === false) {
    throw new ValidationError(`Parent directory ${localDirname(local.path)} does not exist`);
  }
  return { remotePath, extractDir: localDirname(local.path), renameTopEntry: localBasename(local.path), tarArgs };
}

export interface ContainerPathState {
  /** used in messages */
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
    case 'directory':
      return { destDir: dest.path, entryName: localBasename(local.path) };
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

// ---------------------------------------------------------------------------
// Destination probe
// ---------------------------------------------------------------------------

/** type of the first entry of a tar stream; the stream is destroyed after it */
async function firstEntryType(archive: Readable): Promise<'directory' | 'file' | null> {
  const extract = tar.extract();
  archive.on('error', (error) => extract.destroy(error));
  archive.pipe(extract);
  try {
    for await (const entry of extract) {
      entry.resume();
      return entry.header.type === 'directory' ? 'directory' : 'file';
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
 * `copyOut`, read the first header, destroy the stream. A missing path probes its parent.
 */
export async function probeContainerPath(
  open: (path: string) => Promise<Readable>,
  service: string,
  path: string,
): Promise<ContainerPathState> {
  const probe = async (target: string): Promise<'directory' | 'file' | 'missing'> => {
    try {
      return (await firstEntryType(await open(target))) ?? 'missing';
    } catch (error) {
      if (error instanceof ContainerPathError && error.reason === 'not-found') return 'missing';
      throw error;
    }
  };
  const type = await probe(path);
  if (type !== 'missing') return { service, path, type };
  const parent = posix.dirname(path);
  const parentType = parent === path ? 'directory' : await probe(parent);
  return { service, path, type, parentExists: parentType === 'directory' };
}
