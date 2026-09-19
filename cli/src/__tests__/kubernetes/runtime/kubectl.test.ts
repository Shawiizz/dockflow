import { afterEach, describe, expect, it, spyOn, test } from 'bun:test';
import { Duplex, PassThrough } from 'stream';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import type { Clock, SshChannel, SshTransport } from '../../../services/orchestrator/kubernetes/deps';
import type { K8sDistribution } from '../../../services/orchestrator/kubernetes/distribution';
import { classifyKubectlFailure, KubeError, NO_EXIT_CODE } from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  applyCall,
  createCall,
  createKubeExecutor,
  deleteCall,
  getJsonCall,
  kubectlCommand,
  parseNameList,
  type RawSshChannel,
  replaceCall,
  toSshChannel,
} from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { setVerbose } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { SSHExitStatusError } from '../../../utils/ssh';
import { FakeSsh, type FakeSshRule } from '../fakes/fake-ssh';

const KUBECTL = '/usr/local/bin/k3s kubectl';
const PREFIX = `${KUBECTL} --kubeconfig=/var/lib/dockflow/kube/config`;
const NS = 'dockflow-shop-production';
const SECRET = 'db-password-4242';

// only kubectlCommand is read by the executor
const distribution = { kubectlCommand: KUBECTL } as K8sDistribution;

function nodeRef(name: string): ClusterNodeRef {
  return {
    name,
    role: 'manager',
    host: '192.0.2.10',
    privateHost: '10.0.0.10',
    connection: { host: '192.0.2.10', port: 22, user: 'deploy', privateKey: 'test-only-key' },
  };
}

/** sleeps resolve only when expired by the test or aborted by their caller */
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

  /** every pending deadline passes */
  expireAll(): void {
    const due = this.pending;
    this.pending = [];
    for (const resolve of due) resolve();
  }
}

async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

const MUTATING_VERBS = new Set(['apply', 'create', 'replace', 'delete', 'scale', 'patch', 'label', 'annotate', 'rollout', 'cordon', 'drain']);

function kubectlVerb(command: string): string | null {
  if (!command.startsWith(KUBECTL)) return null;
  const tokens = command.slice(KUBECTL.length).trim().split(' ');
  let at = 0;
  while (tokens[at]?.startsWith('--')) at++;
  if (tokens[at] === '-n') at += 2;
  return tokens[at]?.replace(/^'|'$/g, '') ?? null;
}

const fakes: FakeSsh[] = [];

afterEach(() => {
  for (const ssh of fakes.splice(0)) {
    expect(ssh.unexpected).toEqual([]);
    for (const call of ssh.calls) {
      // INV-07: mutating calls went through a channel; only exec calls are ever retried
      const verb = kubectlVerb(call.command);
      if (verb !== null && MUTATING_VERBS.has(verb)) expect(call.path).toBe('channel');
      if (call.attempt > 1) expect(call.path).toBe('exec');
      // INV-10
      if (call.command.includes('kubectl')) expect(call.command).toContain('--kubeconfig=/var/lib/dockflow/kube/config');
    }
  }
});

function setup(rules: FakeSshRule[], secrets: string[] = []) {
  const ssh = new FakeSsh(rules);
  fakes.push(ssh);
  const clock = new TestClock();
  const redactor = new Redactor(secrets);
  const kubectl = createKubeExecutor(nodeRef('server_1'), { distribution, redactor, transport: ssh.transport(), clock });
  return { ssh, clock, kubectl };
}

const LIST = (items: unknown[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items });
const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

const MANIFESTS = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config-0a1b2c3d
  namespace: ${NS}
data:
  APP_MODE: production
