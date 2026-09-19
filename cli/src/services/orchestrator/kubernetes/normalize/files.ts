// Normalizer handlers for compose secrets and configs (design-01 5.6, 6.3): the top-level tables
// and a service's `secrets` and `configs` mounts. A `file:` source is read on its first reference
// by a service of the role and never before, so an unused entry is never read (TFILE-09). Pure:
// file contents come only from NormalizeContext.readFile, diagnostics go to the context's sink.
//
// Call order (design-01 1.1): normalizeTopLevelFiles before the services, serviceFiles per
// service. The stack checks own what needs every service at once: `files.unused` and the
// `names.file-collision` claim of content-named objects in the `file` space (design-01 10 S9).

import { posix } from 'path';
import { sha256Hex } from '../../../../utils/hash';
import type { FileMountSpec } from '../model/types';
import { isDnsSubdomain, isSecretDataKey, isServiceKey, parseBool, parseFileMode } from '../model/units';
import { hashedObjectName } from '../naming';
import {
  childPath,
  type FileSourceDraft,
  type FileSourceTable,
  indexPath,
  isPlainMap,
  type NormalizeContext,
  newFileSourceDraft,
  type ServiceDraft,
  sortedKeys,
} from './context';

type FileKind = FileSourceDraft['kind'];

/** Mode of a mounted secret or config when none is written (compose specification). */
export const DEFAULT_FILE_MODE = 0o444;

const SECRETS_DIR = '/run/secrets';
const SECTION: Readonly<Record<FileKind, 'secrets' | 'configs'>> = { secret: 'secrets', config: 'configs' };

/**
 * The one place the writable bits are dropped (the compose specification ignores them, K35):
 * FileMountSpec.mode is already masked and the translator emits it verbatim as `defaultMode`.
 */
