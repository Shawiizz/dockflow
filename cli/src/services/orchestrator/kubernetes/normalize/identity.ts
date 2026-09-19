// Identity, image, build, metadata, process keys and lifecycle hooks of a service (design-01 5.1,
// 5.2, 5.12; D12 pull rules; DESIGN-CORE 5.7), with the shell-word splitter (2.10) and the image
// reference grammar (2.12). User and groups are security.ts; hostname is network.ts. Pure.

import { ANNOTATIONS } from '../constants';
import type { ImageSpec } from '../model/types';
import { isAbsolutePosixPath, isArchName, isLabelKey, isReservedKey } from '../model/units';
import { importedImageRef } from '../naming';
import { childPath, indexPath, isPlainMap, type NormalizeContext, type RoutingLabel, type ServiceDraft } from './context';
import {
  decodeUtf8,
  displayValue,
  isAbsent,
  type ListOrDictEntry,
  parseDotenv,
  readBool,
  readDuration,
  readListOrDict,
  readString,
  readStringList,
  reportEmpty,
  reportFileInterpolationIssues,
  reportInvalidType,
} from './env';

// ---------------------------------------------------------------------------
// Shell words (design-01 2.10, google/shlex)
// ---------------------------------------------------------------------------

export type ShlexResult = { words: string[] } | { error: 'unterminated-quote' | 'trailing-escape' };

export function shlexSplit(input: string): ShlexResult {
  const words: string[] = [];
  let state: 'start' | 'word' | 'escape' | 'dquote' | 'dquote-escape' | 'squote' | 'comment' = 'start';
  let cur = '';
  for (const ch of input) {
    const space = ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
    switch (state) {
      case 'start':
        if (space) break;
        if (ch === '"') {
          state = 'dquote';
          cur = '';
        } else if (ch === "'") {
          state = 'squote';
          cur = '';
        } else if (ch === '\\') {
          state = 'escape';
          cur = '';
        } else if (ch === '#') {
          state = 'comment';
        } else {
          cur = ch;
          state = 'word';
        }
        break;
      case 'word':
        if (space) {
          words.push(cur);
          cur = '';
          state = 'start';
        } else if (ch === '"') state = 'dquote';
        else if (ch === "'") state = 'squote';
        else if (ch === '\\') state = 'escape';
        // `#` inside a word is literal
        else cur += ch;
        break;
      case 'escape':
        cur += ch;
        state = 'word';
        break;
      case 'dquote':
        if (ch === '"') state = 'word';
        else if (ch === '\\') state = 'dquote-escape';
        else cur += ch;
        break;
      case 'dquote-escape':
        // shlex: a backslash escapes any rune inside double quotes
        cur += ch;
        state = 'dquote';
        break;
      case 'squote':
        if (ch === "'") state = 'word';
        else cur += ch;
        break;
      case 'comment':
        if (ch === '\n') state = 'start';
        break;
    }
  }
  // a quoted empty token ends in state `word` and yields ""
  if (state === 'word') words.push(cur);
  if (state === 'escape' || state === 'dquote-escape') return { error: 'trailing-escape' };
  if (state === 'dquote' || state === 'squote') return { error: 'unterminated-quote' };
  return { words };
}

const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '2>&1', '&']);

/**
 * The first word a shell would interpret, as printed in `process.shell-syntax`. Substitutions are
 * shown by their opening characters only: the rest of the word may be an inserted value.
 */