`;

describe('command shape', () => {
  it('U-RT-K-01: getJson builds the exact command with every argument quoted', async () => {
    const { ssh, kubectl } = setup([{ command: /get/, respond: { exitCode: 0, stdout: LIST([]) } }]);
    await kubectl.getJson(['deployments.apps'], { namespace: NS });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0].command).toBe(
      `${PREFIX} --request-timeout=30s -n 'dockflow-shop-production' 'get' 'deployments.apps' '-o' 'json'`,
    );
    expect(ssh.calls[0].path).toBe('exec');
    expect(ssh.calls[0].node).toBe('server_1');
  });

  it("U-RT-K-02: arguments with ', $(id), spaces and newlines are single-quote escaped", () => {
    const command = kubectlCommand(distribution, {
      args: ['exec', "it's", '$(id)', 'two words', 'line one\nline two'],
      namespace: NS,
    });
    expect(command).toBe(
      `${PREFIX} --request-timeout=30s -n '${NS}' 'exec' 'it'\\''s' '$(id)' 'two words' 'line one\nline two'`,
    );
  });

  test.if(Bun.which('sh') !== null)('U-RT-K-02: the remote shell receives every argument literally (sh round trip)', () => {
    const args = ["it's", '$(id)', 'two words', 'line one\nline two', '`uname`', '"double" \\ back'];
    // printf repeats its format for each operand: --kubeconfig=..., then the arguments
    const echo = { kubectlCommand: "printf '%s\\0'" } as K8sDistribution;
    const command = kubectlCommand(echo, { args, requestTimeoutS: null });
    const run = Bun.spawnSync(['sh', '-c', command]);
    expect(run.exitCode).toBe(0);
    const printed = run.stdout.toString().split('\0');
    expect(printed[0]).toBe('--kubeconfig=/var/lib/dockflow/kube/config');
    expect(printed.slice(1, 1 + args.length)).toEqual(args);
  });

  it('U-RT-K-14: command() gives the full string for an interactive session, without a request timeout', () => {
    const { kubectl } = setup([]);
    expect(kubectl.command(['exec', '-it', 'web-6d4cf56db6-x7k2p', '-c', 'web', '--', 'sh'], NS)).toBe(
      `${PREFIX} -n '${NS}' 'exec' '-it' 'web-6d4cf56db6-x7k2p' '-c' 'web' '--' 'sh'`,
    );
    expect(kubectl.command(['version', '-o', 'json'])).toBe(`${PREFIX} 'version' '-o' 'json'`);
  });

  it('U-RT-K-17: the exported builders produce exactly the command the executor sends', async () => {
    const lease = `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: lock-${NS}
  namespace: dockflow-system
  resourceVersion: "42"
`;
    const { ssh, kubectl } = setup([
      { command: / 'get' /, respond: { exitCode: 0, stdout: LIST([]) } },
      { command: / 'apply' /, respond: { exitCode: 0 } },
      { command: / 'create' /, respond: { exitCode: 0, stdout: '{}' } },
      { command: / 'replace' /, respond: { exitCode: 0, stdout: '{}' } },
      { command: / 'delete' /, respond: { exitCode: 0 } },
    ]);
    await kubectl.getJson(['pods'], { namespace: NS, selector: 'a=b' });
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: true });
    await kubectl.create(lease, { namespace: 'dockflow-system', json: true });
    await kubectl.replace(lease, { namespace: 'dockflow-system' });
    await kubectl.delete(['pods/web-1'], { namespace: NS, wait: false, ignoreNotFound: true });
    expect(ssh.calls.map((call) => call.command)).toEqual([
      kubectlCommand(distribution, getJsonCall(['pods'], { namespace: NS, selector: 'a=b' })),
      kubectlCommand(distribution, applyCall(MANIFESTS, { namespace: NS, dryRun: true })),
      kubectlCommand(distribution, createCall(lease, { namespace: 'dockflow-system', json: true })),
      kubectlCommand(distribution, replaceCall(lease, { namespace: 'dockflow-system' })),
      kubectlCommand(distribution, deleteCall(['pods/web-1'], { namespace: NS, wait: false, ignoreNotFound: true })),
    ]);
    ssh.assertAllRulesUsed();
  });
});

