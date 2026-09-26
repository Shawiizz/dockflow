/**
 * Distribution: the local image preparation both image backends use (tag, image id and `save` of
 * the local docker or podman engine), and the Swarm transfer that streams a saved image to a node
 * over SSH (`save | gzip -1` -> `gunzip | load`). Kubernetes nodes never load images here: the
 * Kubernetes images backend imports them into containerd through its node shells.
 */

import { PassThrough, Readable, type Writable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGzip } from 'node:zlib';
import type { SSHKeyConnection } from '../types';
import { DeployError, ErrorCode } from '../utils/errors';
import { createTimedSpinner, printDebug, printDim, printSuccess, printWarning } from '../utils/output';
import { shellQuote, sshExec, sshExecChannelUnbuffered } from '../utils/ssh';
import { parseImageRef } from './compose';

/** Swarm node engines; containerd nodes import through the Kubernetes images backend */
export type ContainerRuntime = 'docker' | 'podman';

const TRANSFER_MAX_RETRIES = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstTextLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Local engine (both backends)
// ---------------------------------------------------------------------------

/** The local engine calls an image import needs; tests substitute FakeLocalEngine. */
export interface LocalEngine {
  readonly kind: ContainerRuntime;
  /** `<engine> tag <source> <target>` */
  tag(source: string, target: string): Promise<void>;
  /** the image id (`sha256:...`) `<engine> image inspect` reports; throws when the image is missing */
  imageId(ref: string): Promise<string>;
  /** `<engine> save <refs...>` as a tar stream; a failed save destroys the stream with the error */
  save(refs: readonly string[]): Readable;
}

