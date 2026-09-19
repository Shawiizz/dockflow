// Normalizer handlers for storage (design-01 5.5, 6.2): the top-level `volumes` table and a
// service's `volumes`, `tmpfs`, `shm_size` and `volumes_from`. Pure: every problem goes to the
// context's sink and the draft keeps its default; nothing throws on user input.
//
// Call order (design-01 1.1): normalizeTopLevelVolumes before the services, serviceVolumes per
// service. The stack checks own what needs every service at once (`usedBy`, `volumes.unused`,
// claim-name collisions); extension.ts writes `volumes.<key>.x-dockflow`.

import { posix } from 'path';
import { DOCKFLOW_K8S_PREFIX } from '../constants';
import type { AnonymousMountSpec, BindMountSpec, MountSpec, TmpfsMountSpec } from '../model/types';
import {
  isDnsSubdomain,
  isLabelKey,
  isLabelValue,
  isReservedKey,
  isServiceKey,
  parseBool,
  parseBytes,
} from '../model/units';
import {
  childPath,
  indexPath,
  isPlainMap,
  type NormalizeContext,
  newVolumeDraft,
  type ServiceDraft,
  sortedKeys,
  type VolumeDraft,
  type VolumeTable,
} from './context';

type Propagation = NonNullable<BindMountSpec['propagation']>;
type Recursive = BindMountSpec['recursive'];

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

type Expected = 'string' | 'list' | 'mapping' | 'string or list' | 'string or mapping' | 'list or mapping';

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'mapping';
  return typeof value;
}

/** The scalar as written, for messages about keys that never carry secrets. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeName(value);
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function invalidType(ctx: NormalizeContext, path: string, expected: Expected, value: unknown): void {
  ctx.sink.error(
    'values.invalid-type',
    path,
    `expected ${expected}, got ${typeName(value)}`,
    'See the Compose specification for the accepted forms.',
  );
}

function readBool(value: unknown, path: string, ctx: NormalizeContext): boolean | null {
  if (isAbsent(value)) return null;
  const parsed = parseBool(value);
  if (parsed === null) {
    ctx.sink.error('values.invalid-boolean', path, `expected true or false, got ${shown(value)}`, 'Write `true` or `false`.');
    return null;
  }
  if (parsed.yaml11) {
    ctx.sink.warn(
      'values.yaml11-boolean',
      path,
      `${shown(value)} is read as ${parsed.value}; YAML 1.2 only knows true and false`,
      `Write \`${parsed.value}\`.`,
    );
  }
  return parsed.value;
}

/** A byte value; 0 means "no limit" (Docker) and becomes null. */
function readSize(value: unknown, path: string, ctx: NormalizeContext): number | null {
  const bytes = parseBytes(value);
  if (bytes === null) {
    ctx.sink.error(
      'values.invalid-bytes',
      path,
      `${shown(value)} is not a byte value`,
      'Use bytes or a binary unit such as `512m`, `1g` or `2048k`.',
    );
    return null;
  }
  return bytes === 0 ? null : bytes;
}

// ---------------------------------------------------------------------------
// Short syntax (compose-go format.ParseVolume, with explicit refusals)
// ---------------------------------------------------------------------------

export type VolumeShort =
  | { kind: 'anonymous'; target: string; options: string[] }
  | { kind: 'named' | 'bind'; source: string; target: string; options: string[] };

export type VolumeShortError = 'empty' | 'empty-section' | 'too-many-colons' | 'windows-path';

/** Difference with compose-go: a one-letter volume name (`a:/data`) is a named volume here, not a drive letter. */
export function parseVolumeShort(spec: string): VolumeShort | { error: VolumeShortError } {
  if (spec === '') return { error: 'empty' };
  const seg = spec.split(':');
  if (
    /^[A-Za-z]$/.test(seg[0]) &&
    seg.length >= 2 &&
    (seg[1].startsWith('\\') || (seg.length >= 3 && seg[1].startsWith('/') && seg[2].startsWith('/')))
  ) {
    // C:\data:/data, C:/data:/data
    return { error: 'windows-path' };
  }
  if (seg.some((s) => s === '')) return { error: 'empty-section' };
  if (seg.length > 3) return { error: 'too-many-colons' };
  if (seg.length === 1) return { kind: 'anonymous', target: seg[0], options: [] };
  const [source, target, opts] = seg;
  const options = opts === undefined ? [] : opts.split(',');
  const bind = source.startsWith('/') || source.startsWith('.') || source.startsWith('~') || source.startsWith('\\\\');
  return { kind: bind ? 'bind' : 'named', source, target, options };
}