describe('apply', () => {
  it('U-RT-K-03: goes through a channel with the manifests on stdin, 120 s request timeout, 150 s guard', async () => {
    const { ssh, clock, kubectl } = setup([{ command: / 'apply' /, respond: { exitCode: 0, stdout: 'configmap/web serverside-applied' } }]);
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false });
    const [call] = ssh.calls;
    expect(call.path).toBe('channel');
    expect(decode(call.stdin)).toBe(MANIFESTS);
    expect(call.ended).toBe(true);
    expect(call.command).toBe(
      `${PREFIX} --request-timeout=120s -n '${NS}' 'apply' '--server-side' '--field-manager=dockflow' '--force-conflicts' '-f' '-'`,
    );
    expect(clock.sleeps).toEqual([150_000]);
  });

  it('U-RT-K-04: a dry run adds --dry-run=server', async () => {
    const { ssh, kubectl } = setup([{ command: / 'apply' /, respond: { exitCode: 0 } }]);
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: true });
    expect(ssh.calls[0].command).toEndWith(
      `'apply' '--server-side' '--field-manager=dockflow' '--force-conflicts' '--dry-run=server' '-f' '-'`,
    );
    expect(ssh.calls[0].path).toBe('channel');
  });

  it('U-RT-K-18: accepts the two state field managers, defaults to dockflow and refuses any other before SSH', async () => {
    const { ssh, kubectl } = setup([{ command: / 'apply' /, respond: { exitCode: 0 } }]);
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false, fieldManager: 'dockflow-release-state' });
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false, fieldManager: 'dockflow-accessories-state' });
    await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false });
    expect(ssh.calls.map((call) => call.command.split(' ').find((token) => token.includes('--field-manager=')))).toEqual([
      "'--field-manager=dockflow-release-state'",
      "'--field-manager=dockflow-accessories-state'",
      "'--field-manager=dockflow'",
    ]);
    await expect(kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false, fieldManager: '' })).rejects.toThrow(/Field manager/);
    await expect(kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false, fieldManager: 'kubectl-client-side-apply' })).rejects.toThrow(
      /Field manager/,
    );
    // a hand-built apply through run() is held to the same managers
    await expect(
      kubectl.run({ args: ['apply', '--server-side', '--field-manager=other', '--force-conflicts', '-f', '-'], stdin: MANIFESTS, mutating: true }),
    ).rejects.toThrow(/field managers/);
    expect(ssh.calls).toHaveLength(3);
  });

  it('refuses an object of another namespace before any SSH work', async () => {
    const { ssh, kubectl } = setup([]);
    const foreign = MANIFESTS.replace(`namespace: ${NS}`, 'namespace: kube-system');
    await expect(kubectl.apply(foreign, { namespace: NS, dryRun: false })).rejects.toThrow(/namespace kube-system/);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('transport', () => {
  it('U-RT-K-05: a mutating call is not retried after a transport error', async () => {
    const { ssh, kubectl } = setup([{ command: / 'scale' /, transportError: 'first-attempt', respond: { exitCode: 0 } }]);
    const failure = kubectl.run({ args: ['scale', 'deployments.apps/web', '--replicas=2'], namespace: NS, mutating: true });
    await expect(failure).rejects.toBeInstanceOf(KubeError);
    await expect(failure).rejects.toMatchObject({ reason: 'Unreachable', node: 'server_1' });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]).toMatchObject({ path: 'channel', attempt: 1 });
  });

  it('U-RT-K-06: a read survives one transport error through the exec retry', async () => {
    const { ssh, kubectl } = setup([
      { command: / 'get' /, transportError: 'first-attempt', respond: { exitCode: 0, stdout: LIST([{ metadata: { name: 'web' } }]) } },
    ]);
    const items = await kubectl.getJson<{ metadata: { name: string } }>(['deployments.apps'], { namespace: NS });
    expect(items.map((item) => item.metadata.name)).toEqual(['web']);
    expect(ssh.calls.map((call) => [call.path, call.attempt])).toEqual([
      ['exec', 1],
      ['exec', 2],
    ]);
  });

  it('U-RT-K-06: a read whose retry fails too is Unreachable', async () => {
    const { kubectl } = setup([{ command: / 'get' /, transportError: 'always', respond: { exitCode: 0 } }]);
    await expect(kubectl.getJson(['pods'], { namespace: NS })).rejects.toMatchObject({ reason: 'Unreachable' });
  });

  it('sends a read that carries stdin through a channel', async () => {
    const { ssh, kubectl } = setup([{ command: / 'create' /, respond: { exitCode: 0 } }]);
    await kubectl.run({ args: ['create', '--dry-run=client', '-f', '-'], stdin: MANIFESTS, mutating: false });
    expect(ssh.calls[0].path).toBe('channel');
  });

  it('U-RT-K-07: requestTimeoutS null adds no --request-timeout and arms no guard', async () => {
    const { ssh, clock, kubectl } = setup([
      { command: / 'logs' /, path: 'stream', respond: { exitCode: 0, stdout: 'ready\n' } },
    ]);
    const lines: string[] = [];
    const exitCode = await kubectl.stream(
      { args: ['logs', '-f', 'web-6d4cf56db6-x7k2p'], namespace: NS, requestTimeoutS: null },
      { stdout: (chunk) => lines.push(chunk), stderr: () => {} },
    );
    expect(exitCode).toBe(0);
    expect(lines.join('')).toBe('ready\n');
    expect(ssh.calls[0].command).toBe(`${PREFIX} -n '${NS}' 'logs' '-f' 'web-6d4cf56db6-x7k2p'`);
    expect(ssh.calls[0].path).toBe('stream');
    expect(clock.sleeps).toEqual([]);
  });

  it('U-RT-K-08: a hanging read times out after requestTimeoutS + 15 s and its call is closed', async () => {
    const { ssh, clock, kubectl } = setup([{ command: / 'get' /, hang: true, respond: { exitCode: 0 } }]);
    const pending = kubectl.getJson(['pods'], { namespace: NS });
    await settle();
    expect(clock.sleeps).toEqual([45_000]);
    clock.expireAll();
    await expect(pending).rejects.toMatchObject({ reason: 'Timeout', node: 'server_1' });
    await settle();
    expect(ssh.calls[0].closed).toBe(true);
  });

  it('U-RT-K-08: a hanging mutating call times out and its channel is closed', async () => {
    const { ssh, clock, kubectl } = setup([{ command: / 'scale' /, hang: true, respond: { exitCode: 0 } }]);
    const pending = kubectl.run({ args: ['scale', 'deployments.apps/web', '--replicas=0'], namespace: NS, mutating: true });
    await settle();
    expect(clock.sleeps).toEqual([45_000]);
    clock.expireAll();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).reason).toBe('Timeout');
    expect((error as KubeError).message).toBe('kubectl scale did not finish within 45s on server_1');
    expect(ssh.calls[0]).toMatchObject({ path: 'channel', closed: true });
  });

  it('U-RT-K-13: a stream handler that throws never escapes the data listener; stream rejects after the channel closes', async () => {
    const { ssh, kubectl } = setup([
      {
        command: / 'logs' /,
        respond: {
          exitCode: 0,
          chunks: [
            { stream: 'stdout', data: 'first\n' },
            { stream: 'stdout', data: 'second\n' },
          ],
        },
      },
    ]);
    const seen: string[] = [];
    const boom = new Error('handler failed');
    const result = kubectl.stream(
      { args: ['logs', '-f', 'web-1'], namespace: NS, requestTimeoutS: null },
      {
        stdout: (chunk) => {
          seen.push(chunk);
          throw boom;
        },
        stderr: () => {},
      },
    );
    await expect(result).rejects.toBe(boom);
    expect(seen).toEqual(['first\n']);
    expect(ssh.calls[0].closed).toBe(true);
  });

  it('delivers stream stderr redacted, one line at a time, even when a value is split across chunks', async () => {
    const { kubectl } = setup(
      [
        {
          command: / 'logs' /,
          respond: {
            exitCode: 1,
            chunks: [
              { stream: 'stderr', data: `error: token db-pass` },
              { stream: 'stderr', data: `word-4242 rejected\nsecond line` },
            ],
          },
        },
      ],
      [SECRET],
    );
    const errors: string[] = [];
    const exitCode = await kubectl.stream(
      { args: ['logs', 'web-1'], namespace: NS },
      { stdout: () => {}, stderr: (chunk) => errors.push(chunk) },
    );
    expect(exitCode).toBe(1);
    expect(errors).toEqual(['error: token *** rejected\n', 'second line']);
  });
});

