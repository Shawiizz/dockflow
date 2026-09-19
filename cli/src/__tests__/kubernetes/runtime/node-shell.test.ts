import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Readable } from 'stream';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { isSudoRefusal, nodeShell, nodeShellFactory } from '../../../services/orchestrator/kubernetes/runtime/node-shell';
import { setVerbose } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeSsh, type FakeSshRule } from '../fakes/fake-ssh';

const SECRET = 'registry-token-8f2e';
const LIST_IMAGES = 'sudo -n /usr/local/bin/k3s crictl images -o json';
const IMPORT = 'gzip -dc | sudo -n /usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned=pinned -';

function nodeRef(name: string, role: 'manager' | 'worker'): ClusterNodeRef {
  return {
    name,
    role,
    host: '192.0.2.21',
    privateHost: '10.0.0.21',
    connection: { host: '192.0.2.21', port: 22, user: 'deploy', privateKey: 'test-only-key' },
  };
}

const AGENT = nodeRef('agent_1', 'worker');

class TestClock implements Clock {
  readonly sleeps: number[] = [];
  private pending: (() => void)[] = [];

  now(): Date {
    return new Date('2026-01-01T00:00:00Z');
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      this.pending.push(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  expireAll(): void {
    const due = this.pending;
    this.pending = [];
    for (const resolve of due) resolve();
  }
}

async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

const fakes: FakeSsh[] = [];

afterEach(() => {
  for (const ssh of fakes.splice(0)) {
    expect(ssh.unexpected).toEqual([]);
    // INV-07 for node-shell: everything is a channel and nothing is retried, reads included
    for (const call of ssh.calls) expect({ path: call.path, attempt: call.attempt }).toEqual({ path: 'channel', attempt: 1 });
  }
});

function setup(rules: FakeSshRule[]) {
  const ssh = new FakeSsh(rules);
  fakes.push(ssh);
  const clock = new TestClock();
  const redactor = new Redactor([SECRET]);
  const factory = nodeShellFactory({ redactor, transport: ssh.transport(), clock });
  return { ssh, clock, redactor, shell: factory(AGENT) };
}

describe('nodeShell', () => {
  it('U-RT-N-01: runs exactly the given script on that node through a channel', async () => {
    const images = JSON.stringify({ images: [{ id: 'sha256:0a1b', repoTags: ['dockflow.invalid/web:1.4.2'], pinned: true }] });
    const { ssh, clock, shell } = setup([{ command: (c) => c === LIST_IMAGES, respond: { exitCode: 0, stdout: images } }]);
    const result = await shell.run(LIST_IMAGES, { guardS: 45 });
    expect(result).toEqual({ exitCode: 0, stdout: images, stderr: '' });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]).toMatchObject({ node: 'agent_1', command: LIST_IMAGES, path: 'channel', ended: true });
    expect(clock.sleeps).toEqual([45_000]);
    expect(shell.node).toBe(AGENT);
  });

  it('U-RT-N-01: a transport error is not retried, even for a read', async () => {
    const { ssh, shell } = setup([{ command: /crictl/, transportError: 'first-attempt', respond: { exitCode: 0 } }]);
    const failure = await shell.run(LIST_IMAGES, { guardS: 45 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KubeError);
    expect(failure).toMatchObject({ reason: 'Unreachable', node: 'agent_1' });
    expect(ssh.calls).toHaveLength(1);
  });

  it('returns a non-zero exit with redacted stderr instead of throwing', async () => {
    const { shell } = setup([
      { command: /crictl/, respond: { exitCode: 1, stderr: `sudo: a password is required\nlogin ${SECRET} refused\n` } },
    ]);
    const result = await shell.run(LIST_IMAGES, { guardS: 45 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('sudo: a password is required\nlogin *** refused\n');
  });

  it('U-RT-N-02: channel forwards stdin bytes unchanged, is never retried, and done resolves with the exit code', async () => {
    const { ssh, shell } = setup([{ command: (c) => c === IMPORT, respond: { exitCode: 0, stdout: 'unpacking dockflow.invalid/web:1.4.2...done\n' } }]);
    const channel = await shell.channel(IMPORT);
    const stdout: Buffer[] = [];
    channel.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    const gzipped = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x27]);
    channel.stdin.end(Buffer.from(gzipped));
    expect(await channel.done).toEqual({ exitCode: 0 });
    await settle();
    expect(Buffer.concat(stdout).toString()).toContain('done');
    expect(ssh.calls[0]).toMatchObject({ node: 'agent_1', command: IMPORT, path: 'channel', attempt: 1, ended: true });
    expect([...ssh.calls[0].stdin]).toEqual([...gzipped]);

    const flaky = setup([{ command: /import/, transportError: 'first-attempt', respond: { exitCode: 0 } }]);
    await expect(flaky.shell.channel(IMPORT)).rejects.toMatchObject({ reason: 'Unreachable' });
    expect(flaky.ssh.calls).toHaveLength(1);
  });

  it('pipes a local stream into run() stdin', async () => {
    const { ssh, shell } = setup([{ command: /cat/, respond: { exitCode: 0 } }]);
    await shell.run('umask 077 && cat > /var/lib/dockflow/helm/tmp/call.AbCdEfGhIj/values.json', {
      stdin: Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]),
      guardS: 30,
    });
    expect(Buffer.from(ssh.calls[0].stdin).toString()).toBe('{"a":1}');
    expect(ssh.calls[0].ended).toBe(true);
  });

