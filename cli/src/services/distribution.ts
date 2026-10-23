/**
 * Distribution — gets images onto the nodes: `save` piped over SSH into `load` (docker or podman),
 * from this machine or from the build node, plus registry login and push.
 */

import type { ClientChannel } from 'ssh2';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { SSHKeyConnection } from '../types';
import { raw, sh, sshExec, sshExecChannel, sshExecChannelUnbuffered, type ShellValue } from '../utils/ssh';
import { printDebug, printDim, printSuccess, printWarning, createTimedSpinner } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { parseImageRef } from './compose';

export type ContainerRuntime = 'docker' | 'podman';

export interface DistributionTarget {
  connection: SSHKeyConnection;
  name: string;
}

const TRANSFER_MAX_RETRIES = 2;

function importCommand(runtime: ContainerRuntime): string {
  return sh`gunzip | ${runtime} load`;
}

function saveCommand(image: string, runtime: ContainerRuntime): string {
  return sh`${runtime} save ${image} | gzip -1`;
}

/**
 * What an image is made of: its layers and the config its containers start from. The image id is
 * no use here: an image store on containerd and a classic one give the same image different ids.
 */
export const IMAGE_CONTENT_FORMAT =
  '{{json .RootFS.Layers}} {{json .Config.Env}} {{json .Config.Cmd}} {{json .Config.Entrypoint}} ' +
  '{{json .Config.WorkingDir}} {{json .Config.User}} {{json .Config.ExposedPorts}} {{json .Config.Volumes}} ' +
  '{{json .Config.Labels}} {{json .Config.StopSignal}} {{json .Config.Healthcheck}} {{json .Os}} {{json .Architecture}}';

/** The sha256 of an image's content, as the remote shell prints it; `ref` is quoted unless it is `raw`. */
function contentKeyPipeline(ref: ShellValue, runtime: ContainerRuntime): string {
  return sh`${runtime} image inspect --format ${IMAGE_CONTENT_FORMAT} ${ref} 2>/dev/null | sha256sum | cut -d' ' -f1`;
}