describe('reads', () => {
  it('U-RT-K-09: a List yields its items, a single object a one-element array', async () => {
    const { kubectl } = setup([
      { command: / 'deployments.apps' '-o'/, respond: { exitCode: 0, stdout: LIST([{ kind: 'Deployment' }, { kind: 'Deployment' }]) } },
      { command: / 'namespaces' /, respond: { exitCode: 0, stdout: JSON.stringify({ kind: 'Namespace', metadata: { name: NS } }) } },
    ]);
    expect(await kubectl.getJson(['deployments.apps'], { namespace: NS })).toHaveLength(2);
    expect(await kubectl.getJson(['namespaces'], { name: NS })).toEqual([{ kind: 'Namespace', metadata: { name: NS } }]);
  });

  it('U-RT-K-10: NotFound with allowNotFound is an empty array, without it a KubeError', async () => {
    const notFound = { exitCode: 1, stderr: `Error from server (NotFound): namespaces "${NS}" not found\n` };
    const { kubectl } = setup([{ command: / 'namespaces' /, respond: notFound }]);
    expect(await kubectl.getJson(['namespaces'], { name: NS, allowNotFound: true })).toEqual([]);
    await expect(kubectl.getJson(['namespaces'], { name: NS })).rejects.toMatchObject({ reason: 'NotFound', exitCode: 1 });
  });

  it('U-RT-K-19: names fetch several objects in one call; ignoreNotFound keeps only the existing ones', async () => {
    const { ssh, kubectl } = setup([
      { command: /'a' 'b'/, respond: { exitCode: 0, stdout: LIST([{ metadata: { name: 'a' } }]) } },
      { command: /'--ignore-not-found'/, respond: { exitCode: 0, stdout: '' } },
    ]);
    expect(await kubectl.getJson(['secrets'], { names: ['a', 'b'], namespace: NS })).toHaveLength(1);
    expect(ssh.calls[0].command).toEndWith(`-n '${NS}' 'get' 'secrets' 'a' 'b' '-o' 'json'`);
    expect(await kubectl.getJson(['secrets'], { name: 'missing', namespace: NS, ignoreNotFound: true })).toEqual([]);
    expect(ssh.calls[1].command).toEndWith(`'get' 'secrets' 'missing' '--ignore-not-found' '-o' 'json'`);
    expect(() => getJsonCall(['secrets'], { names: ['a'], selector: 'x=y' })).toThrow(/names or a selector/);
    await expect(kubectl.getJson(['secrets'], { names: ['a'], selector: 'x=y' })).rejects.toThrow(/names or a selector/);
    expect(ssh.calls).toHaveLength(2);
  });

  it('U-RT-K-20: -o name listings go through run() for the allowed resources only', async () => {
    const { ssh, kubectl } = setup([
      { command: /'-o' 'name'/, respond: { exitCode: 0, stdout: 'secret/web-env-0a1b2c3d\nsecret/web-env-4e5f6a7b\n\n' } },
    ]);
    const selector = 'app.kubernetes.io/managed-by=dockflow,dockflow.shawiizz.dev/hashed=true';
    const result = await kubectl.run({ args: ['get', 'secrets', '-l', selector, '-o', 'name'], namespace: NS, mutating: false });
    expect(ssh.calls[0].command).toBe(`${PREFIX} --request-timeout=30s -n '${NS}' 'get' 'secrets' '-l' '${selector}' '-o' 'name'`);
    expect(parseNameList(result.stdout)).toEqual(['secret/web-env-0a1b2c3d', 'secret/web-env-4e5f6a7b']);
    await kubectl.run({ args: ['get', 'secrets,configmaps', '-l', selector, '-o', 'name'], namespace: NS, mutating: false });
    await kubectl.run({ args: ['api-resources', '-o', 'name'], mutating: false });
    await expect(kubectl.run({ args: ['get', 'pods', '-o', 'name'], namespace: NS, mutating: false })).rejects.toThrow(/-o name/);
    await expect(kubectl.run({ args: ['get', 'services', '-oname'], namespace: NS, mutating: false })).rejects.toThrow(/-o name/);
    expect(ssh.calls).toHaveLength(3);
  });

  it('refuses jsonpath and custom columns, and go-templates outside the release listing', async () => {
    const { ssh, kubectl } = setup([{ command: /go-template/, respond: { exitCode: 0, stdout: '' } }]);
    await expect(kubectl.run({ args: ['get', 'pods', '-o', 'jsonpath={.items}'], mutating: false })).rejects.toThrow(/jsonpath/);
    await expect(kubectl.run({ args: ['get', 'pods', '-o=custom-columns=N:.metadata.name'], mutating: false })).rejects.toThrow(
      /custom-columns/,
    );
    await expect(kubectl.run({ args: ['get', 'configmaps', '-o', 'go-template={{.}}'], mutating: false })).rejects.toThrow(
      /go-template/,
    );
    await kubectl.run({ args: ['get', 'secrets', '-l', 'x=y', '-o', 'go-template={{range .items}}{{.metadata.name}}{{end}}'], namespace: NS, mutating: false });
    // what follows -- is the container's command line, not kubectl's output flag
    expect(() => kubectlCommand(distribution, { args: ['exec', 'web-1', '--', 'ls', '-o', 'name'] })).not.toThrow();
    expect(ssh.calls).toHaveLength(1);
  });

  it('reads an empty -o json answer as no items: a cut connection rejects in the transport instead', async () => {
    const { kubectl } = setup([{ command: / 'get' /, respond: { exitCode: 0, stdout: '' } }]);
    expect(await kubectl.getJson(['pods'], { namespace: NS })).toEqual([]);
  });

  it('U-RT-K-15: stderr is redacted in the result and in the thrown KubeError', async () => {
    const stderr = `Error from server (Invalid): Secret "web-env" is invalid: data[DB_PASSWORD]: value ${SECRET} and ${Buffer.from(SECRET).toString('base64')} rejected\n`;
    const { kubectl } = setup([{ command: / 'apply' /, respond: { exitCode: 1, stderr } }], [SECRET]);
    const error = await kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeError);
    const kubeError = error as KubeError;
    expect(kubeError.reason).toBe('Invalid');
    expect(kubeError.stderr).toContain('value *** and *** rejected');
    expect(kubeError.stderr).not.toContain(SECRET);
    expect(kubeError.message).not.toContain(SECRET);

    const allowed = await kubectl.run({
      args: ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'],
      stdin: MANIFESTS,
      namespace: NS,
      mutating: true,
      allowFailure: true,
    });
    expect(allowed.stderr).not.toContain(SECRET);
    expect(allowed.stderr).toContain('***');
  });

  it('U-RT-K-16: allowFailure resolves a non-zero exit instead of throwing', async () => {
    const { kubectl } = setup([{ command: / 'wait' /, respond: { exitCode: 1, stderr: 'error: timed out waiting for the condition\n' } }]);
    const result = await kubectl.run({
      args: ['wait', '--for=delete', 'pods', '-l', 'a=b', '--timeout=120s'],
      namespace: NS,
      mutating: false,
      requestTimeoutS: null,
      guardS: 150,
      allowFailure: true,
    });
    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'error: timed out waiting for the condition\n' });
  });

  it('U-RT-K-23: a secret in stdout is returned to the caller and never printed, --debug included', async () => {
    const payload = JSON.stringify({ kind: 'Secret', metadata: { name: 'db-credentials' }, data: { password: Buffer.from(SECRET).toString('base64') } });
    const { kubectl } = setup([{ command: / 'secrets' /, respond: { exitCode: 0, stdout: payload } }], [SECRET]);
    const writes: string[] = [];
    const capture = (chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    };
    const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(capture);
    setVerbose(true);
    let items: unknown[];
    try {
      items = await kubectl.getJson(['secrets'], { name: 'db-credentials', namespace: NS });
    } finally {
      setVerbose(false);
      delete process.env.VERBOSE;
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
    expect(JSON.stringify(items)).toBe(JSON.stringify([JSON.parse(payload)]));
    const printed = writes.join('');
    expect(printed).toContain('kubectl get secrets db-credentials -o json on server_1: exit 0');
    expect(printed).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(printed).not.toContain('db-credentials"');
    expect(printed).not.toContain(SECRET);
  });
});