/** Absolute POSIX path, normalized, without a trailing slash; null when relative or containing NUL. */
export function normalizeTarget(t: string): string | null {
  if (!t.startsWith('/') || t.includes('\0')) return null;
  const n = posix.normalize(t);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

const SHORT_ERRORS: Record<Exclude<VolumeShortError, 'windows-path'>, string> = {
  empty: 'empty',
  'empty-section': 'empty section between colons',
  'too-many-colons': 'too many colons',
};

const PROPAGATIONS: ReadonlySet<string> = new Set(['private', 'rprivate', 'slave', 'rslave', 'shared', 'rshared']);
const CONSISTENCY: ReadonlySet<string> = new Set(['cached', 'delegated', 'consistent']);
const WINDOWS_PATH = /^[A-Za-z]:([\\/]|$)/;

function isPropagation(value: unknown): value is Propagation {
  return typeof value === 'string' && PROPAGATIONS.has(value);
}

// ---------------------------------------------------------------------------
// Diagnostics shared by both syntaxes
// ---------------------------------------------------------------------------

function mountTarget(value: string, path: string, ctx: NormalizeContext): string | null {
  const target = normalizeTarget(value);
  if (target === null || target === '/') {
    ctx.sink.error('mounts.invalid-target', path, `the mount target ${shown(value)} must be an absolute path other than /`);
    return null;
  }
  return target;
}

/** A config key the user could declare for a relative bind source (hint text only). */
function configKeyFor(source: string): string {
  const base = source.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..' && s !== '~').pop() ?? '';
  const key = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return key === '' ? 'file' : key;
}

/** A top-level volume key the user could declare for an anonymous volume (hint text only). */
function volumeKeyFor(target: string): string {
  const base = target.split('/').pop() ?? '';
  const key = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._-]+/, '');
  return key === '' ? 'data' : key;
}

/** The host path of a bind, or null after reporting why it cannot be mounted. */
function bindSource(source: string, path: string, ctx: NormalizeContext): string | null {
  if (WINDOWS_PATH.test(source) || source.startsWith('\\')) {
    ctx.sink.error('mounts.windows-path', path, `${source} is a Windows path`, 'Use an absolute Linux path.');
    return null;
  }
  if (source.startsWith('/')) return source;
  const hint = `Upload the file with \`uploads:\` in \`config.yml\` to an absolute path and mount that path, or declare it as a config (\`configs: {${configKeyFor(source)}: {file: ${source}}}\`) and mount it with \`configs:\`.`;
  const message = source.startsWith('~')
    ? `the host path ${source} starts with ~, which has no meaning on a node`
    : `the relative host path ${source} cannot be mounted: a Kubernetes pod mounts paths of the node it runs on`;
  ctx.sink.error('mounts.relative-bind', path, message, hint);
  return null;
}

function undeclaredVolume(name: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.error(
    'volumes.undeclared',
    path,
    `volume ${name} is not declared under top-level volumes`,
    `Declare it: \`volumes: {${name}: {}}\`; a host path must start with \`/\`.`,
  );
}

function copyUpInfo(target: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.info(
    'volumes.copy-up-not-emulated',
    path,
    `Kubernetes does not copy the image's files into an empty volume mounted at ${target} (Docker does)`,
    'Seed the volume from the entrypoint, or mount a subdirectory the image does not ship.',
  );
}

function anonymousMount(target: string, path: string, ctx: NormalizeContext): AnonymousMountSpec {
  const key = volumeKeyFor(target);
  ctx.sink.info(
    'volumes.anonymous-emptydir',
    path,
    `the anonymous volume at ${target} becomes an emptyDir, which is deleted with the pod`,
    `Declare a top-level volume and mount it by name (\`volumes: {${key}: {}}\` and \`${key}:${target}\`) to keep the data.`,
  );
  return { type: 'anonymous', target, path };
}

function optionIgnored(option: string, appliesTo: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.warn('mounts.option-ignored', path, `option ${option} only applies to ${appliesTo} and is ignored`);
}

function conflictingOptions(first: string, second: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.error('mounts.conflicting-options', path, `${first} and ${second} are both set`);
}

function selinuxIgnored(option: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.warn('mounts.selinux-ignored', path, `the SELinux relabel option ${option} is ignored`);
}

function consistencyIgnored(option: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.info('mounts.consistency-ignored', path, `the consistency option ${option} only applies to Docker Desktop and is ignored`);
}