  it('closes the channel and throws Timeout when its guard expires', async () => {
    const { ssh, clock, shell } = setup([{ command: /import/, hang: true, respond: { exitCode: 0 } }]);
    const pending = shell.run(IMPORT, { stdin: new Uint8Array([1]), guardS: 900 });
    await settle();
    expect(clock.sleeps).toEqual([900_000]);
    clock.expireAll();
    await expect(pending).rejects.toMatchObject({ reason: 'Timeout', node: 'agent_1' });
    expect(ssh.calls[0].closed).toBe(true);
  });

  it('arms no guard when guardS is null', async () => {
    const { clock, shell } = setup([{ command: /df/, respond: { exitCode: 0, stdout: '42\n' } }]);
    expect((await shell.run('df -k /var/lib/dockflow', { guardS: null })).stdout).toBe('42\n');
    expect(clock.sleeps).toEqual([]);
  });

  it('U-RT-N-03: recognises sudo refusals', () => {
    expect(isSudoRefusal('sudo: a password is required\n')).toBe(true);
    expect(isSudoRefusal('Sorry, user deploy is not allowed to run sudo on agent-1.\n')).toBe(true);
    expect(isSudoRefusal('sudo: a terminal is required to read the password\n')).toBe(true);
    expect(isSudoRefusal('ctr: content digest sha256:0a1b: not found\n')).toBe(false);
  });

  it('U-RT-N-05: stdout of a node command never reaches the output, --debug included', async () => {
    const { shell } = setup([{ command: /crictl/, respond: { exitCode: 0, stdout: `{"auth":"${SECRET}","marker":"stdout-only"}` } }]);
    const writes: string[] = [];
    const capture = (chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    };
    const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(capture);
    setVerbose(true);
    let stdout: string;
    try {
      stdout = (await shell.run(LIST_IMAGES, { guardS: 45 })).stdout;
    } finally {
      setVerbose(false);
      delete process.env.VERBOSE;
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
    expect(stdout).toContain(SECRET);
    const printed = writes.join('');
    expect(printed).toContain('node command on agent_1: exit 0');
    expect(printed).not.toContain('stdout-only');
    expect(printed).not.toContain(SECRET);
  });

  it('nodeShell binds one node; the factory hands out one shell per node', () => {
    const ssh = new FakeSsh([]);
    fakes.push(ssh);
    const server = nodeRef('server_1', 'manager');
    expect(nodeShell(server, { redactor: new Redactor(), transport: ssh.transport() }).node).toBe(server);
    const factory = nodeShellFactory({ redactor: new Redactor(), transport: ssh.transport() });
    expect(factory(AGENT).node.name).toBe('agent_1');
    expect(factory(server).node.name).toBe('server_1');
  });
});