describe('create, replace and delete', () => {
  const LEASE = `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: lock-${NS}
  namespace: dockflow-system
`;

  it('U-RT-K-11: AlreadyExists is { result: "exists" }', async () => {
    const { kubectl } = setup([
      {
        command: / 'create' /,
        respond: {
          exitCode: 1,
          stderr: `Error from server (AlreadyExists): error when creating "STDIN": leases.coordination.k8s.io "lock-${NS}" already exists\n`,
        },
      },
    ]);
    expect(await kubectl.create(LEASE, { namespace: 'dockflow-system' })).toEqual({ result: 'exists' });
  });

  it('U-RT-K-24: create -o json returns the created object; replace needs a resourceVersion and classifies Conflict', async () => {
    const created = { kind: 'Lease', metadata: { name: `lock-${NS}`, uid: '00000000-0000-4000-8000-000000000001', resourceVersion: '17' } };
    const { ssh, kubectl } = setup([
      { command: / 'create' /, respond: { exitCode: 0, stdout: JSON.stringify(created) } },
      {
        command: / 'replace' /,
        respond: {
          exitCode: 1,
          stderr: `Error from server (Conflict): error when replacing "STDIN": Operation cannot be fulfilled on leases.coordination.k8s.io "lock-${NS}": the object has been modified; please apply your changes to the latest version and try again\n`,
        },
      },
    ]);
    const result = await kubectl.create<typeof created>(LEASE, { namespace: 'dockflow-system', json: true });
    expect(result).toEqual({ result: 'created', object: created });
    expect(ssh.calls[0].command).toEndWith(`-n 'dockflow-system' 'create' '-f' '-' '-o' 'json'`);
    expect(decode(ssh.calls[0].stdin)).toBe(LEASE);

    await expect(kubectl.replace(LEASE, { namespace: 'dockflow-system' })).rejects.toThrow(/resourceVersion/);
    expect(ssh.calls).toHaveLength(1);

    const withVersion = LEASE.replace('  namespace: dockflow-system\n', '  namespace: dockflow-system\n  resourceVersion: "17"\n');
    await expect(kubectl.replace(withVersion, { namespace: 'dockflow-system' })).rejects.toMatchObject({ reason: 'Conflict' });
    expect(ssh.calls[1].command).toEndWith(`'replace' '-f' '-' '-o' 'json'`);
    expect(ssh.calls.map((call) => call.path)).toEqual(['channel', 'channel']);
  });

  it('create without json returns no object', async () => {
    const { kubectl } = setup([{ command: / 'create' /, respond: { exitCode: 0, stdout: `lease.coordination.k8s.io/lock-${NS} created` } }]);
    expect(await kubectl.create(LEASE)).toEqual({ result: 'created', object: null });
  });

  it('U-RT-K-12: delete spells its flags exactly and waits without a request timeout', async () => {
    const { ssh, clock, kubectl } = setup([{ command: / 'delete' /, respond: { exitCode: 0 } }]);
    await kubectl.delete(['deployments.apps/web'], { namespace: NS, wait: true, timeoutS: 120, ignoreNotFound: true });
    expect(ssh.calls[0].command).toBe(
      `${PREFIX} -n '${NS}' 'delete' 'deployments.apps/web' '--ignore-not-found' '--wait=true' '--timeout=120s'`,
    );
    expect(clock.sleeps).toEqual([150_000]);
    await kubectl.delete(['deployments.apps/web', 'statefulsets.apps/db'], {
      namespace: NS,
      wait: true,
      timeoutS: 180,
      ignoreNotFound: true,
      cascade: 'foreground',
    });
    expect(ssh.calls[1].command).toEndWith(
      `'delete' 'deployments.apps/web' 'statefulsets.apps/db' '--ignore-not-found' '--cascade=foreground' '--wait=true' '--timeout=180s'`,
    );
    await kubectl.delete(['secrets/web-env-0a1b2c3d'], { namespace: NS, wait: false, ignoreNotFound: false });
    expect(ssh.calls[2].command).toBe(`${PREFIX} --request-timeout=30s -n '${NS}' 'delete' 'secrets/web-env-0a1b2c3d' '--wait=false'`);
    expect(() => deleteCall([], { wait: false, ignoreNotFound: true })).toThrow(/at least one target/);
  });

  it('U-RT-K-21: a conditional delete --raw has no -n, sends DeleteOptions on stdin through a channel, and classifies Conflict', async () => {
    const body = JSON.stringify({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: '00000000-0000-4000-8000-000000000001', resourceVersion: '17' },
    });
    const uri = `/apis/coordination.k8s.io/v1/namespaces/dockflow-system/leases/lock-${NS}`;
    const { ssh, kubectl } = setup([
      {
        command: /--raw=/,
        respond: {
          exitCode: 1,
          stderr: `Error from server (Conflict): Operation cannot be fulfilled on leases.coordination.k8s.io "lock-${NS}": Precondition failed: UID in precondition: 00000000-0000-4000-8000-000000000001, UID in object meta: 00000000-0000-4000-8000-000000000002\n`,
        },
      },
    ]);
    const result = await kubectl.run({ args: ['delete', `--raw=${uri}`, '-f', '-'], stdin: body, mutating: true, allowFailure: true });
    expect(ssh.calls[0].command).toBe(`${PREFIX} --request-timeout=30s 'delete' '--raw=${uri}' '-f' '-'`);
    expect(ssh.calls[0].command).not.toContain(' -n ');
    expect(ssh.calls[0].path).toBe('channel');
    expect(decode(ssh.calls[0].stdin)).toBe(body);
    expect(result.exitCode).toBe(1);
    expect(classifyKubectlFailure(result.exitCode, result.stderr)).toBe('Conflict');
  });
});