/** Kubernetes propagation is always recursive: `slave` and `shared` behave as `rslave` and `rshared`. */
function propagationRecursiveInfo(mode: Propagation, path: string, ctx: NormalizeContext): void {
  if (mode !== 'slave' && mode !== 'shared') return;
  ctx.sink.info(
    'mounts.propagation-recursive',
    path,
    `the propagation mode ${mode} is applied recursively, as r${mode}: Kubernetes has no non-recursive propagation`,
  );
}

// ---------------------------------------------------------------------------
// Service volumes: short syntax
// ---------------------------------------------------------------------------

interface ShortOptions {
  readOnly: boolean;
  nocopy: boolean;
  propagation: Propagation | null;
}

/** Option errors are reported and the mount is still built, so later checks keep running. */
function shortOptions(options: readonly string[], kind: 'named' | 'bind', path: string, ctx: NormalizeContext): ShortOptions {
  const result: ShortOptions = { readOnly: false, nocopy: false, propagation: null };
  let rw = false;
  for (const option of options) {
    if (option === 'ro') result.readOnly = true;
    else if (option === 'rw') rw = true;
    else if (option === 'nocopy') {
      if (kind === 'bind') optionIgnored(option, 'named volumes', path, ctx);
      else result.nocopy = true;
    } else if (isPropagation(option)) {
      if (kind === 'named') optionIgnored(option, 'bind mounts', path, ctx);
      else if (result.propagation !== null && result.propagation !== option) {
        conflictingOptions(result.propagation, option, path, ctx);
      } else {
        result.propagation = option;
        propagationRecursiveInfo(option, path, ctx);
      }
    } else if (option === 'z' || option === 'Z') selinuxIgnored(option, path, ctx);
    else if (CONSISTENCY.has(option)) consistencyIgnored(option, path, ctx);
    else {
      ctx.sink.error(
        'mounts.invalid-option',
        path,
        `${shown(option)} is not a volume option`,
        'Use `ro`, `rw`, `nocopy`, `z`, `Z` or a propagation mode (`rprivate`, `private`, `rslave`, `slave`, `rshared`, `shared`).',
      );
    }
  }
  if (result.readOnly && rw) conflictingOptions('ro', 'rw', path, ctx);
  return result;
}

function shortMount(spec: string, path: string, volumes: VolumeTable, ctx: NormalizeContext): MountSpec | null {
  const parsed = parseVolumeShort(spec);
  if ('error' in parsed) {
    if (parsed.error === 'windows-path') {
      const [drive, rest] = spec.split(':');
      ctx.sink.error('mounts.windows-path', path, `${drive}:${rest} is a Windows path`, 'Use an absolute Linux path.');
    } else {
      ctx.sink.error(
        'mounts.invalid',
        path,
        `${shown(spec)} is not a valid volume mount: ${SHORT_ERRORS[parsed.error]}`,
        'Use `source:target[:options]`, for example `data:/var/lib/data` or `/srv/conf:/etc/app:ro`.',
      );
    }
    return null;
  }
  const target = mountTarget(parsed.target, path, ctx);
  if (parsed.kind === 'anonymous') return target === null ? null : anonymousMount(target, path, ctx);
  const options = shortOptions(parsed.options, parsed.kind, path, ctx);
  if (parsed.kind === 'bind') {
    const source = bindSource(parsed.source, path, ctx);
    if (source === null || target === null) return null;
    // the short form cannot write bind.recursive: Docker's default applies
    return {
      type: 'bind',
      source,
      target,
      readOnly: options.readOnly,
      createHostPath: true,
      propagation: options.propagation,
      recursive: 'enabled',
      path,
    };
  }
  if (!volumes.has(parsed.source)) {
    undeclaredVolume(parsed.source, path, ctx);
    return null;
  }
  if (target === null) return null;
  if (!options.nocopy) copyUpInfo(target, path, ctx);
  return { type: 'volume', volume: parsed.source, target, readOnly: options.readOnly, subpath: null, path };
}

// ---------------------------------------------------------------------------
// Service volumes: long syntax
// ---------------------------------------------------------------------------

/** Which mounts each type-specific sub-mapping applies to. */
const SUB_MAPPINGS: Readonly<Record<string, string>> = {
  volume: 'named volumes',
  bind: 'bind mounts',
  tmpfs: 'tmpfs mounts',
  image: 'image mounts',
};

function subMapping(value: unknown, path: string, ctx: NormalizeContext): Record<string, unknown> {
  if (isAbsent(value)) return {};
  if (!isPlainMap(value)) {
    invalidType(ctx, path, 'mapping', value);
    return {};
  }
  return value;
}