export function shellSyntaxWord(words: readonly string[]): string | null {
  for (const word of words) {
    if (SHELL_OPERATORS.has(word)) return word;
    if (word.startsWith('$(')) return '$(...)';
    if (word.startsWith('`')) return '`...`';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image references (design-01 2.12, distribution/reference)
// ---------------------------------------------------------------------------

const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const NAME = `(?:${DOMAIN}/)?${COMPONENT}(?:/${COMPONENT})*`;
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST = '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}';
export const IMAGE_REF_RE = new RegExp(`^(${NAME})(?::(${TAG}))?(?:@(${DIGEST}))?$`);
const IMAGE_NAME_MAX = 255;

export interface ImageRef {
  name: string;
  tag: string | null;
  digest: string | null;
  /** no digest, and no tag or the tag `latest`: the D12 "always pull" class */
  latest: boolean;
}

export function parseImageRef(ref: string): ImageRef | null {
  const m = IMAGE_REF_RE.exec(ref);
  if (!m || m[1].length > IMAGE_NAME_MAX) return null;
  const tag = m[2] ?? null;
  const digest = m[3] ?? null;
  return { name: m[1], tag, digest, latest: digest === null && (tag === null || tag === 'latest') };
}

// ---------------------------------------------------------------------------
// Image, build and pull policy (design-01 5.1, D12, DV5)
// ---------------------------------------------------------------------------

/** the pull-policy table column of an image */
type PullColumn = 'built-import' | 'built-registry' | 'pulled-pinned' | 'pulled-latest';

const PERIODIC_PULL = /^(?:refresh|daily|weekly|every_(?:[0-9]+[wdhms])+)$/;

function resolvePullPolicy(
  written: unknown,
  column: PullColumn,
  image: string,
  path: string,
  ctx: NormalizeContext,
): ImageSpec['pullPolicy'] {
  const byDefault: ImageSpec['pullPolicy'] = column === 'pulled-latest' ? 'Always' : 'IfNotPresent';
  if (isAbsent(written)) return byDefault;
  if (typeof written !== 'string') {
    reportInvalidType(ctx, path, 'string', written);
    return byDefault;
  }
  const refuseImported = (): ImageSpec['pullPolicy'] => {
    ctx.sink.error(
      'image.pull-policy-imported',
      path,
      `pull_policy ${written} cannot be honoured for an image Dockflow builds and imports into the nodes: no registry holds it`,
      'Remove `pull_policy`, or enable `registry` in `config.yml`.',
    );
    return byDefault;
  };
  switch (written) {
    case 'always':
      return column === 'built-import' ? refuseImported() : 'Always';
    case 'never':
      if (column === 'pulled-pinned' || column === 'pulled-latest') {
        ctx.sink.warn(
          'image.pull-never',
          path,
          `pull_policy never requires ${image} to be present on every node that may run the service, otherwise pods fail with ErrImageNeverPull`,
          'Remove `pull_policy` unless the image is preloaded on every node.',
        );
      }
      return 'Never';
    case 'missing':
    case 'if_not_present':
      return byDefault;
    case 'build':
      if (column === 'built-import' || column === 'built-registry') return 'IfNotPresent';
      ctx.sink.error('image.pull-policy-build', path, 'pull_policy build requires a build section', 'Add `build:`, or remove `pull_policy`.');
      return byDefault;
  }
  if (PERIODIC_PULL.test(written)) {
    if (column === 'built-import') return refuseImported();
    ctx.sink.warn(
      'image.pull-policy-periodic',
      path,
      `pull_policy ${written} is not supported on Kubernetes; the image is pulled whenever a pod starts (imagePullPolicy Always)`,
      'Pin a tag and redeploy to update the image.',
    );
    return 'Always';
  }
  ctx.sink.error(
    'image.invalid-pull-policy',
    path,
    `${displayValue(written)} is not a pull policy`,
    'Use `always`, `never`, `missing`, `build`, `daily`, `weekly` or `every_<duration>`.',
  );
  return byDefault;
}

function normalizeImage(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  const role = ctx.input.role;
  const hasBuild = !isAbsent(node.build);
  if (hasBuild && typeof node.build !== 'string' && !isPlainMap(node.build)) {
    reportInvalidType(ctx, childPath(path, 'build'), 'string or mapping', node.build);
  }
  const origin: ImageSpec['origin'] = role === 'app' && hasBuild ? 'built' : 'pulled';

  let image: string | null = null;
  let ref: ImageRef | null = null;
  const imagePath = childPath(path, 'image');
  if (isAbsent(node.image)) {
    if (role === 'app' && hasBuild) {
      ctx.sink.error(
        'image.missing-for-build',
        path,
        'has a build section but no image name, so the built image cannot be tagged and deployed',
        `Set \`image:\` to a name for the built image, for example \`image: ${draft.composeName}\`.`,
      );
    } else {
      ctx.sink.error('image.missing', path, 'has no image', 'Set `image:`, or add a `build:` section together with the `image:` name Dockflow tags the build with.');
    }
  } else if (typeof node.image !== 'string') {
    reportInvalidType(ctx, imagePath, 'string', node.image);
  } else if (node.image === '') {
    reportEmpty(ctx, imagePath);
  } else {
    ref = parseImageRef(node.image);
    if (ref === null) {
      ctx.sink.error('image.invalid-reference', imagePath, `${node.image} is not a valid image reference`, 'Use [registry/]name[:tag][@digest] with a lowercase name.');
    } else {
      image = node.image;
    }
  }

  if (role === 'accessory' && hasBuild && image !== null) {
    ctx.sink.warn(
      'build.accessory-not-built',
      childPath(path, 'build'),
      `build is ignored in accessories.yml: Dockflow only builds images of docker-compose.yml, so ${image} is pulled`,
      'Move the service to `docker-compose.yml` to build it, or remove `build`.',
    );
  }

  const column: PullColumn =
    origin === 'built'
      ? ctx.input.imageDelivery === 'registry'
        ? 'built-registry'
        : 'built-import'
      : ref?.latest === true
        ? 'pulled-latest'
        : 'pulled-pinned';
  const pullPolicy = resolvePullPolicy(node.pull_policy, column, image ?? 'the image', childPath(path, 'pull_policy'), ctx);
  if (!isAbsent(node.pull_refresh_after)) {
    ctx.sink.warn(
      'image.pull-refresh-ignored',
      childPath(path, 'pull_refresh_after'),
      'pull_refresh_after is ignored: Kubernetes pulls according to imagePullPolicy only',
      'Remove `pull_refresh_after`.',
    );
  }
  if (image === null) return;
  draft.image = {
    ref: origin === 'built' && ctx.input.imageDelivery === 'import' ? importedImageRef(image) : image,
    composeRef: image,
    origin,
    pullPolicy,
  };
}

const PLATFORM_RE = /^([^/\s]+)\/([^/\s]+)(?:\/([^/\s]+))?$/;

/** `platform` becomes two placement constraints; deploy.ts keeps them after `deploy.placement.constraints` (IMG-11) */
function normalizePlatform(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (isAbsent(node.platform)) return;
  const path = childPath(draft.path, 'platform');
  const platform = readString(node.platform, path, ctx);
  if (platform === null) return;
  const m = PLATFORM_RE.exec(platform);
  const invalid = (): void => {
    ctx.sink.error('image.invalid-platform', path, `${displayValue(platform)} is not a platform`, 'Use `os/arch`, for example `linux/amd64`.');
  };
  if (!m) return invalid();
  const os = m[1].toLowerCase();
  const arch = m[2].toLowerCase();
  if (os !== 'linux') {
    ctx.sink.error('image.unsupported-platform-os', path, `${os} nodes are not supported`, `Use \`linux/${arch}\`.`);
    return;
  }
  if (!isArchName(arch)) return invalid();
  if (m[3] !== undefined) {
    ctx.sink.warn(
      'image.platform-variant-ignored',
      path,
      `the variant ${m[3]} of platform ${platform} is ignored: nodes are selected by OS and architecture only`,
    );
  }
  draft.placement.constraints.push(
    { attribute: 'node.platform.os', operator: '==', value: os, path },
    { attribute: 'node.platform.arch', operator: '==', value: arch, path },
  );
  ctx.sink.info('image.platform-constraint', path, `platform ${platform} schedules pods only on ${os}/${arch} nodes`);
}

// ---------------------------------------------------------------------------
// Labels and annotations (design-01 5.1, DESIGN-CORE 5.3)
// ---------------------------------------------------------------------------

/** Kubernetes TotalAnnotationSizeLimitB: keys and values of one object's annotations */
export const ANNOTATIONS_MAX_BYTES = 256 * 1024;
const CONFIG_HASH_LENGTH = 64;

function readLabelFiles(value: unknown, path: string, ctx: NormalizeContext): ListOrDictEntry[] {
  const files = readStringList(value, path, ctx, { stringForm: true });
  if (files === null) return [];
  const parsed = new Map<string, ListOrDictEntry>();
  const lookup = (k: string): string | undefined => parsed.get(k)?.value ?? undefined;
  for (const file of files) {
    if (file.value === '') {
      reportEmpty(ctx, file.path);
      continue;
    }
    const read = ctx.readFile(file.value, file.path, 'label_file');
    if (!read.ok) continue;
    const decoded = decodeUtf8(read.bytes);
    const result = 'badLine' in decoded ? { error: 'the file is not valid UTF-8', line: decoded.badLine } : parseDotenv(decoded.text, lookup);
    if ('error' in result) {
      ctx.sink.error('label_file.parse-error', file.path, `${file.value} line ${result.line}: ${result.error}`);
      continue;
    }
    reportFileInterpolationIssues(result.issues, file.value, file.path, ctx);
    for (const [key, v] of result.vars) {
      parsed.delete(key);
      parsed.set(key, { key, value: v, path: file.path });
    }
  }
  return [...parsed.values()];
}

const TRAEFIK_PREFIX = 'traefik.';

/**
 * The key rules shared by `labels`, `annotations` and `deploy.labels`: `traefik.*` (any case, as
 * Traefik reads it) goes to the routing set with its key as written when `routing` names the
 * source, `com.docker.*` is dropped silently (core policy), the Dockflow prefix is refused and an
 * invalid key is dropped with a warning.
 */
function classifyLabels(
  entries: readonly ListOrDictEntry[],
  target: Record<string, string>,
  routing: { labels: RoutingLabel[]; source: RoutingLabel['source'] } | null,
  ctx: NormalizeContext,
): void {
  for (const { key, value, path } of entries) {
    const text = value ?? '';
    if (routing !== null && key.slice(0, TRAEFIK_PREFIX.length).toLowerCase() === TRAEFIK_PREFIX) {
      routing.labels.push({ key, value: text, path, source: routing.source });
    } else if (key.startsWith('com.docker.')) {
      // Docker's own metadata keys never reach Kubernetes
    } else if (isReservedKey(key)) {
      ctx.sink.error('labels.reserved', path, `${key} uses the prefix dockflow.shawiizz.dev/, which is reserved for Dockflow`, 'Rename the label.');
    } else if (!isLabelKey(key)) {
      ctx.sink.warn(
        'labels.invalid-key',
        path,
        `label ${key} is not a valid Kubernetes annotation key and is dropped`,
        'Use an optional DNS prefix and a name of letters, digits, `-`, `_` and `.` (at most 63 characters).',
      );
    } else {
      target[key] = text;
    }
  }
}

function annotationBytes(map: Record<string, string>): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const [k, v] of Object.entries(map)) total += encoder.encode(k).length + encoder.encode(v).length;
  return total;
}