describe('shell, channel and interactive', () => {
  it('U-RT-K-22: shell runs a script over one non-retried channel, returns redacted stderr and honours guardS', async () => {
    const { ssh, clock, kubectl } = setup(
      [
        { command: /gzip/, respond: { exitCode: 0, stdout: 'dumped', stderr: `warning: ${SECRET}\n` } },
        { command: /flaky/, transportError: 'first-attempt', respond: { exitCode: 0 } },
      ],
      [SECRET],
    );
    const script = `${kubectl.command(['exec', 'db-0', '--', 'pg_dump', 'shop'], NS)} | gzip > /var/tmp/dump.gz`;
    const result = await kubectl.shell({ script, guardS: 600 });
    expect(result).toEqual({ exitCode: 0, stdout: 'dumped', stderr: 'warning: ***\n' });
    expect(ssh.calls[0]).toMatchObject({ path: 'channel', command: script, attempt: 1, ended: true });
    expect(clock.sleeps).toEqual([600_000]);

    await expect(kubectl.shell({ script: 'flaky', guardS: null })).rejects.toMatchObject({ reason: 'Unreachable' });
    expect(ssh.calls.filter((call) => call.command === 'flaky')).toHaveLength(1);
  });

  it('U-RT-K-22: shell streams stdin, hands stdout to onStdout and redacted stderr lines to onStderr', async () => {
    const { ssh, kubectl } = setup(
      [
        {
          command: /tar/,
          respond: {
            exitCode: 0,
            chunks: [
              { stream: 'stdout', data: 'chunk-1' },
              { stream: 'stderr', data: `tar: ${SECRET}` },
              { stream: 'stderr', data: ' removed\n' },
              { stream: 'stdout', data: 'chunk-2' },
            ],
          },
        },
      ],
      [SECRET],
    );
    const out: string[] = [];
    const err: string[] = [];
    const result = await kubectl.shell({
      script: 'tar -xf - -C /var/tmp/restore',
      stdin: new Uint8Array([1, 2, 3]),
      guardS: null,
      onStdout: (chunk) => out.push(chunk.toString('utf8')),
      onStderr: (line) => err.push(line),
    });
    expect(out).toEqual(['chunk-1', 'chunk-2']);
    expect(err).toEqual(['tar: *** removed\n']);
    expect(result.stdout).toBe('');
    expect([...ssh.calls[0].stdin]).toEqual([1, 2, 3]);
  });

  it('U-RT-K-22: shell times out on its guard and closes the channel', async () => {
    const { ssh, clock, kubectl } = setup([{ command: /sleep/, hang: true, respond: { exitCode: 0 } }]);
    const pending = kubectl.shell({ script: 'sleep 3600', guardS: 30 });
    await settle();
    clock.expireAll();
    await expect(pending).rejects.toMatchObject({ reason: 'Timeout' });
    expect(ssh.calls[0].closed).toBe(true);
  });

  it('U-RT-K-22: channel forwards stdin bytes unchanged and done resolves with the exit code', async () => {
    const { ssh, kubectl } = setup([{ command: /'cp'|tar/, respond: { exitCode: 3, stdout: 'out' } }]);
    const script = `${kubectl.command(['exec', '-i', 'web-1', '--', 'tar', '-xf', '-', '-C', '/data'], NS)}`;
    const channel = await kubectl.channel(script);
    const received: Buffer[] = [];
    channel.stdout.on('data', (chunk: Buffer) => received.push(chunk));
    const bytes = new Uint8Array([0, 255, 10, 13, 39]);
    channel.stdin.end(Buffer.from(bytes));
    expect(await channel.done).toEqual({ exitCode: 3 });
    await settle();
    expect(Buffer.concat(received).toString()).toBe('out');
    expect([...ssh.calls[0].stdin]).toEqual([...bytes]);
    expect(ssh.calls[0]).toMatchObject({ path: 'channel', attempt: 1 });
  });

  it('U-RT-K-22: channel and interactive are never retried', async () => {
    const { ssh, kubectl } = setup([
      { command: /channel-script/, transportError: 'first-attempt', respond: { exitCode: 0 } },
      { command: /interactive-script/, transportError: 'first-attempt', respond: { exitCode: 0 } },
    ]);
    await expect(kubectl.channel('channel-script')).rejects.toMatchObject({ reason: 'Unreachable' });
    await expect(kubectl.interactive('interactive-script')).rejects.toMatchObject({ reason: 'Unreachable' });
    expect(ssh.calls.map((call) => [call.path, call.attempt])).toEqual([
      ['channel', 1],
      ['interactive', 1],
    ]);
  });

  it('U-RT-K-22: interactive opens a PTY session through the transport and resolves with the remote exit code', async () => {
    const { ssh, kubectl } = setup([{ command: /'-it'/, path: 'interactive', respond: { exitCode: 130 } }]);
    const script = kubectl.command(['exec', '-it', 'web-1', '--', 'sh'], NS);
    expect(await kubectl.interactive(script)).toBe(130);
    expect(ssh.calls[0]).toMatchObject({ path: 'interactive', command: script, node: 'server_1' });
  });
});