function refuseMountType(type: unknown, path: string, ctx: NormalizeContext): void {
  switch (type) {
    case 'image':
      ctx.sink.error(
        'mounts.image-unsupported',
        path,
        'image mounts are not supported: they need Kubernetes 1.36 and Dockflow supports clusters from 1.34',
        'Copy the files into the service image, or into a named volume.',
      );
      return;
    case 'npipe':
      ctx.sink.error('mounts.npipe-unsupported', path, 'named pipes only exist on Windows', 'Remove the mount.');
      return;
    case 'cluster':
      ctx.sink.error('mounts.cluster-unsupported', path, 'cluster volumes are a Swarm feature and are not supported', 'Use a named volume.');
      return;
    default:
      ctx.sink.error('mounts.invalid-type', path, `type ${shown(type)} must be volume, bind or tmpfs`);
  }
}

function longTarget(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (isAbsent(value) || value === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return null;
  }
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return null;
  }
  return mountTarget(value, path, ctx);
}

function readSubpath(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (isAbsent(value)) return null;
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return null;
  }
  if (value === '' || value.startsWith('/') || value.split('/').includes('..')) {
    ctx.sink.error('mounts.invalid-subpath', path, `volume.subpath ${shown(value)} must be a relative path without ..`);
    return null;
  }
  return value;
}

function readPropagation(value: unknown, path: string, ctx: NormalizeContext): Propagation | null {
  if (isAbsent(value)) return null;
  if (isPropagation(value)) {
    propagationRecursiveInfo(value, path, ctx);
    return value;
  }
  ctx.sink.error(
    'mounts.invalid-option',
    path,
    `${shown(value)} is not a propagation mode`,
    'Use `rprivate`, `private`, `rslave`, `slave`, `rshared` or `shared`.',
  );
  return null;
}

/** compose `bind.recursive` (design-02 5.5): `disabled` cannot be expressed and is stored as `enabled`. */
function readRecursive(value: unknown, readOnly: boolean, path: string, ctx: NormalizeContext): Recursive {
  if (isAbsent(value)) return 'enabled';
  switch (value) {
    case 'enabled':
      return 'enabled';
    case 'writable':
      return 'writable';
    case 'readonly':
      if (readOnly) return 'readonly';
      ctx.sink.error(
        'mounts.bind-recursive-needs-readonly',
        path,
        'bind.recursive: readonly requires a read-only mount',
        'Add `read_only: true`, or use `recursive: enabled`.',
      );
      return 'enabled';
    case 'disabled':
      ctx.sink.warn(
        'mounts.bind-recursive-ignored',
        path,
        'bind.recursive: disabled is not supported and is ignored: a Kubernetes hostPath mount is always recursive',
      );
      return 'enabled';
    default:
      ctx.sink.error(
        'mounts.invalid-option',
        path,
        `${shown(value)} is not a bind.recursive mode`,
        'Use `enabled`, `writable`, `readonly` or `disabled`.',
      );
      return 'enabled';
  }
}

interface LongCommon {
  entry: Record<string, unknown>;
  /** the type-specific sub-mapping (`volume`, `bind` or `tmpfs`), {} when absent */
  options: Record<string, unknown>;
  optionsPath: string;
  target: string | null;
  readOnly: boolean;
  path: string;
}

function longVolume(m: LongCommon, volumes: VolumeTable, ctx: NormalizeContext): MountSpec | null {
  const { entry, options, optionsPath, target, readOnly, path } = m;
  const nocopy = readBool(options.nocopy, childPath(optionsPath, 'nocopy'), ctx) ?? false;
  if (!isAbsent(options.labels)) {
    ctx.sink.warn(
      'mounts.volume-labels-ignored',
      childPath(optionsPath, 'labels'),
      'volume.labels is ignored',
      'Set `labels` on the top-level volume instead.',
    );
  }
  const sourcePath = childPath(path, 'source');
  const source = entry.source;
  if (isAbsent(source) || source === '') {
    if (!isAbsent(options.subpath)) optionIgnored('volume.subpath', 'named volumes', childPath(optionsPath, 'subpath'), ctx);
    if (readOnly) optionIgnored('read_only', 'named volumes and bind mounts', childPath(path, 'read_only'), ctx);
    return target === null ? null : anonymousMount(target, path, ctx);
  }
  if (typeof source !== 'string') {
    invalidType(ctx, sourcePath, 'string', source);
    return null;
  }
  const subpath = readSubpath(options.subpath, childPath(optionsPath, 'subpath'), ctx);
  if (!volumes.has(source)) {
    undeclaredVolume(source, sourcePath, ctx);
    return null;
  }
  if (target === null) return null;
  if (!nocopy) copyUpInfo(target, path, ctx);
  return { type: 'volume', volume: source, target, readOnly, subpath, path };
}