function normalizeMetadata(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  if (!isAbsent(node.container_name)) {
    ctx.sink.warn(
      'unsupported.container-name',
      childPath(path, 'container_name'),
      'container_name is ignored: pod names are generated by Kubernetes',
      `Remove \`container_name\`; other services reach this one by the name \`${draft.name}\`.`,
    );
  }

  // label_file entries first, `labels` override them key by key
  const labels = new Map<string, ListOrDictEntry>();
  if (!isAbsent(node.label_file)) {
    for (const entry of readLabelFiles(node.label_file, childPath(path, 'label_file'), ctx)) labels.set(entry.key, entry);
  }
  if (!isAbsent(node.labels)) {
    for (const entry of readListOrDict(node.labels, childPath(path, 'labels'), ctx) ?? []) {
      labels.delete(entry.key);
      labels.set(entry.key, entry);
    }
  }
  classifyLabels([...labels.values()], draft.containerLabels, { labels: draft.routingLabels, source: 'labels' }, ctx);

  if (!isAbsent(node.annotations)) {
    classifyLabels(readListOrDict(node.annotations, childPath(path, 'annotations'), ctx) ?? [], draft.podAnnotations, null, ctx);
  }
  if (isPlainMap(node.deploy) && !isAbsent(node.deploy.labels)) {
    const deployLabels = readListOrDict(node.deploy.labels, childPath(childPath(path, 'deploy'), 'labels'), ctx) ?? [];
    classifyLabels(deployLabels, draft.serviceLabels, { labels: draft.routingLabels, source: 'deploy.labels' }, ctx);
  }

  // pod template annotations: labels, annotations, and the ones the translator generates
  const generated =
    annotationBytes({
      [ANNOTATIONS.composeService]: draft.composeName,
      [ANNOTATIONS.defaultContainer]: draft.name,
    }) +
    ANNOTATIONS.configHash.length +
    CONFIG_HASH_LENGTH;
  if (annotationBytes(draft.containerLabels) + annotationBytes(draft.podAnnotations) + generated > ANNOTATIONS_MAX_BYTES) {
    ctx.sink.error(
      'labels.too-large',
      path,
      `the labels and annotations of ${draft.composeName} exceed the Kubernetes limit of 256 KiB`,
      'Move large values out of labels.',
    );
  }
}