/** an unbuffered utils/ssh channel handle; close() gets no exit status back, as with ssh2 */
function rawChannel() {
  let resolveDone: (value: { exitCode: number }) => void = () => {};
  let rejectDone: (error: unknown) => void = () => {};
  const done = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const written: Buffer[] = [];
  let closed = false;
  const stream = Object.assign(
    new Duplex({
      read() {},
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        written.push(Buffer.from(chunk));
        callback();
      },
    }),
    {
      stderr: new PassThrough(),
      close: () => {
        closed = true;
        rejectDone(new SSHExitStatusError());
      },
    },
  );
  const raw: RawSshChannel = { stream, done };
  return {
    raw,
    written: () => Buffer.concat(written).toString('utf8'),
    isClosed: () => closed,
    exit: (exitCode: number) => resolveDone({ exitCode }),
    loseConnection: () => rejectDone(new SSHExitStatusError()),
  };
}

function executorOver(channel: SshChannel) {
  const opened: string[] = [];
  const unused = () => Promise.reject(new Error('not used by this test'));
  const transport: SshTransport = {
    exec: unused,
    channel: async (_node, command) => {
      opened.push(command);
      return channel;
    },
    stream: unused,
    interactive: unused,
  };
  const kubectl = createKubeExecutor(nodeRef('server_1'), {
    distribution,
    redactor: new Redactor([]),
    transport,
    clock: new TestClock(),
  });
  return { kubectl, opened };
}