function longBind(m: LongCommon, ctx: NormalizeContext): MountSpec | null {
  const { entry, options, optionsPath, target, readOnly, path } = m;
  const sourcePath = childPath(path, 'source');
  let source: string | null = null;
  if (isAbsent(entry.source) || entry.source === '') ctx.sink.error('values.empty', sourcePath, 'must not be empty');
  else if (typeof entry.source !== 'string') invalidType(ctx, sourcePath, 'string', entry.source);
  else source = bindSource(entry.source, sourcePath, ctx);
  const propagation = readPropagation(options.propagation, childPath(optionsPath, 'propagation'), ctx);
  const createHostPath = readBool(options.create_host_path, childPath(optionsPath, 'create_host_path'), ctx) ?? true;
  if (!isAbsent(options.selinux)) selinuxIgnored(shown(options.selinux), childPath(optionsPath, 'selinux'), ctx);
  const recursive = readRecursive(options.recursive, readOnly, childPath(optionsPath, 'recursive'), ctx);
  if (source === null || target === null) return null;
  return { type: 'bind', source, target, readOnly, createHostPath, propagation, recursive, path };
}

function longTmpfs(m: LongCommon, ctx: NormalizeContext): MountSpec | null {
  const { entry, options, optionsPath, target, readOnly, path } = m;
  if (!isAbsent(entry.source) && entry.source !== '') {
    ctx.sink.error('mounts.tmpfs-source', childPath(path, 'source'), 'a tmpfs mount takes no source');
  }
  if (readOnly) ctx.sink.warn('mounts.tmpfs-flag-ignored', childPath(path, 'read_only'), 'tmpfs option ro is ignored');
  const sizeBytes = isAbsent(options.size) ? null : readSize(options.size, childPath(optionsPath, 'size'), ctx);
  if (!isAbsent(options.mode)) {
    ctx.sink.warn(
      'mounts.tmpfs-mode-ignored',
      childPath(optionsPath, 'mode'),
      'tmpfs.mode is ignored: memory-backed volumes are world-writable (0777)',
    );
  }
  if (target === null) return null;
  return { type: 'tmpfs', target, sizeBytes, path };
}

function longMount(entry: Record<string, unknown>, path: string, volumes: VolumeTable, ctx: NormalizeContext): MountSpec | null {
  const type = entry.type;
  if (isAbsent(type)) {
    ctx.sink.error('mounts.invalid-type', path, 'type is missing: it must be volume, bind or tmpfs');
    return null;
  }
  if (type !== 'volume' && type !== 'bind' && type !== 'tmpfs') {
    refuseMountType(type, childPath(path, 'type'), ctx);
    return null;
  }
  const target = longTarget(entry.target, childPath(path, 'target'), ctx);
  const readOnly = readBool(entry.read_only, childPath(path, 'read_only'), ctx) ?? false;
  if (!isAbsent(entry.consistency)) consistencyIgnored(shown(entry.consistency), childPath(path, 'consistency'), ctx);
  for (const [key, appliesTo] of Object.entries(SUB_MAPPINGS)) {
    if (key !== type && !isAbsent(entry[key])) optionIgnored(key, appliesTo, childPath(path, key), ctx);
  }
  const optionsPath = childPath(path, type);
  const common: LongCommon = { entry, options: subMapping(entry[type], optionsPath, ctx), optionsPath, target, readOnly, path };
  switch (type) {
    case 'volume':
      return longVolume(common, volumes, ctx);
    case 'bind':
      return longBind(common, ctx);
    case 'tmpfs':
      return longTmpfs(common, ctx);
  }
}

// ---------------------------------------------------------------------------
// Service tmpfs and shm_size
// ---------------------------------------------------------------------------

const TMPFS_FLAGS: ReadonlySet<string> = new Set([
  'ro',
  'exec',
  'noexec',
  'suid',
  'nosuid',
  'dev',
  'nodev',
  'sync',
  'async',
  'dirsync',
  'atime',
  'noatime',
  'diratime',
  'nodiratime',
  'relatime',
  'norelatime',
  'strictatime',
  'nostrictatime',
]);