// ---------------------------------------------------------------------------
// Keys refused or ignored as a whole (design-01 5.1 MISC rows, 5.12)
// ---------------------------------------------------------------------------

function isEmptyCollection(value: unknown): boolean {
  return isAbsent(value) || (Array.isArray(value) && value.length === 0) || (isPlainMap(value) && Object.keys(value).length === 0);
}

function refuseUnsupported(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  if (!isEmptyCollection(node.profiles)) {
    ctx.sink.error(
      'unsupported.profiles',
      childPath(path, 'profiles'),
      'profiles is not supported: Dockflow activates no Compose profile, so this service would never start',
      'Remove `profiles` to deploy the service, or delete the service.',
    );
  }
  if (!isAbsent(node.provider)) {
    ctx.sink.error(
      'unsupported.provider',
      childPath(path, 'provider'),
      'provider services are not supported',
      'Declare the dependency as a service or accessory with an image.',
    );
  }
  if (!isAbsent(node.extends)) {
    ctx.sink.error(
      'unsupported.extends',
      childPath(path, 'extends'),
      'extends is not supported',
      'Share common settings with a YAML anchor and a merge key (`<<: *common`).',
    );
  }
  if (!isEmptyCollection(node.models)) {
    ctx.sink.error(
      'unsupported.models',
      childPath(path, 'models'),
      'models is not supported on Kubernetes deploys',
      'Run the model server as a regular service with an image.',
    );
  }
  if (!isEmptyCollection(node.pre_start)) {
    ctx.sink.error(
      'unsupported.pre-start',
      childPath(path, 'pre_start'),
      'pre_start is not supported in this Dockflow version',
      'Run the step in the container entrypoint, or as a separate service with `deploy.mode: replicated-job`.',
    );
  }
  if (!isAbsent(node.develop)) {
    ctx.sink.info('keys.develop-ignored', childPath(path, 'develop'), 'develop only configures local development (compose watch) and is ignored');
  }
  if (!isAbsent(node.attach)) {
    ctx.sink.info('keys.attach-ignored', childPath(path, 'attach'), 'attach only affects local log output and is ignored');
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('x-') && key !== 'x-dockflow') {
      ctx.sink.info('extension.ignored', childPath(path, key), `${key} is an extension field and is ignored`);
    }
  }
}