describe('SSH transport adapter', () => {
  it('exposes the unbuffered channel as is and passes its exit status through', async () => {
    const fake = rawChannel();
    const channel = toSshChannel(fake.raw);
    expect(channel.stdin).toBe(fake.raw.stream);
    expect(channel.stdout).toBe(fake.raw.stream);
    expect(channel.stderr).toBe(fake.raw.stream.stderr);
    fake.exit(3);
    expect(await channel.done).toEqual({ exitCode: 3 });
  });

  it('reads a channel closed without an exit status as a lost connection: Unreachable, never retried', async () => {
    const fake = rawChannel();
    const { kubectl, opened } = executorOver(toSshChannel(fake.raw));
    const pending = kubectl.apply(MANIFESTS, { namespace: NS, dryRun: false });
    await settle();
    expect(fake.written()).toBe(MANIFESTS);
    fake.loseConnection();
    await expect(pending).rejects.toMatchObject({ reason: 'Unreachable', node: 'server_1', exitCode: NO_EXIT_CODE });
    expect(opened).toHaveLength(1);

    const cut = rawChannel();
    const raw = await executorOver(toSshChannel(cut.raw)).kubectl.channel('tar -xf - -C /data');
    cut.loseConnection();
    await expect(raw.done).rejects.toMatchObject({ reason: 'Unreachable' });
  });

  it('owes no exit status after close(): done resolves with NO_EXIT_CODE and a failing handler surfaces its own error', async () => {
    const direct = rawChannel();
    const channel = toSshChannel(direct.raw);
    channel.close();
    expect(direct.isClosed()).toBe(true);
    expect(await channel.done).toEqual({ exitCode: NO_EXIT_CODE });

    const fake = rawChannel();
    const { kubectl } = executorOver(toSshChannel(fake.raw));
    const pending = kubectl.shell({
      script: 'tar -cf - /data',
      guardS: null,
      onStdout: () => {
        throw new Error('local disk full');
      },
    });
    await settle();
    fake.raw.stream.push('chunk');
    await expect(pending).rejects.toThrow('local disk full');
    expect(fake.isClosed()).toBe(true);
  });
});