function tmpfsShortSize(value: string, path: string, ctx: NormalizeContext): number | null {
  if (value.endsWith('%')) {
    ctx.sink.error(
      'mounts.invalid-tmpfs-option',
      path,
      `tmpfs size ${value} is a percentage, which memory-backed volumes do not support`,
      'Write the size in bytes, for example `size=64m`.',
    );
    return null;
  }
  return readSize(value, path, ctx);
}

/** `path[:opts]`, options comma-separated `key=value` or flags. */
function tmpfsShort(spec: string, path: string, ctx: NormalizeContext): TmpfsMountSpec | null {
  if (spec === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return null;
  }
  const colon = spec.indexOf(':');
  const target = mountTarget(colon === -1 ? spec : spec.slice(0, colon), path, ctx);
  let sizeBytes: number | null = null;
  const options = colon === -1 ? [] : spec.slice(colon + 1).split(',');
  for (const option of options) {
    const eq = option.indexOf('=');
    const name = eq === -1 ? option : option.slice(0, eq);
    const value = eq === -1 ? null : option.slice(eq + 1);
    if (name === 'size' && value !== null) sizeBytes = tmpfsShortSize(value, path, ctx);
    else if (name === 'mode') {
      ctx.sink.warn('mounts.tmpfs-mode-ignored', path, 'tmpfs option mode is ignored: memory-backed volumes are world-writable (0777)');
    } else if (name === 'uid' || name === 'gid') {
      ctx.sink.warn('mounts.tmpfs-owner-ignored', path, `tmpfs ${name} is ignored: memory-backed volumes are owned by root`);
    } else if (value === null && option === 'rw') {
      // the default: nothing to translate
    } else if (value === null && TMPFS_FLAGS.has(option)) {
      ctx.sink.warn('mounts.tmpfs-flag-ignored', path, `tmpfs option ${option} is ignored`);
    } else {
      ctx.sink.error('mounts.invalid-tmpfs-option', path, `${shown(option)} is not a tmpfs option`);
    }
  }
  return target === null ? null : { type: 'tmpfs', target, sizeBytes, path };
}

function tmpfsMounts(value: unknown, path: string, ctx: NormalizeContext): TmpfsMountSpec[] {
  if (isAbsent(value)) return [];
  let specs: [unknown, string][];
  if (typeof value === 'string') specs = [[value, path]];
  else if (Array.isArray(value)) specs = value.map((item, i): [unknown, string] => [item, indexPath(path, i)]);
  else {
    invalidType(ctx, path, 'string or list', value);
    return [];
  }
  const mounts: TmpfsMountSpec[] = [];
  for (const [spec, specPath] of specs) {
    if (typeof spec !== 'string') {
      invalidType(ctx, specPath, 'string', spec);
      continue;
    }
    const mount = tmpfsShort(spec, specPath, ctx);
    if (mount !== null) mounts.push(mount);
  }
  return mounts;
}

/** `shm_size` > 0 becomes a memory-backed volume at /dev/shm; 0 keeps the runtime default. */
function shmMount(value: unknown, path: string, ctx: NormalizeContext): TmpfsMountSpec | null {
  if (isAbsent(value)) return null;
  const sizeBytes = readSize(value, path, ctx);
  return sizeBytes === null ? null : { type: 'tmpfs', target: '/dev/shm', sizeBytes, path };
}

// ---------------------------------------------------------------------------
// Service entry point
// ---------------------------------------------------------------------------

function mountedTwice(target: string, first: string, second: string, ctx: NormalizeContext): void {
  ctx.sink.error('mounts.duplicate-target', second, `${target} is mounted twice (${first} and ${second})`, 'Mount each path once.');
}

/**
 * design-01 6.2: a claim name that differs from the key is reported once the volume is mounted
 * (an unmounted volume creates no claim). Every mount reports it again; the sink keeps one per path.
 */
function sanitizedClaimInfo(volume: VolumeDraft | undefined, ctx: NormalizeContext): void {
  if (volume === undefined || volume.external || volume.name === volume.key) return;
  ctx.sink.info('names.volume-sanitized', volume.path, `volume ${volume.key} is stored in the claim ${volume.name}`);
}