// ---------------------------------------------------------------------------
// Process keys (design-01 5.2)
// ---------------------------------------------------------------------------

type Argv = { kind: 'absent' } | { kind: 'empty' } | { kind: 'argv'; argv: string[] } | { kind: 'invalid' };

/** `command`, `entrypoint` and hook commands: a string split into words, or a list of strings. */
function readArgv(value: unknown, path: string, ctx: NormalizeContext): Argv {
  if (isAbsent(value)) return { kind: 'absent' };
  if (typeof value === 'string') {
    const split = shlexSplit(value);
    if ('error' in split) {
      ctx.sink.error(
        'process.invalid-shell-words',
        path,
        `cannot be split into words: ${split.error === 'unterminated-quote' ? 'unterminated quote' : 'trailing backslash'}`,
        'Close the quote, or write the command as a list.',
      );
      return { kind: 'invalid' };
    }
    if (split.words.length === 0) return { kind: 'empty' };
    const word = shellSyntaxWord(split.words);
    if (word !== null) {
      ctx.sink.warn(
        'process.shell-syntax',
        path,
        `contains shell syntax (${word}) that is passed to the program as a plain argument: no shell runs the command`,
        'Write the command as a list starting with /bin/sh and -c if a shell is intended.',
      );
    }
    return { kind: 'argv', argv: split.words };
  }
  if (!Array.isArray(value)) {
    reportInvalidType(ctx, path, 'string or list', value);
    return { kind: 'invalid' };
  }
  if (value.length === 0) return { kind: 'empty' };
  let valid = true;
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      reportInvalidType(ctx, indexPath(path, i), 'string', item);
      valid = false;
    }
  });
  if (!valid) return { kind: 'invalid' };
  const argv = value as string[];
  if (argv[0] === '') {
    ctx.sink.error('process.empty-program', indexPath(path, 0), 'the first element must name a program');
    return { kind: 'invalid' };
  }
  return { kind: 'argv', argv: [...argv] };
}