export function maskFileMode(mode: number): number {
  return mode & 0o555;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

type Expected = 'string' | 'list' | 'mapping' | 'string or mapping' | 'string or number';

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

function emptyValue(ctx: NormalizeContext, path: string): void {
  ctx.sink.error('values.empty', path, 'must not be empty');
}

/** A non-empty string, or null after reporting why not. */
function readString(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return null;
  }
  if (value === '') {
    emptyValue(ctx, path);
    return null;
  }
  return value;
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

// ---------------------------------------------------------------------------
// Top-level secrets and configs (design-01 6.3)
// ---------------------------------------------------------------------------

/**
 * `name` written on a non-external entry, warned about once the object name is known: for a
 * `file:` source that is only after the first reference reads it. Keyed by the draft, so the state
 * lives as long as one render's table.
 */
const ignoredNames = new WeakMap<FileSourceDraft, { name: string; path: string }>();

interface ExternalForm {
  external: boolean;
  /** `external.name` of the deprecated object form */
  name: string | null;
  namePath: string;
}

function readExternal(value: unknown, path: string, ctx: NormalizeContext): ExternalForm {
  if (isPlainMap(value)) {
    const namePath = childPath(path, 'name');
    return { external: true, name: isAbsent(value.name) ? null : readString(value.name, namePath, ctx), namePath };
  }
  return { external: readBool(value, path, ctx) ?? false, name: null, namePath: path };
}

type SourceForm = 'file' | 'content' | 'environment' | 'external';

function sourceEntry(draft: FileSourceDraft, entry: Record<string, unknown>, ctx: NormalizeContext): void {
  const { kind, path } = draft;
  const section = SECTION[kind];
  const namePath = childPath(path, 'name');
  const name = isAbsent(entry.name) ? null : readString(entry.name, namePath, ctx);
  const external = readExternal(entry.external, childPath(path, 'external'), ctx);

  // `content` is a config key only; on a secret it is an unknown key (keys.unknown)
  const forms: SourceForm[] = (['file', 'content', 'environment'] as const).filter(
    (form) => !isAbsent(entry[form]) && (form !== 'content' || kind === 'config'),
  );
  if (external.external) forms.push('external');

  if (forms.length === 0) {
    ctx.sink.error('files.no-source', path, 'declares no file, content or external: true', 'Add `file:` with a path relative to the compose file.');
  } else if (forms.length > 1) {
    ctx.sink.error('files.several-sources', path, 'declares more than one of file, content, environment and external');
  } else {
    switch (forms[0]) {
      case 'file':
        draft.file = readString(entry.file, childPath(path, 'file'), ctx);
        break;
      case 'content': {
        const contentPath = childPath(path, 'content');
        if (typeof entry.content !== 'string') invalidType(ctx, contentPath, 'string', entry.content);
        else {
          draft.data = new TextEncoder().encode(entry.content);
          draft.checksum = sha256Hex(draft.data);
          draft.objectName = hashedObjectName(draft.key, kind, draft.checksum);
        }
        break;
      }
      case 'environment': {
        const envPath = childPath(path, 'environment');
        const variable = readString(entry.environment, envPath, ctx);
        if (variable !== null) {
          ctx.sink.error(
            'files.environment-unsupported',
            envPath,
            `${kind} content from the environment variable ${variable} is not supported: Dockflow passes no process environment`,
            `Put the value in a file under \`.dockflow/\` that renders it with Nunjucks (for example \`{{ current.env.${variable.toLowerCase()} }}\`) and use \`file:\`.`,
          );
        }
        break;
      }
      case 'external': {
        draft.external = true;
        // external objects keep their name verbatim: an invalid one is refused, never sanitized
        const [objectName, objectPath] =
          name !== null ? [name, namePath] : external.name !== null ? [external.name, external.namePath] : [draft.key, path];
        if (isDnsSubdomain(objectName)) draft.objectName = objectName;
        else {
          ctx.sink.error(
            'files.invalid-external-name',
            objectPath,
            `external ${kind} name ${objectName} is not a valid Kubernetes object name`,
            'Create the object with a lowercase DNS name and use that name.',
          );
        }
        break;
      }
    }
  }
  if (!draft.external && name !== null) ignoredNames.set(draft, { name, path: namePath });

  if (!isAbsent(entry.labels)) {
    ctx.sink.warn('files.labels-ignored', childPath(path, 'labels'), `labels on ${section} are ignored`);
  }
  // driver and driver_opts only exist on secrets; on a config they are unknown keys
  if (kind === 'secret') {
    if (!isAbsent(entry.driver)) {
      ctx.sink.error('files.driver-unsupported', childPath(path, 'driver'), 'driver is not supported for secrets', 'Remove `driver`.');
    }
    const opts = entry.driver_opts;
    if (!isAbsent(opts) && !(isPlainMap(opts) && Object.keys(opts).length === 0)) {
      ctx.sink.error(
        'files.driver-unsupported',
        childPath(path, 'driver_opts'),
        'driver_opts is not supported for secrets',
        'Remove `driver_opts`.',
      );
    }
  }
  if (!isAbsent(entry.template_driver)) {
    ctx.sink.error(
      'files.template-driver-unsupported',
      childPath(path, 'template_driver'),
      'template_driver is not supported',
      'Render the content with Nunjucks instead.',
    );
  }
  for (const key of sortedKeys(entry)) {
    // x-dockflow belongs to extension.ts, which refuses it here
    if (key.startsWith('x-') && key !== 'x-dockflow') {
      ctx.sink.info('extension.ignored', childPath(path, key), `${key} is an extension field and is ignored`);
    }
  }
}

function topLevelSources(kind: FileKind, node: unknown, ctx: NormalizeContext): Map<string, FileSourceDraft> {
  const table = new Map<string, FileSourceDraft>();
  const section = SECTION[kind];
  if (isAbsent(node)) return table;
  if (!isPlainMap(node)) {
    invalidType(ctx, section, 'mapping', node);
    return table;
  }
  for (const key of sortedKeys(node)) {
    const path = childPath(section, key);
    // the key becomes the object's data key verbatim, so it must also be a valid Secret data key
    if (!isServiceKey(key) || !isSecretDataKey(key)) {
      ctx.sink.error('names.invalid-key', path, `${key} is not a valid ${kind} name`, 'Use letters, digits, `.`, `_` and `-` only.');
      continue;
    }
    const draft = newFileSourceDraft(kind, key, ctx);
    table.set(key, draft);
    const entry = node[key];
    if (isAbsent(entry)) sourceEntry(draft, {}, ctx);
    else if (!isPlainMap(entry)) invalidType(ctx, path, 'mapping', entry);
    else sourceEntry(draft, entry, ctx);
  }
  return table;
}

/**
 * design-01 1.1 step 4: every declared secret and config, unused ones included. Inline `content`
 * is known at once; a `file:` is read by serviceFiles on its first reference.
 */
export function normalizeTopLevelFiles(secrets: unknown, configs: unknown, ctx: NormalizeContext): FileSourceTable {
  return { secrets: topLevelSources('secret', secrets, ctx), configs: topLevelSources('config', configs, ctx) };
}

/**
 * First reference of a source by a service of the role: reads a `file:` source and names the
 * object from its content (hashedObjectName sanitizes the key, K71). Idempotent: reads are
 * memoized by the context, and a repeated warning is kept once by the sink.
 */
function materialize(source: FileSourceDraft, ctx: NormalizeContext): void {
  if (source.external) return;
  if (source.file !== null && source.data === null) {
    const read = ctx.readFile(source.file, childPath(source.path, 'file'), source.kind);
    if (read.ok) {
      source.data = read.bytes;
      source.checksum = sha256Hex(read.bytes);
      source.objectName = hashedObjectName(source.key, source.kind, source.checksum);
    }
  }
  if (source.checksum === null) return;
  const ignored = ignoredNames.get(source);
  if (ignored !== undefined) {
    ctx.sink.warn(
      'files.name-ignored',
      ignored.path,
      `name ${ignored.name} is ignored: Dockflow names the object from its content (${source.objectName})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Service secrets and configs (design-01 5.6)
// ---------------------------------------------------------------------------

function defaultTarget(kind: FileKind, source: string): string {
  return kind === 'secret' ? `${SECRETS_DIR}/${source}` : `/${source}`;
}

function invalidTarget(value: string, path: string, ctx: NormalizeContext): null {
  ctx.sink.error('files.invalid-target', path, `target ${value} must name a file`);
  return null;
}

/** Secrets: relative to /run/secrets or absolute. Configs: absolute. Normalized either way. */
function fileTarget(kind: FileKind, value: unknown, path: string, ctx: NormalizeContext): string | null {
  const written = readString(value, path, ctx);
  if (written === null) return null;
  if (kind === 'config' && !written.startsWith('/')) {
    ctx.sink.error(
      'files.relative-config-target',
      path,
      `config target ${written} must be an absolute path`,
      `Write the full path, for example \`/etc/app/${written}\`.`,
    );
    return null;
  }
  if (written.endsWith('/') || written.includes('\0')) return invalidTarget(written, path, ctx);
  const target = posix.normalize(written.startsWith('/') ? written : `${SECRETS_DIR}/${written}`);
  if (target === '/' || target.endsWith('/') || (kind === 'secret' && target === SECRETS_DIR)) {
    return invalidTarget(written, path, ctx);
  }
  return target;
}

/** parseFileMode, then the writable bits dropped; an invalid mode keeps the default. */
function readMode(value: unknown, path: string, ctx: NormalizeContext): number {
  if (isAbsent(value)) return DEFAULT_FILE_MODE;
  const parsed = parseFileMode(value);
  if (parsed === null || parsed.mode > 0o777) {
    ctx.sink.error('values.invalid-mode', path, `${shown(value)} is not a file mode`, 'Write an octal mode such as `0440`.');
    return DEFAULT_FILE_MODE;
  }
  if (parsed.decimalLooksOctal) {
    ctx.sink.warn(
      'files.mode-decimal',
      path,
      `mode ${parsed.mode} is read as the decimal number ${parsed.mode} (octal 0${parsed.mode.toString(8)})`,
      `Write \`0${parsed.mode}\` for octal permissions.`,
    );
  }
  return maskFileMode(parsed.mode);
}

function readOwner(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (isAbsent(value) || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  invalidType(ctx, path, 'string or number', value);
  return null;
}

function fileMount(
  kind: FileKind,
  entry: unknown,
  path: string,
  table: ReadonlyMap<string, FileSourceDraft>,
  ctx: NormalizeContext,
): FileMountSpec | null {
  let long: Record<string, unknown> | null = null;
  let source: string | null;
  let sourcePath = path;
  if (typeof entry === 'string') {
    source = entry === '' ? null : entry;
    if (source === null) emptyValue(ctx, path);
  } else if (isPlainMap(entry)) {
    long = entry;
    sourcePath = childPath(path, 'source');
    if (isAbsent(entry.source)) {
      emptyValue(ctx, sourcePath);
      source = null;
    } else {
      source = readString(entry.source, sourcePath, ctx);
    }
  } else {
    invalidType(ctx, path, 'string or mapping', entry);
    return null;
  }
  if (source === null) return null;

  const declared = table.get(source);
  if (declared === undefined) {
    const section = SECTION[kind];
    ctx.sink.error(
      'files.undeclared',
      sourcePath,
      `${kind} ${source} is not declared under top-level ${section}`,
      `Declare it, for example \`${section}: {${source}: {file: ./${source}.txt}}\`.`,
    );
    return null;
  }
  materialize(declared, ctx);

  const target =
    long === null || isAbsent(long.target)
      ? defaultTarget(kind, source)
      : fileTarget(kind, long.target, childPath(path, 'target'), ctx);
  const mode = long === null ? DEFAULT_FILE_MODE : readMode(long.mode, childPath(path, 'mode'), ctx);
  const uid = long === null ? null : readOwner(long.uid, childPath(path, 'uid'), ctx);
  const gid = long === null ? null : readOwner(long.gid, childPath(path, 'gid'), ctx);
  if ((uid !== null && uid !== '0') || (gid !== null && gid !== '0')) {
    ctx.sink.warn(
      'files.ownership-ignored',
      path,
      'uid and gid are ignored: files mounted from Kubernetes Secrets and ConfigMaps are owned by root',
      'Make the file readable with `mode`, or set `x-dockflow.fs_group` to give its group to the pod.',
    );
  }
  if (declared.external) {
    ctx.sink.info(
      'files.external-key',
      path,
      `the external ${kind} ${declared.objectName} must contain a data key named ${source}`,
    );
  }
  return target === null ? null : { kind, source, target, mode, uid, gid, path };
}

/** design-01 1.1 step 11: `secrets` and `configs` -> `draft.files`. */
export function serviceFiles(
  draft: ServiceDraft,
  node: Record<string, unknown>,
  fileSources: FileSourceTable,
  ctx: NormalizeContext,
): void {
  if (ctx.isFatal(draft.path)) return;
  // volumes, tmpfs and shm_size share the container's target space with secrets and configs
  const mounted = new Map<string, string>();
  for (const m of [...draft.mounts, ...draft.files]) if (!mounted.has(m.target)) mounted.set(m.target, m.path);

  for (const kind of ['secret', 'config'] as const) {
    const section = SECTION[kind];
    const listPath = childPath(draft.path, section);
    const list = node[section];
    if (isAbsent(list)) continue;
    if (!Array.isArray(list)) {
      invalidType(ctx, listPath, 'list', list);
      continue;
    }
    const table = kind === 'secret' ? fileSources.secrets : fileSources.configs;
    list.forEach((entry, i) => {
      const mount = fileMount(kind, entry, indexPath(listPath, i), table, ctx);
      if (mount === null) return;
      const first = mounted.get(mount.target);
      if (first !== undefined) {
        ctx.sink.error(
          'mounts.duplicate-target',
          mount.path,
          `${mount.target} is mounted twice (${first} and ${mount.path})`,
          'Mount each path once.',
        );
        return;
      }
      mounted.set(mount.target, mount.path);
      draft.files.push(mount);
    });
  }
}