/** The error every local engine call fails with, real or fake. */
export function localEngineError(kind: ContainerRuntime, args: readonly string[], stderr: string): DeployError {
  const detail = firstTextLine(stderr);
  return new DeployError(`${kind} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, ErrorCode.DEPLOY_FAILED);
}

async function runLocal(kind: ContainerRuntime, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([kind, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function saveStream(kind: ContainerRuntime, refs: readonly string[]): Readable {
  const args = ['save', ...refs];
  const proc = Bun.spawn([kind, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(proc.stderr).text();
  const out = new PassThrough();
  let finished = false;
  const source = Readable.fromWeb(proc.stdout as unknown as NodeReadableStream<Uint8Array>);
  source.on('error', (error) => {
    finished = true;
    out.destroy(error);
  });
  source.pipe(out, { end: false });
  source.on('end', () => {
    void Promise.all([proc.exited, stderr]).then(([exitCode, text]) => {
      finished = true;
      if (exitCode === 0) out.end();
      else out.destroy(localEngineError(kind, args, text));
    });
  });
  // a consumer that gave up (a failed node, an expired guard) must not leave the save running
  out.on('close', () => {
    if (!finished) proc.kill();
  });
  return out;
}

/** The docker or podman CLI of this machine. */
export function createLocalEngine(kind: ContainerRuntime): LocalEngine {
  return {
    kind,
    async tag(source, target) {
      const args = ['tag', source, target];
      const result = await runLocal(kind, args);
      if (result.exitCode !== 0) throw localEngineError(kind, args, result.stderr);
    },
    async imageId(ref) {
      const args = ['image', 'inspect', '--format', '{{.Id}}', ref];
      const result = await runLocal(kind, args);
      const id = result.stdout.trim();
      if (result.exitCode !== 0 || id === '') throw localEngineError(kind, args, result.stderr);
      // podman prints the bare hex; docker, crictl and `images --no-trunc` carry the algorithm
      return /^[0-9a-f]{64}$/.test(id) ? `sha256:${id}` : id;
    },
    save: (refs) => saveStream(kind, refs),
  };
}

/** `container_engine` from config.yml, else docker when this machine has it, else podman. */
export function detectLocalEngine(configured?: ContainerRuntime): ContainerRuntime {
  if (configured) return configured;
  if (Bun.which('docker')) return 'docker';
  return Bun.which('podman') ? 'podman' : 'docker';
}

/** Progress of an image backend: one line per node outcome, and best-effort failures. */
export const imageProgress = {
  info: (line: string): void => printDim(line),
  debug: (line: string): void => printDebug(line),
};

// ---------------------------------------------------------------------------
// Swarm transfer
// ---------------------------------------------------------------------------

export interface DistributionTarget {
  connection: SSHKeyConnection;
  name: string;
}

/** An exec channel whose streams the caller drives; the caller reads both outputs. */
export interface TransferChannel {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  done: Promise<{ exitCode: number }>;
  close(): void;
}

/** What the transfer runs on nodes; the Swarm backends' SSH seam satisfies it. */
export interface TransferTransport<T extends DistributionTarget = DistributionTarget> {
  exec(target: T, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  channel(target: T, command: string): Promise<TransferChannel>;
}

export const sshTransferTransport: TransferTransport = {
  async exec(target, command) {
    const result = await sshExec(target.connection, command);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },
  async channel(target, command) {
    const { stream, done } = await sshExecChannelUnbuffered(target.connection, command);
    return { stdin: stream, stdout: stream, stderr: stream.stderr, done, close: () => stream.close() };
  },
};

export interface TransferOptions<T extends DistributionTarget = DistributionTarget> {
  /** default: SSH through utils/ssh */
  transport?: TransferTransport<T>;
  /** default: the local CLI of the same engine as the nodes */
  local?: LocalEngine;
}

function loadCommand(runtime: ContainerRuntime): string {
  return `gunzip | ${runtime} load`;
}

function saveCommand(image: string, runtime: ContainerRuntime): string {
  return `${runtime} save ${shellQuote(image)} | gzip -1`;
}

function imageIdCommand(image: string, runtime: ContainerRuntime): string {
  return `${runtime} images --no-trunc -q ${shellQuote(image)} 2>/dev/null | head -1`;
}

/** Collects a channel output as text as it arrives. */
function collectText(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk)));
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

export async function getRemoteImageId(
  connection: SSHKeyConnection,
  image: string,
  runtime: ContainerRuntime = 'docker',
): Promise<string> {
  const result = await sshExec(connection, imageIdCommand(image, runtime));
  return result.stdout.trim();
}

export async function getLocalImageId(image: string, engine: ContainerRuntime = 'docker'): Promise<string> {
  const proc = Bun.spawn([engine, 'images', '--no-trunc', '-q', image], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim().split('\n')[0] || '';
}

async function remoteImageId<T extends DistributionTarget>(
  transport: TransferTransport<T>,
  target: T,
  image: string,
  runtime: ContainerRuntime,
): Promise<string> {
  const result = await transport.exec(target, imageIdCommand(image, runtime));
  return result.stdout.trim();
}

async function streamToTarget<T extends DistributionTarget>(
  image: string,
  target: T,
  runtime: ContainerRuntime,
  transport: TransferTransport<T>,
  local: LocalEngine,
): Promise<void> {
  const sink = await transport.channel(target, loadCommand(runtime));
  const stderr = collectText(sink.stderr);
  sink.stdout.resume();
  sink.stdin.on('error', () => {});
  const gzip = createGzip({ level: 1 });
  let saveError: unknown = null;
  const save = local.save([image]);
  save.on('error', (error) => {
    saveError = error;
    gzip.destroy();
    sink.close();
  });
  save.pipe(gzip).pipe(sink.stdin);

  const { exitCode } = await sink.done;
  await nextTurn();
  if (saveError !== null) throw saveError instanceof Error ? saveError : new Error(String(saveError));
  if (exitCode !== 0) {
    throw new Error(`image load failed on ${target.name}: ${firstTextLine(stderr()) || `exit ${exitCode}`}`);
  }
}

async function streamRemoteToTarget<T extends DistributionTarget>(
  image: string,
  source: T,
  target: T,
  runtime: ContainerRuntime,
  transport: TransferTransport<T>,
): Promise<void> {
  const sink = await transport.channel(target, loadCommand(runtime));
  const sinkStderr = collectText(sink.stderr);
  sink.stdout.resume();
  sink.stdin.on('error', () => {});

  const src = await transport.channel(source, saveCommand(image, runtime));
  const srcStderr = collectText(src.stderr);
  src.stdin.end();
  src.stdout.pipe(sink.stdin);

  const [srcResult, sinkResult] = await Promise.all([src.done, sink.done]);
  await nextTurn();
  if (srcResult.exitCode !== 0) {
    throw new Error(`image export failed on ${source.name}: ${firstTextLine(srcStderr()) || `exit ${srcResult.exitCode}`}`);
  }
  if (sinkResult.exitCode !== 0) {
    throw new Error(`image load failed on ${target.name}: ${firstTextLine(sinkStderr()) || `exit ${sinkResult.exitCode}`}`);
  }
}

async function filterTargetsNeedingImage<T extends DistributionTarget>(
  image: string,
  sourceId: string,
  targets: T[],
  runtime: ContainerRuntime,
  transport: TransferTransport<T>,
): Promise<T[]> {
  if (!sourceId) return targets;

  const checks = await Promise.all(
    targets.map(async (target) => ({
      target,
      needsUpdate: (await remoteImageId(transport, target, image, runtime)) !== sourceId,
    })),
  );

  for (const { target, needsUpdate } of checks) {
    if (!needsUpdate) printDim(`Already up to date on ${target.name}: ${image}`);
  }

  return checks.filter((c) => c.needsUpdate).map((c) => c.target);
}

async function transferImageToTargets<T extends DistributionTarget>(
  image: string,
  targets: T[],
  streamFn: (image: string, target: T) => Promise<void>,
  label: string,
): Promise<void> {
  let remaining = targets;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= TRANSFER_MAX_RETRIES + 1; attempt++) {
    const results = await Promise.allSettled(remaining.map((t) => streamFn(image, t)));

    const failed: T[] = [];
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        failed.push(remaining[i]);
        errors.push(errorMessage(result.reason));
      } else {
        printSuccess(`Transferred ${image} to ${remaining[i].name}${label}`);
      }
    }

    if (failed.length === 0) return;

    lastError = errors.join('; ');
    remaining = failed;

    if (attempt <= TRANSFER_MAX_RETRIES) {
      printWarning(`Transfer attempt ${attempt} failed for ${image} on ${remaining.map((t) => t.name).join(', ')}, retrying...`);
    }
  }

  throw new DeployError(
    `Failed to transfer ${image} after ${TRANSFER_MAX_RETRIES + 1} attempts: ${lastError}`,
    ErrorCode.DEPLOY_FAILED,
  );
}

async function distributeImages<T extends DistributionTarget>(
  images: string[],
  targets: T[],
  runtime: ContainerRuntime,
  source: T | 'local',
  transport: TransferTransport<T>,
  local: LocalEngine,
): Promise<void> {
  if (images.length === 0 || targets.length === 0) return;

  const label = source === 'local' ? '' : ' (from remote)';

  const spinner = createTimedSpinner();
  spinner.start(`Distributing ${images.length} image(s) to ${targets.length} node(s)${label}...`);

  try {
    for (const image of images) {
      spinner.update(`Distributing ${image}${label}...`);

      const sourceId =
        source === 'local'
          ? await local.imageId(image).catch(() => '')
          : await remoteImageId(transport, source, image, runtime);

      const needsUpdate = await filterTargetsNeedingImage(image, sourceId, targets, runtime, transport);
      if (needsUpdate.length === 0) continue;

      const streamFn =
        source === 'local'
          ? (img: string, t: T) => streamToTarget(img, t, runtime, transport, local)
          : (img: string, t: T) => streamRemoteToTarget(img, source, t, runtime, transport);

      await transferImageToTargets(image, needsUpdate, streamFn, label);
    }

    spinner.succeed(`Distributed ${images.length} image(s) to ${targets.length} node(s)${label}`);
  } catch (error) {
    spinner.fail('Image distribution failed');
    throw error;
  }
}

/** Streams locally built images to every target that does not already have the same image id. */
export async function distributeAll<T extends DistributionTarget>(
  images: string[],
  targets: T[],
  runtime: ContainerRuntime = 'docker',
  options: TransferOptions<T> = {},
): Promise<void> {
  const transport = options.transport ?? (sshTransferTransport as TransferTransport<T>);
  return distributeImages(images, targets, runtime, 'local', transport, options.local ?? createLocalEngine(runtime));
}

/** Streams images built on `source` (remote build) to the targets, node to node through this machine. */
export async function distributeFromRemote(
  images: string[],
  source: SSHKeyConnection,
  targets: DistributionTarget[],
  runtime: ContainerRuntime = 'docker',
  options: TransferOptions = {},
): Promise<void> {
  const transport = options.transport ?? sshTransferTransport;
  const origin: DistributionTarget = { name: source.host, connection: source };
  return distributeImages(images, targets, runtime, origin, transport, options.local ?? createLocalEngine(runtime));
}

export async function transferImage(
  image: string,
  target: DistributionTarget,
  runtime: ContainerRuntime = 'docker',
  options: TransferOptions = {},
): Promise<void> {
  const transport = options.transport ?? sshTransferTransport;
  const local = options.local ?? createLocalEngine(runtime);
  const sourceId = await local.imageId(image).catch(() => '');
  if (sourceId && (await remoteImageId(transport, target, image, runtime)) === sourceId) {
    printDim(`Already up to date on ${target.name}: ${image}`);
    return;
  }
  await transferImageToTargets(image, [target], (img, t) => streamToTarget(img, t, runtime, transport, local), '');
}

export async function transferImageFromRemote(
  image: string,
  source: SSHKeyConnection,
  target: DistributionTarget,
  runtime: ContainerRuntime = 'docker',
  options: TransferOptions = {},
): Promise<void> {
  const transport = options.transport ?? sshTransferTransport;
  const origin: DistributionTarget = { name: source.host, connection: source };
  const sourceId = await remoteImageId(transport, origin, image, runtime);
  if (sourceId && (await remoteImageId(transport, target, image, runtime)) === sourceId) {
    printDim(`Already up to date on ${target.name}: ${image}`);
    return;
  }
  await transferImageToTargets(
    image,
    [target],
    (img, t) => streamRemoteToTarget(img, origin, t, runtime, transport),
    ' (from remote)',
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryLogin {
  url: string;
  username?: string;
  password: string;
}

export function registryLoginCommand(engine: ContainerRuntime, config: Pick<RegistryLogin, 'url' | 'username'>): string {
  const user = config.username ? ` -u ${shellQuote(config.username)}` : '';
  return `${engine} login ${shellQuote(config.url)}${user} --password-stdin`;
}

/** `<engine> login` on a node, the password on stdin so it never reaches a process listing. */
export async function registryLoginOn<T extends DistributionTarget>(
  transport: TransferTransport<T>,
  target: T,
  config: RegistryLogin,
  engine: ContainerRuntime = 'docker',
): Promise<void> {
  printDebug('Logging in to container registry...');
  const channel = await transport.channel(target, registryLoginCommand(engine, config));
  const stdout = collectText(channel.stdout);
  const stderr = collectText(channel.stderr);
  channel.stdin.on('error', () => {});
  channel.stdin.end(`${config.password}\n`);
  const { exitCode } = await channel.done;
  await nextTurn();
  if (exitCode !== 0) {
    throw new DeployError(
      `Registry login failed on ${target.name}: ${firstTextLine(stderr()) || firstTextLine(stdout()) || `exit ${exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
      'Check registry URL and credentials.',
    );
  }
  printDebug('Registry login successful');
}

/**
 * `<engine> login` on this machine, which is the one that pushes, the password on stdin. Without a
 * username, which `login --password-stdin` requires, the registry is pushed to anonymously.
 */
export async function registryLoginLocal(config: RegistryLogin, engine: ContainerRuntime = 'docker'): Promise<void> {
  if (!config.username) return;
  printDebug('Logging in to container registry...');
  const proc = Bun.spawn([engine, 'login', config.url, '-u', config.username, '--password-stdin'], {
    stdin: new Response(config.password).body!,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new DeployError(
      `Registry login to ${config.url} failed: ${firstTextLine(stderr) || firstTextLine(stdout) || `exit ${exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
      'Check registry.username and registry.password (or registry.token).',
    );
  }
}

async function pushSingleImage(
  image: string,
  engine: ContainerRuntime,
  additionalTags?: { tags: string[]; env: string; version: string; branch: string; sha: string },
): Promise<void> {
  printDim(`Pushing ${image}...`);

  const proc = Bun.spawn([engine, 'push', image], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new DeployError(`${engine} push failed for ${image}: ${stderr.trim()}`, ErrorCode.DEPLOY_FAILED);
  }

  printSuccess(`Pushed ${image}`);

  if (additionalTags && additionalTags.tags.length > 0) {
    const imageBase = parseImageRef(image).name;

    await Promise.all(
      additionalTags.tags.map(async (tagTemplate) => {
        const tag = tagTemplate
          .replace(/\{version\}/g, additionalTags.version)
          .replace(/\{env\}/g, additionalTags.env)
          .replace(/\{branch\}/g, sanitizeBranch(additionalTags.branch))
          .replace(/\{sha\}/g, additionalTags.sha);

        const taggedImage = `${imageBase}:${tag}`;

        const tagProc = Bun.spawn([engine, 'tag', image, taggedImage], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await tagProc.exited;

        if (tagProc.exitCode !== 0) {
          printWarning(`Failed to tag ${taggedImage}`);
          return;
        }

        const pushProc = Bun.spawn([engine, 'push', taggedImage], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const pushStderr = await new Response(pushProc.stderr).text();
        await pushProc.exited;

        if (pushProc.exitCode !== 0) {
          printWarning(`Failed to push additional tag ${taggedImage}: ${pushStderr.trim()}`);
        } else {
          printDim(`Pushed additional tag: ${taggedImage}`);
        }
      }),
    );
  }
}

export async function pushImages(
  images: string[],
  additionalTags?: { tags: string[]; env: string; version: string; branch: string },
  engine: ContainerRuntime = 'docker',
): Promise<void> {
  const sha = additionalTags ? await getGitSha() : '';
  const tagsWithSha = additionalTags ? { ...additionalTags, sha } : undefined;

  await Promise.all(images.map((image) => pushSingleImage(image, engine, tagsWithSha)));
}

async function getGitSha(): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}