/** design-01 5.2 folding table: a non-null entrypoint drops the image CMD, as does a Kubernetes command without args */
function foldCommand(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const entrypointPath = childPath(draft.path, 'entrypoint');
  const commandPath = childPath(draft.path, 'command');
  const entrypoint = readArgv(node.entrypoint, entrypointPath, ctx);
  const command = readArgv(node.command, commandPath, ctx);
  if (entrypoint.kind === 'invalid' || command.kind === 'invalid') return;
  switch (entrypoint.kind) {
    case 'absent':
      if (command.kind === 'empty') {
        ctx.sink.error(
          'process.empty-command',
          commandPath,
          'an empty command (clearing the image CMD but keeping its ENTRYPOINT) cannot be expressed on Kubernetes, where empty args mean "use the image CMD"',
          'Remove `command` to keep the image `CMD`, or set `entrypoint:` to the full command line.',
        );
      } else if (command.kind === 'argv') {
        draft.process.command = command.argv;
      }
      return;
    case 'argv':
      draft.process.entrypoint = entrypoint.argv;
      if (command.kind === 'argv') draft.process.command = command.argv;
      return;
    case 'empty':
      if (command.kind === 'argv') {
        // Docker runs the command with no entrypoint
        draft.process.entrypoint = command.argv;
      } else {
        ctx.sink.error(
          'process.empty-entrypoint',
          entrypointPath,
          'an empty entrypoint without a command leaves nothing to run',
          'Set `command:` to the program to run, or remove `entrypoint`.',
        );
      }
      return;
  }
}

const DEFAULT_STOP_SIGNALS = new Set(['SIGTERM', 'TERM', '15']);