/** design-01 1.1 step 10: `volumes`, `tmpfs`, `shm_size` and `volumes_from` -> `draft.mounts`. */
export function serviceVolumes(
  draft: ServiceDraft,
  node: Record<string, unknown>,
  volumes: VolumeTable,
  ctx: NormalizeContext,
): void {
  if (ctx.isFatal(draft.path)) return;
  // secrets and configs share the container's target space with volumes
  const mounted = new Map<string, string>();
  for (const m of [...draft.mounts, ...draft.files]) if (!mounted.has(m.target)) mounted.set(m.target, m.path);
  const add = (mount: MountSpec | null): void => {
    if (mount === null) return;
    const first = mounted.get(mount.target);
    if (first !== undefined) {
      mountedTwice(mount.target, first, mount.path, ctx);
      return;
    }
    mounted.set(mount.target, mount.path);
    draft.mounts.push(mount);
    if (mount.type === 'volume') sanitizedClaimInfo(volumes.get(mount.volume), ctx);
  };

  const listPath = childPath(draft.path, 'volumes');
  const list = node.volumes;
  if (Array.isArray(list)) {
    list.forEach((entry, i) => {
      const path = indexPath(listPath, i);
      if (typeof entry === 'string') add(shortMount(entry, path, volumes, ctx));
      else if (isPlainMap(entry)) add(longMount(entry, path, volumes, ctx));
      else invalidType(ctx, path, 'string or mapping', entry);
    });
  } else if (!isAbsent(list)) {
    invalidType(ctx, listPath, 'list', list);
  }

  for (const mount of tmpfsMounts(node.tmpfs, childPath(draft.path, 'tmpfs'), ctx)) add(mount);
  add(shmMount(node.shm_size, childPath(draft.path, 'shm_size'), ctx));

  if (!isAbsent(node.volumes_from)) {
    ctx.sink.error(
      'unsupported.volumes-from',
      childPath(draft.path, 'volumes_from'),
      'volumes_from is not supported',
      'Declare a named volume at top level and mount it in both services.',
    );
  }
}

// ---------------------------------------------------------------------------
// Top-level volumes (design-01 6.2)
// ---------------------------------------------------------------------------

interface LabelEntry {
  key: string;
  value: string;
  path: string;
}

function labelValue(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** list_or_dict entries in declaration order; a list repeating a key keeps the last value. */
function labelEntries(value: unknown, path: string, ctx: NormalizeContext): LabelEntry[] {
  const entries: LabelEntry[] = [];
  if (isPlainMap(value)) {
    for (const key of sortedKeys(value)) {
      const entryPath = childPath(path, key);
      const text = labelValue(value[key]);
      if (text === null) invalidType(ctx, entryPath, 'string', value[key]);
      else entries.push({ key, value: text, path: entryPath });
    }
    return entries;
  }
  if (!Array.isArray(value)) {
    invalidType(ctx, path, 'list or mapping', value);
    return entries;
  }
  const byKey = new Map<string, LabelEntry>();
  value.forEach((item, i) => {
    const entryPath = indexPath(path, i);
    if (typeof item !== 'string') {
      invalidType(ctx, entryPath, 'string', item);
      return;
    }
    const eq = item.indexOf('=');
    const key = eq === -1 ? item : item.slice(0, eq);
    if (key === '') {
      ctx.sink.error('values.empty-key', entryPath, 'an entry has an empty name');
      return;
    }
    if (byKey.delete(key)) {
      ctx.sink.info('values.duplicate-key', entryPath, `${key} is set more than once; the last value wins`);
    }
    byKey.set(key, { key, value: eq === -1 ? '' : item.slice(eq + 1), path: entryPath });
  });
  return [...byKey.values()];
}

/** Valid labels only; invalid keys and values are dropped with a warning, reserved keys refused. */
function volumeLabels(value: unknown, path: string, ctx: NormalizeContext): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const entry of labelEntries(value, path, ctx)) {
    if (isReservedKey(entry.key)) {
      ctx.sink.error(
        'labels.reserved',
        entry.path,
        `${entry.key} uses the prefix ${DOCKFLOW_K8S_PREFIX}/, which is reserved for Dockflow`,
        'Rename the label.',
      );
    } else if (!isLabelKey(entry.key)) {
      ctx.sink.warn(
        'labels.invalid-key',
        entry.path,
        `label ${entry.key} is not a valid Kubernetes label key and is dropped`,
        'Use an optional DNS prefix and a name of letters, digits, `-`, `_` and `.` (at most 63 characters).',
      );
    } else if (!isLabelValue(entry.value)) {
      ctx.sink.warn(
        'labels.invalid-value',
        entry.path,
        `the value of label ${entry.key} is not a valid Kubernetes label value and the label is dropped`,
        'Use at most 63 letters, digits, `-`, `_` and `.`.',
      );
    } else {
      labels[entry.key] = entry.value;
    }
  }
  return labels;
}

