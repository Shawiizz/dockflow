import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { SSHKeyConnection } from '../types';
import { ContainerPathError, planCopyIn, probeContainerPath } from '../services/swarm/copy';
import { extractTar, packPathToTar } from '../utils/tar';
import { hasPosixShell } from './helpers/local-shell';

const hasTar = Bun.which('tar') !== null;
const available = hasPosixShell && hasTar;

/** `docker cp` against a directory standing for the container's filesystem: the archive goes through stdout or stdin. */
const FAKE_DOCKER = `#!/bin/sh
[ "$1" = cp ] || exit 2
if [ "$2" = - ]; then
  dir="\${3#*:}"
  if [ ! -d "$FAKE_ROOT$dir" ]; then echo "destination \\"$3\\" must be a directory" >&2; exit 1; fi
  tar -x -C "$FAKE_ROOT$dir"
else
  path="\${2#*:}"
  case "$path" in
    */.) base="\${path%/.}"
      if [ ! -d "$FAKE_ROOT$base" ]; then echo "Error response from daemon: Could not find the file $base in container" >&2; exit 1; fi
      tar -c -C "$FAKE_ROOT$base" . ;;
    *) if [ ! -e "$FAKE_ROOT$path" ]; then echo "Error response from daemon: Could not find the file $path in container" >&2; exit 1; fi
      tar -c -C "$(dirname "$FAKE_ROOT$path")" "$(basename "$path")" ;;
  esac
fi
`;

let intercept = false;
const commands: string[] = [];
let psCalls = 0;
let binDir = '';
let containerRoot = '';

function fakeChannel(command: string) {
  commands.push(command);
  const child = spawn('sh', ['-c', command], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_ROOT: containerRoot },
  });
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      child.stdin.write(chunk, callback);
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk: Buffer) => stream.push(chunk));
  child.stdout.on('end', () => stream.push(null));
  const channel = Object.assign(stream, { stderr: child.stderr, close: () => child.kill() });
  const done = new Promise<{ exitCode: number }>((resolve) => child.on('exit', (code) => resolve({ exitCode: code ?? 255 })));
  return { stream: channel, done };
}

const realSsh = await import('../utils/ssh');
const unmockedSsh = { ...realSsh };
const sshSpies = [
  spyOn(realSsh, 'sshExec').mockImplementation(((conn: unknown, command: string) => {
    if (!intercept) return unmockedSsh.sshExec(conn as never, command);
    psCalls += 1;
    return Promise.resolve({ stdout: 'abc123\n', stderr: '', exitCode: 0 });
  }) as never),
  spyOn(realSsh, 'sshExecChannelUnbuffered').mockImplementation(((conn: unknown, command: string) =>
    intercept ? Promise.resolve(fakeChannel(command)) : unmockedSsh.sshExecChannelUnbuffered(conn as never, command)) as never),
];
afterAll(() => {
  for (const spy of sshSpies) spy.mockRestore();
});

const { SwarmContainers } = await import('../services/swarm/containers');

const connection = { host: 'node1', port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection;
const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockflow-cp-${label}-`));
  temporary.push(dir);
  return dir;
}

beforeAll(() => {
  if (!available) return;
  binDir = tempDir('bin');
  writeFileSync(join(binDir, 'docker'), FAKE_DOCKER);
  chmodSync(join(binDir, 'docker'), 0o755);
  intercept = true;
});

afterAll(() => {
  intercept = false;
});

afterEach(() => {
  commands.length = 0;
  psCalls = 0;
});

function newContainer(): string {
  containerRoot = tempDir('container');
  mkdirSync(join(containerRoot, 'app', 'logs'), { recursive: true });
  writeFileSync(join(containerRoot, 'app', 'logs', 'today.log'), 'line one');
  writeFileSync(join(containerRoot, 'app', 'config.yml'), 'port: 80');
  return containerRoot;
}

afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('SwarmContainers copyOut and copyIn', () => {
  it('streams a directory out of the container', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const dest = tempDir('out');
    const result = await extractTar(await containers.copyOut('shop', 'web', '/app/logs'), dest);
    expect(result).toEqual({ files: 1, bytes: 8 });
    expect(readFileSync(join(dest, 'logs', 'today.log'), 'utf8')).toBe('line one');
    expect(commands).toEqual(["docker cp 'abc123:/app/logs' -"]);
  });

  it('streams the entries of a directory for the contents form', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const dest = tempDir('contents');
    await extractTar(await containers.copyOut('shop', 'web', '/app/logs/.'), dest);
    expect(readFileSync(join(dest, 'today.log'), 'utf8')).toBe('line one');
  });

  it('errors the stream with a not-found ContainerPathError for a missing path', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const error = await extractTar(await containers.copyOut('shop', 'web', '/nope'), tempDir('missing')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ContainerPathError);
    expect(error).toMatchObject({ reason: 'not-found', message: 'Path /nope does not exist in web' });
  });

  it('copies a local directory into the container and back', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const src = tempDir('src');
    mkdirSync(join(src, 'conf', 'nested'), { recursive: true });
    writeFileSync(join(src, 'conf', 'nested', 'a.txt'), 'a');
    await containers.copyIn('shop', 'web', '/app', packPathToTar(join(src, 'conf'), 'conf'));
    expect(readFileSync(join(containerRoot, 'app', 'conf', 'nested', 'a.txt'), 'utf8')).toBe('a');
    expect(commands).toEqual(["docker cp - 'abc123:/app'"]);
  });

  it('reports a destination that is not a directory', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const src = tempDir('src');
    writeFileSync(join(src, 'f'), 'x');
    const error = await containers.copyIn('shop', 'web', '/missing', packPathToTar(join(src, 'f'), 'f')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'ContainerPathError', reason: 'not-a-directory', message: 'Path /missing in web is not a directory' });
  });

  it('fails the copy when the local archive fails', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const missing = packPathToTar(join(tempDir('none'), 'absent'), 'absent');
    await expect(containers.copyIn('shop', 'web', '/app', missing)).rejects.toThrow();
  });

  it('probes the destination without reading the whole archive and stays on one container', async () => {
    newContainer();
    writeFileSync(join(containerRoot, 'app', 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
    const containers = new SwarmContainers(connection, []);
    const open = (path: string) => containers.copyOut('shop', 'web', path);
    expect(await probeContainerPath(open, 'web', '/app/big.bin')).toEqual({ service: 'web', path: '/app/big.bin', type: 'file' });
    expect(await probeContainerPath(open, 'web', '/app/logs')).toMatchObject({ type: 'directory' });
    expect(await probeContainerPath(open, 'web', '/app/new.txt')).toEqual({ service: 'web', path: '/app/new.txt', type: 'missing', parentExists: true });
    expect(await probeContainerPath(open, 'web', '/nope/new.txt')).toMatchObject({ type: 'missing', parentExists: false });
    expect(psCalls).toBe(1);
  });

  it('copies a file over an existing file through the probe and the plan', async () => {
    newContainer();
    const containers = new SwarmContainers(connection, []);
    const src = tempDir('src');
    writeFileSync(join(src, 'new.yml'), 'port: 8080');
    const destination = await probeContainerPath((path) => containers.copyOut('shop', 'web', path), 'web', '/app/config.yml');
    const plan = planCopyIn({ path: join(src, 'new.yml'), isDirectory: false, contents: false }, destination);
    await containers.copyIn('shop', 'web', plan.destDir, packPathToTar(join(src, 'new.yml'), plan.entryName));
    expect(readFileSync(join(containerRoot, 'app', 'config.yml'), 'utf8')).toBe('port: 8080');
  });
});