function normalizeProcess(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  foldCommand(draft, node, ctx);

  if (!isAbsent(node.working_dir)) {
    const workingDirPath = childPath(path, 'working_dir');
    const dir = readString(node.working_dir, workingDirPath, ctx);
    if (dir !== null && !isAbsolutePosixPath(dir)) {
      ctx.sink.error(
        'process.relative-working-dir',
        workingDirPath,
        `working_dir ${displayValue(dir)} must be an absolute path`,
        'Write the full path, for example `/app`.',
      );
    } else if (dir !== null) {
      draft.process.workingDir = dir;
    }
  }

  const flags = [
    ['tty', 'tty'],
    ['stdin_open', 'stdinOpen'],
    ['init', 'init'],
  ] as const;
  for (const [key, field] of flags) {
    if (isAbsent(node[key])) continue;
    const value = readBool(node[key], childPath(path, key), ctx);
    if (value !== null) draft.process[field] = value;
  }

  if (!isAbsent(node.stop_grace_period)) {
    const ms = readDuration(node.stop_grace_period, childPath(path, 'stop_grace_period'), ctx);
    if (ms !== null) draft.process.stopGracePeriodMs = ms;
  }

  if (!isAbsent(node.stop_signal)) {
    const signalPath = childPath(path, 'stop_signal');
    const signal = node.stop_signal;
    if (typeof signal !== 'string' && typeof signal !== 'number') {
      reportInvalidType(ctx, signalPath, 'string', signal);
    } else if (!DEFAULT_STOP_SIGNALS.has(String(signal).toUpperCase())) {
      ctx.sink.warn(
        'process.stop-signal-ignored',
        signalPath,
        `stop_signal ${displayValue(signal)} is not supported on Kubernetes: the image STOPSIGNAL, or SIGTERM, is sent`,
        'Set `STOPSIGNAL` in the Dockerfile, or handle `SIGTERM` in the program.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle hooks (design-01 5.12)
// ---------------------------------------------------------------------------

const HOOK_OPTIONS_UNSUPPORTED = ['user', 'working_dir', 'environment'] as const;

function readHook(key: 'post_start' | 'pre_stop', value: unknown, path: string, ctx: NormalizeContext): string[] | null {
  if (isAbsent(value)) return null;
  if (!Array.isArray(value)) {
    reportInvalidType(ctx, path, 'list', value);
    return null;
  }
  if (value.length === 0) return null;
  const handler = key === 'post_start' ? 'postStart' : 'preStop';
  let ok = true;
  if (value.length > 1) {
    ctx.sink.error(
      'hooks.too-many',
      path,
      `${key} has ${value.length} hooks; Kubernetes runs one ${handler} handler per container`,
      'Combine them into one command, for example `["/bin/sh", "-c", "first && second"]`.',
    );
    ok = false;
  }
  let result: string[] | null = null;
  value.forEach((hook, i) => {
    const hookPath = indexPath(path, i);
    if (!isPlainMap(hook)) {
      reportInvalidType(ctx, hookPath, 'mapping', hook);
      ok = false;
      return;
    }
    const unsupported = (opt: string): void => {
      ctx.sink.error(
        'hooks.option-unsupported',
        childPath(hookPath, opt),
        `${key}[${i}].${opt} is not supported: Kubernetes runs lifecycle hooks with the container's user, working directory and environment`,
        `Remove \`${opt}\`, or wrap the command with \`/bin/sh -c\`.`,
      );
      ok = false;
    };
    for (const opt of HOOK_OPTIONS_UNSUPPORTED) if (!isAbsent(hook[opt])) unsupported(opt);
    if (!isAbsent(hook.privileged)) {
      const privileged = readBool(hook.privileged, childPath(hookPath, 'privileged'), ctx);
      if (privileged === true) unsupported('privileged');
      else if (privileged === null) ok = false;
    }
    const commandPath = childPath(hookPath, 'command');
    const command = readArgv(hook.command, commandPath, ctx);
    if (command.kind === 'absent' || command.kind === 'empty') {
      reportEmpty(ctx, commandPath);
      ok = false;
    } else if (command.kind === 'invalid') {
      ok = false;
    } else {
      result = command.argv;
    }
  });
  return ok ? result : null;
}

function normalizeHooks(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  draft.process.postStart = readHook('post_start', node.post_start, childPath(draft.path, 'post_start'), ctx);
  draft.process.preStop = readHook('pre_stop', node.pre_stop, childPath(draft.path, 'pre_stop'), ctx);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * design-01 1.1 step 6: name warning, image and pull policy, platform, label maps and the routing
 * label set, whole-key refusals, process keys and hooks. Name collisions are stack checks
 * (design-01 10 S1), which need every service's name, ports and aliases.
 */
export function identity(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  if (draft.name !== draft.composeName) {
    ctx.sink.warn(
      'names.sanitized',
      draft.path,
      `is deployed as Kubernetes service ${draft.name}; clients using the name ${draft.composeName} will not resolve it`,
      `Rename the service to \`${draft.name}\` (lowercase letters, digits and \`-\`).`,
    );
  }
  normalizeImage(draft, node, ctx);
  normalizePlatform(draft, node, ctx);
  normalizeMetadata(draft, node, ctx);
  refuseUnsupported(draft, node, ctx);
  normalizeProcess(draft, node, ctx);
  normalizeHooks(draft, node, ctx);
}