interface ExternalForm {
  external: boolean;
  /** `external.name` of the deprecated object form */
  name: string | null;
  namePath: string;
}

function readName(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (isAbsent(value)) return null;
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return null;
  }
  if (value === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return null;
  }
  return value;
}

function readExternal(value: unknown, path: string, ctx: NormalizeContext): ExternalForm {
  if (isPlainMap(value)) {
    const namePath = childPath(path, 'name');
    return { external: true, name: readName(value.name, namePath, ctx), namePath };
  }
  return { external: readBool(value, path, ctx) ?? false, name: null, namePath: path };
}

function volumeEntry(draft: VolumeDraft, entry: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  const namePath = childPath(path, 'name');
  const name = readName(entry.name, namePath, ctx);
  const external = readExternal(entry.external, childPath(path, 'external'), ctx);
  if (external.external) {
    draft.external = true;
    // external objects keep their name verbatim: an invalid one is refused, never sanitized
    const [claim, claimPath] =
      name !== null ? [name, namePath] : external.name !== null ? [external.name, external.namePath] : [draft.key, path];
    if (isDnsSubdomain(claim)) draft.name = claim;
    else {
      ctx.sink.error(
        'volumes.invalid-external-name',
        claimPath,
        `external volume name ${claim} is not a valid Kubernetes claim name`,
        'Create the claim with a lowercase DNS name and use that name.',
      );
    }
  } else if (name !== null) {
    ctx.sink.warn(
      'volumes.name-ignored',
      namePath,
      `name ${name} is ignored: the claim is named ${draft.name} in namespace ${ctx.input.identity.namespace}`,
      `Remove \`name\`, or set \`external: true\` to use an existing claim named \`${name}\`.`,
    );
  }

  const driverPath = childPath(path, 'driver');
  if (!isAbsent(entry.driver)) {
    if (typeof entry.driver !== 'string') invalidType(ctx, driverPath, 'string', entry.driver);
    else if (entry.driver !== 'local') {
      ctx.sink.error(
        'volumes.driver-unsupported',
        driverPath,
        `volume driver ${entry.driver} is not supported`,
        `Remove \`driver\`; claims use \`x-dockflow.storage_class\` (default \`${ctx.traits.defaultStorageClass}\`).`,
      );
    }
  }

  const optsPath = childPath(path, 'driver_opts');
  if (!isAbsent(entry.driver_opts)) {
    if (!isPlainMap(entry.driver_opts)) invalidType(ctx, optsPath, 'mapping', entry.driver_opts);
    else if (Object.keys(entry.driver_opts).length > 0) {
      ctx.sink.error(
        'volumes.driver-opts-unsupported',
        optsPath,
        'driver_opts are not supported',
        'For a host directory, mount the path directly (`/srv/data:/data`); for NFS, create a claim and reference it with `external: true`.',
      );
    }
  }

  if (!isAbsent(entry.labels)) draft.labels = volumeLabels(entry.labels, childPath(path, 'labels'), ctx);

  for (const key of sortedKeys(entry)) {
    // x-dockflow belongs to extension.ts
    if (key.startsWith('x-') && key !== 'x-dockflow') {
      ctx.sink.info('extension.ignored', childPath(path, key), `${key} is an extension field and is ignored`);
    }
  }
}

/**
 * design-01 1.1 step 3: every declared volume with the model defaults, unused ones included (the
 * stack checks fill `usedBy` and report `volumes.unused`, finalize keeps the mounted ones). An
 * invalid key is refused and left out of the table.
 */
export function normalizeTopLevelVolumes(node: unknown, ctx: NormalizeContext): VolumeTable {
  const table: VolumeTable = new Map();
  if (isAbsent(node)) return table;
  if (!isPlainMap(node)) {
    invalidType(ctx, 'volumes', 'mapping', node);
    return table;
  }
  for (const key of sortedKeys(node)) {
    const path = childPath('volumes', key);
    if (!isServiceKey(key)) {
      ctx.sink.error('names.invalid-key', path, `${key} is not a valid volume name`, 'Use letters, digits, `.`, `_` and `-` only.');
      continue;
    }
    const draft = newVolumeDraft(key, ctx);
    table.set(key, draft);
    const entry = node[key];
    // null means "all defaults"
    if (isAbsent(entry)) continue;
    if (!isPlainMap(entry)) {
      invalidType(ctx, path, 'mapping', entry);
      continue;
    }
    volumeEntry(draft, entry, ctx);
  }
  return table;
}