/** The content key of an image on this machine; empty when the engine does not know it. */
export async function getLocalContentKey(image: string, runtime: ContainerRuntime = 'docker'): Promise<string> {
  const proc = Bun.spawn([runtime, 'image', 'inspect', '--format', IMAGE_CONTENT_FORMAT, image], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  if (await proc.exited !== 0 || !stdout.trim()) return '';
  return createHash('sha256').update(stdout).digest('hex');
}

/** The content key of an image on a node; empty when the node does not hold it. */
export async function getRemoteContentKey(connection: SSHKeyConnection, image: string, runtime: ContainerRuntime = 'docker'): Promise<string> {
  const result = await sshExec(connection, sh`${runtime} image inspect ${image} >/dev/null 2>&1 && ${raw(contentKeyPipeline(image, runtime))}`);
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

/**
 * Tags `image` on a node from one of the images of its repository with the content `key`, the
 * previous version's most often; fails when the node holds none.
 */
export function tagSameContentCommand(image: string, key: string, runtime: ContainerRuntime): string {
  const { name } = parseImageRef(image);
  // "$id" is the loop variable of the script itself, not a value
  const idKey = contentKeyPipeline(raw('"$id"'), runtime);
  return (
    sh`for id in $(${runtime} images -q --no-trunc ${name} 2>/dev/null | sort -u); do ` +
    'id=${id#sha256:}; ' +
    sh`[ "$(${raw(idKey)})" = ${key} ] && exec ${runtime} tag "$id" ${image}; ` +
    'done; exit 1'
  );
}

async function pipeToChannel(
  source: ReadableStream<Uint8Array>,
  sink: ClientChannel,
): Promise<void> {
  const reader = source.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      try {
        if (!sink.write(value)) {
          await new Promise<void>((resolve) => {
            const onDrain = () => { sink.removeListener('close', onClose); resolve(); };
            const onClose = () => { sink.removeListener('drain', onDrain); resolve(); };
            sink.once('drain', onDrain);
            sink.once('close', onClose);
          });
        }
      } catch {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  try { sink.end(); } catch { }
}

function pipeChannels(
  source: ClientChannel,
  sink: ClientChannel,
): Promise<void> {
  return new Promise<void>((resolve) => {
    sink.once('close', () => { try { source.destroy(); } catch { } });

    source.on('data', (chunk: Buffer) => {
      try {
        if (!sink.write(chunk)) {
          source.pause();
          sink.once('drain', () => source.resume());
        }
      } catch {
        try { source.destroy(); } catch { }
      }
    });

    source.on('end', () => {
      try { sink.end(); } catch { }
      resolve();
    });
    source.on('close', () => resolve());
    source.on('error', () => resolve());
  });
}

async function streamToTarget(
  image: string,
  target: DistributionTarget,
  runtime: ContainerRuntime = 'docker',
): Promise<void> {
  const { stream: sink, done } = await sshExecChannel(
    target.connection,
    importCommand(runtime),
  );

  sink.resume();

  const saveProc = Bun.spawn([runtime, 'save', image], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const gzip = createGzip({ level: 1 });
  Readable.fromWeb(saveProc.stdout as unknown as import('node:stream/web').ReadableStream).pipe(gzip);

  const gzipStream = Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>;
  await pipeToChannel(gzipStream, sink);

  const [result] = await Promise.all([done, saveProc.exited]);

  if (saveProc.exitCode !== 0) {
    const stderr = await new Response(saveProc.stderr).text();
    throw new Error(`docker save failed for ${image}: ${stderr.trim()}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`image import failed on ${target.name}: ${result.stderr.trim()}`);
  }
}

/** The text a stream writes, kept for the error message (stderr is short). */
function collectText(stream: NodeJS.ReadableStream): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  return () => text;
}

/** `save` on the source node piped into `load` on the target, never holding the image in memory. */
async function streamRemoteToTarget(
  image: string,
  source: SSHKeyConnection,
  target: DistributionTarget,
  runtime: ContainerRuntime = 'docker',
): Promise<void> {
  const sinkChannel = await sshExecChannelUnbuffered(target.connection, importCommand(runtime));
  const sink = sinkChannel.stream;
  const sinkErr = collectText(sink.stderr);
  sink.resume();

  const srcChannel = await sshExecChannelUnbuffered(source, saveCommand(image, runtime));
  const src = srcChannel.stream;
  const srcErr = collectText(src.stderr);

  await pipeChannels(src, sink);

  const [srcResult, sinkResult] = await Promise.all([srcChannel.done, sinkChannel.done]);

  if (srcResult.exitCode !== 0) {
    throw new Error(`image export failed on the build node: ${srcErr().trim() || `exit ${srcResult.exitCode}`}`);
  }
  if (sinkResult.exitCode !== 0) {
    throw new Error(`image import failed on ${target.name}: ${sinkErr().trim() || `exit ${sinkResult.exitCode}`}`);
  }
}

/** The targets the image must be sent to: not those that hold it already, under this tag or another. */
async function filterTargetsNeedingImage(
  image: string,
  sourceKey: string,
  targets: DistributionTarget[],
  runtime: ContainerRuntime = 'docker',
): Promise<DistributionTarget[]> {
  if (!sourceKey) return targets;

  const checks = await Promise.all(
    targets.map(async (target) => {
      // each deploy tags a new version: an unchanged image is there already under the previous tag
      const tagged = await sshExec(target.connection, tagSameContentCommand(image, sourceKey, runtime));
      if (tagged.exitCode === 0) {
        printDim(`Already on ${target.name}: ${image}`);
        return null;
      }
      return target;
    }),
  );

  return checks.filter((target): target is DistributionTarget => target !== null);
}

async function transferImageToTargets(
  image: string,
  targets: DistributionTarget[],
  streamFn: (image: string, target: DistributionTarget) => Promise<void>,
  label: string,
): Promise<void> {
  let remaining = targets;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= TRANSFER_MAX_RETRIES + 1; attempt++) {
    const results = await Promise.allSettled(
      remaining.map((t) => streamFn(image, t)),
    );

    const failed: DistributionTarget[] = [];
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        failed.push(remaining[i]);
        errors.push((results[i] as PromiseRejectedResult).reason?.message ?? 'unknown');
      } else {
        printSuccess(`Transferred ${image} to ${remaining[i].name}${label}`);
      }
    }

    if (failed.length === 0) return;

    lastError = errors.join('; ');
    remaining = failed;

    if (attempt <= TRANSFER_MAX_RETRIES) {
      printWarning(
        `Transfer attempt ${attempt} failed for ${image} on ${remaining.map((t) => t.name).join(', ')}, retrying...`,
      );
    }
  }

  throw new DeployError(
    `Failed to transfer ${image} after ${TRANSFER_MAX_RETRIES + 1} attempts: ${lastError}`,
    ErrorCode.DEPLOY_FAILED,
  );
}

async function distributeImages(
  images: string[],
  targets: DistributionTarget[],
  runtime: ContainerRuntime,
  source: SSHKeyConnection | 'local',
): Promise<void> {
  if (images.length === 0 || targets.length === 0) return;

  const isRemote = source !== 'local';
  const label = isRemote ? ' (from remote)' : '';

  const spinner = createTimedSpinner();
  spinner.start(`Distributing ${images.length} image(s) to ${targets.length} node(s)${label}...`);

  try {
    for (const image of images) {
      spinner.update(`Distributing ${image}${label}...`);

      const sourceKey = isRemote
        ? await getRemoteContentKey(source, image, runtime)
        : await getLocalContentKey(image, runtime);

      const needsUpdate = await filterTargetsNeedingImage(image, sourceKey, targets, runtime);
      if (needsUpdate.length === 0) continue;

      const streamFn = isRemote
        ? (img: string, t: DistributionTarget) => streamRemoteToTarget(img, source, t, runtime)
        : (img: string, t: DistributionTarget) => streamToTarget(img, t, runtime);

      await transferImageToTargets(image, needsUpdate, streamFn, label);
    }

    spinner.succeed(`Distributed ${images.length} image(s) to ${targets.length} node(s)${label}`);
  } catch (error) {
    spinner.fail('Image distribution failed');
    throw error;
  }
}

export async function distributeAll(
  images: string[],
  targets: DistributionTarget[],
  runtime: ContainerRuntime = 'docker',
): Promise<void> {
  return distributeImages(images, targets, runtime, 'local');
}

export async function distributeFromRemote(
  images: string[],
  source: SSHKeyConnection,
  targets: DistributionTarget[],
  runtime: ContainerRuntime = 'docker',
): Promise<void> {
  return distributeImages(images, targets, runtime, source);
}

export interface RegistryLogin {
  url: string;
  username?: string;
  password: string;
}

function firstTextLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

/**
 * `<engine> login` on a server, the password on stdin so it never reaches a process listing.
 * Without a username, which `login --password-stdin` requires, the registry is used anonymously.
 */
export async function registryLogin(
  connection: SSHKeyConnection,
  config: RegistryLogin,
  engine: ContainerRuntime = 'docker',
): Promise<void> {
  if (!config.username) return;
  printDebug('Logging in to container registry...');

  const result = await sshExec(
    connection,
    sh`${engine} login ${config.url} -u ${config.username} --password-stdin`,
    { stdin: `${config.password}\n` },
  );

  if (result.exitCode !== 0) {
    throw new DeployError(
      `Registry login to ${config.url} failed on the manager: ${firstTextLine(result.stderr) || firstTextLine(result.stdout) || `exit ${result.exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
      'Check registry.url, registry.username and registry.password (or registry.token).',
    );
  }

  printDebug('Registry login successful');
}

/** `<engine> login` on this machine, the one that pushes, the password on stdin. */
export async function registryLoginLocal(config: RegistryLogin, engine: ContainerRuntime = 'docker'): Promise<void> {
  if (!config.username) return;
  printDebug('Logging in to container registry...');
  const proc = Bun.spawn([engine, 'login', config.url, '-u', config.username, '--password-stdin'], {
    stdin: new Response(config.password).body!,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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
  engine: 'docker' | 'podman',
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
    throw new DeployError(
      `${engine} push failed for ${image}: ${stderr.trim()}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  printSuccess(`Pushed ${image}`);

  if (additionalTags && additionalTags.tags.length > 0) {
    const imageBase = parseImageRef(image).name;

    await Promise.all(additionalTags.tags.map(async (tagTemplate) => {
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
    }));
  }
}

export async function pushImages(
  images: string[],
  additionalTags?: { tags: string[]; env: string; version: string; branch: string },
  engine: 'docker' | 'podman' = 'docker',
): Promise<void> {
  const sha = additionalTags ? await getGitSha() : '';
  const tagsWithSha = additionalTags ? { ...additionalTags, sha } : undefined;

  await Promise.all(
    images.map((image) => pushSingleImage(image, engine, tagsWithSha)),
  );
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
