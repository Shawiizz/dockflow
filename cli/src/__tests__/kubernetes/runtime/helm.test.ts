import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  createHelmExecutor,
  HELM_ENV_PREFIX,
  helmCommand,
  helmGuardS,
  helmPendingStaleS,
} from '../../../services/orchestrator/kubernetes/runtime/helm';
import { setVerbose } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeSsh, type FakeSshRule } from '../fakes/fake-ssh';

const PREFIX =
  'env HELM_CACHE_HOME=/var/lib/dockflow/helm/cache HELM_CONFIG_HOME=/var/lib/dockflow/helm/config HELM_DATA_HOME=/var/lib/dockflow/helm/data /usr/local/lib/dockflow/bin/helm --kubeconfig=/var/lib/dockflow/kube/config';
const ENV_ONLY =
  'env HELM_CACHE_HOME=/var/lib/dockflow/helm/cache HELM_CONFIG_HOME=/var/lib/dockflow/helm/config HELM_DATA_HOME=/var/lib/dockflow/helm/data';
const NS = 'dockflow-shop-production';
const TMP = '/var/lib/dockflow/helm/tmp/call.AbCdEfGhIj';
const PASSWORD = 'chart-registry-pass-77';
const TGZ = '/var/lib/dockflow/helm/charts/sha256-cd7254ea853da73bdb88edc896f079b88d43ffa0bfe699fdbf21081361eac365.tgz';

function nodeRef(name: string): ClusterNodeRef {
  return {
    name,
    role: 'manager',
    host: '192.0.2.10',
    privateHost: '10.0.0.10',
    connection: { host: '192.0.2.10', port: 22, user: 'deploy', privateKey: 'test-only-key' },
  };
}

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

const MUTATING_HELM = new Set(['upgrade', 'install', 'rollback', 'uninstall']);

function helmVerb(command: string): string | undefined {
  const rest = command.slice(command.indexOf('--kubeconfig=')).split(' ');
  return rest[1]?.replace(/^'|'$/g, '');
}

const fakes: FakeSsh[] = [];

afterEach(() => {
  for (const ssh of fakes.splice(0)) {
    expect(ssh.unexpected).toEqual([]);
    for (const call of ssh.calls) {
      // INV-10: every helm command starts with the env prefix
      expect(call.command.startsWith(`${ENV_ONLY} `)).toBe(true);
      // INV-09: no --set* and no --password in argv
      expect(call.command).not.toMatch(/'--set|'--password'|'--password=/);
      // INV-07
      const verb = helmVerb(call.command);
      if (verb !== undefined && MUTATING_HELM.has(verb)) expect(call.path).toBe('channel');
      if (call.attempt > 1) expect(call.path).toBe('exec');
    }
  }
});

function setup(rules: FakeSshRule[], secrets: string[] = []) {
  const ssh = new FakeSsh(rules);
  fakes.push(ssh);
  const clock = new TestClock();
  const helm = createHelmExecutor(nodeRef('server_1'), { redactor: new Redactor(secrets), transport: ssh.transport(), clock });
  return { ssh, clock, helm };
}

describe('command shape', () => {
  it('U-RT-H-01: every call starts with the env prefix, the pinned binary and the Dockflow kubeconfig', async () => {
    const { ssh, helm } = setup([{ command: /'list'/, respond: { exitCode: 0, stdout: '[]' } }]);
    await helm.run({ args: ['list', '-n', NS, '-o', 'json'], mutating: false, timeoutS: 30 });
    expect(ssh.calls[0].command).toBe(`${PREFIX} 'list' '-n' '${NS}' '-o' 'json'`);
    expect(HELM_ENV_PREFIX).toBe(ENV_ONLY);
    expect(helmCommand({ args: ['version'] })).toBe(`${PREFIX} 'version'`);
  });

  it('U-RT-H-05: registry login sends the password on stdin with a per-call HELM_REGISTRY_CONFIG', async () => {
    const { ssh, helm } = setup([{ command: /'registry' 'login'/, respond: { exitCode: 0, stdout: 'Login Succeeded\n' } }], [PASSWORD]);
    await helm.run({
      args: ['registry', 'login', 'registry.example.com:5000', '--username', 'ci', '--password-stdin'],
      stdin: PASSWORD,
      mutating: false,
      timeoutS: 60,
      env: { registryConfig: `${TMP}/registry.json` },
    });
    const [call] = ssh.calls;
    expect(call.command).toBe(
      `${ENV_ONLY} HELM_REGISTRY_CONFIG='${TMP}/registry.json' /usr/local/lib/dockflow/bin/helm --kubeconfig=/var/lib/dockflow/kube/config 'registry' 'login' 'registry.example.com:5000' '--username' 'ci' '--password-stdin'`,
    );
    expect(call.command).not.toContain(PASSWORD);
    expect(call.path).toBe('channel');
    expect(Buffer.from(call.stdin).toString()).toBe(PASSWORD);
    expect(call.ended).toBe(true);
  });

  it('U-RT-H-06: a repositories file and cache are passed through the environment, in a fixed order', () => {
    expect(
      helmCommand({
        args: ['repo', 'update', 'dockflow-repo'],
        env: { repositoryCache: `${TMP}/cache`, repositoryConfig: `${TMP}/repositories.yaml` },
      }),
    ).toBe(
      `${ENV_ONLY} HELM_REPOSITORY_CONFIG='${TMP}/repositories.yaml' HELM_REPOSITORY_CACHE='${TMP}/cache' /usr/local/lib/dockflow/bin/helm --kubeconfig=/var/lib/dockflow/kube/config 'repo' 'update' 'dockflow-repo'`,
    );
  });

  it('refuses override paths outside a per-call temp directory before any SSH work', async () => {
    const { ssh, helm } = setup([]);
    expect(() => helmCommand({ args: ['repo', 'update'], env: { repositoryConfig: '/root/.config/helm/repositories.yaml' } })).toThrow(
      /per-call directory/,
    );
    expect(() => helmCommand({ args: ['repo', 'update'], env: { registryConfig: `${TMP}/../../../../../etc/passwd` } })).toThrow(
      /per-call directory/,
    );
    await expect(
      helm.run({ args: ['pull', 'web'], mutating: false, timeoutS: 120, env: { registryConfig: '/tmp/registry.json' } }),
    ).rejects.toThrow(/per-call directory/);
    expect(ssh.calls).toHaveLength(0);
  });

  it('refuses --set and --password in argv (values and passwords travel on stdin)', () => {
    for (const arg of ['--set', '--set=image.tag=1', '--set-string', '--set-file', '--set-json', '--set-literal', '--password', '--password=x']) {
      expect(() => helmCommand({ args: ['upgrade', '--install', 'web', TGZ, arg] })).toThrow(/not allowed/);
    }
    expect(() => helmCommand({ args: ['registry', 'login', 'r.example.com', '--password-stdin'] })).not.toThrow();
  });
});

describe('transport', () => {
  it('sends a mutating call through a channel with the values on stdin and never retries it', async () => {
    const values = `${JSON.stringify({ image: { tag: '1.4.2' }, replicaCount: 2 })}\n`;
    const { ssh, helm } = setup([
      { command: /'upgrade'/, respond: { exitCode: 0, stdout: 'Release "web" has been upgraded.\n' } },
      { command: /'uninstall'/, transportError: 'first-attempt', respond: { exitCode: 0 } },
    ]);
    await helm.run({
      args: ['upgrade', '--install', 'web', TGZ, '-n', NS, '--values', '-', '--timeout', '300s'],
      stdin: values,
      mutating: true,
      timeoutS: 300,
    });
    expect(ssh.calls[0].path).toBe('channel');
    expect(Buffer.from(ssh.calls[0].stdin).toString()).toBe(values);
    expect(ssh.calls[0].command).toContain(`'--values' '-'`);
    expect(ssh.calls[0].command).not.toContain('replicaCount');

    await expect(helm.run({ args: ['uninstall', 'web', '-n', NS], mutating: true, timeoutS: 300 })).rejects.toMatchObject({
      reason: 'Unreachable',
    });
    expect(ssh.calls.filter((call) => call.command.includes("'uninstall'"))).toHaveLength(1);
  });

  it('retries a read once after a transport error', async () => {
    const { ssh, helm } = setup([{ command: /'history'/, transportError: 'first-attempt', respond: { exitCode: 0, stdout: '[]' } }]);
    expect(await helm.json<unknown[]>(['history', 'web', '-n', NS])).toEqual([]);
    expect(ssh.calls.map((call) => [call.path, call.attempt])).toEqual([
      ['exec', 1],
      ['exec', 2],
    ]);
  });

  it('U-RT-H-07: json() appends -o json and parses the answer', async () => {
    const releases = [{ name: 'web', namespace: NS, revision: '3', status: 'deployed', chart: 'web-1.2.0' }];
    const { ssh, clock, helm } = setup([{ command: /'list'/, respond: { exitCode: 0, stdout: JSON.stringify(releases) } }]);
    expect(await helm.json<typeof releases>(['list', '-n', NS, '--filter', '^web$'])).toEqual(releases);
    expect(ssh.calls[0].command).toBe(`${PREFIX} 'list' '-n' '${NS}' '--filter' '^web$' '-o' 'json'`);
    expect(ssh.calls[0].path).toBe('exec');
    expect(clock.sleeps).toEqual([90_000]);
  });

  it('json() returns null for "release: not found" and throws for any other failure', async () => {
    const { helm } = setup([
      { command: /'missing'/, respond: { exitCode: 1, stderr: 'Error: release: not found\n' } },
      {
        command: /'web'/,
        respond: { exitCode: 1, stderr: 'Error: Kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version": dial tcp 127.0.0.1:6443: connect: connection refused\n' },
      },
    ]);
    expect(await helm.json(['history', 'missing', '-n', NS])).toBeNull();
    const failure = await helm.json(['history', 'web', '-n', NS]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KubeError);
    expect(failure).toMatchObject({ reason: 'Unreachable', exitCode: 1 });
  });

  it('returns a non-zero exit with allowFailure instead of throwing', async () => {
    const { helm } = setup([{ command: /'rollback'/, respond: { exitCode: 1, stderr: 'Error: release has no 7 version\n' } }]);
    const result = await helm.run({ args: ['rollback', 'web', '7', '-n', NS], mutating: true, timeoutS: 300, allowFailure: true });
    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'Error: release has no 7 version\n' });
  });
});

describe('guard', () => {
  it('U-RT-H-08: a mutating call is guarded at 4 * timeoutS + 120, a read at timeoutS + 60', () => {
    expect(helmGuardS({ mutating: true, timeoutS: 300 })).toBe(1320);
    expect(helmGuardS({ mutating: false, timeoutS: 30 })).toBe(90);
    expect(helmPendingStaleS(300)).toBe(2640);
    expect(helmPendingStaleS(600)).toBe(5040);
  });

  it('U-RT-H-08: expiry closes the channel and throws the timeout error', async () => {
    const { ssh, clock, helm } = setup([{ command: /'upgrade'/, hang: true, respond: { exitCode: 0 } }]);
    const pending = helm.run({ args: ['upgrade', '--install', 'web', TGZ, '-n', NS, '--timeout', '300s'], stdin: '{}\n', mutating: true, timeoutS: 300 });
    await settle();
    expect(clock.sleeps).toEqual([1_320_000]);
    clock.expireAll();
    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KubeError);
    expect((failure as KubeError).reason).toBe('Timeout');
    expect((failure as KubeError).message).toBe(
      'helm upgrade did not finish within 1320s on server_1; it may still be running there',
    );
    expect(ssh.calls[0].closed).toBe(true);
  });
});

describe('redaction and output', () => {
  it('U-RT-H-10: stderr echoing a secret value is redacted in the result and in the error', async () => {
    const stderr = `Error: execution error at (web/templates/secret.yaml:4:11): db.password ${PASSWORD} is too short\n`;
    const { helm } = setup([{ command: /'upgrade'/, respond: { exitCode: 1, stderr } }], [PASSWORD]);
    const call = { args: ['upgrade', '--install', 'web', TGZ, '-n', NS], stdin: '{}\n', mutating: true, timeoutS: 300 };
    const failure = await helm.run(call).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KubeError);
    expect((failure as KubeError).stderr).toBe('Error: execution error at (web/templates/secret.yaml:4:11): db.password *** is too short\n');
    expect((failure as KubeError).message).not.toContain(PASSWORD);
    const result = await helm.run({ ...call, allowFailure: true });
    expect(result.stderr).not.toContain(PASSWORD);
  });

  it('a failed repo update puts the cause Helm printed on stdout ahead of stderr, redacted', async () => {
    const stdout = [
      'Hang tight while we grab the latest from your chart repositories...',
      '...Unable to get an update from the "dockflow-repo" chart repository (https://charts.example.com):',
      `\tfailed to fetch https://charts.example.com/index.yaml?token=${PASSWORD} : 401 Unauthorized`,
      '',
    ].join('\n');
    const stderr = 'Error: failed to update the following repositories: [https://charts.example.com]\n';
    const { helm } = setup([{ command: /'repo' 'update'/, respond: { exitCode: 1, stdout, stderr } }], [PASSWORD]);
    const result = await helm.run({ args: ['repo', 'update', 'dockflow-repo'], mutating: false, timeoutS: 120, allowFailure: true });
    expect(result).toEqual({
      exitCode: 1,
      stdout,
      stderr: `failed to fetch https://charts.example.com/index.yaml?token=*** : 401 Unauthorized\n${stderr}`,
    });
  });

  it('U-RT-H-14: the stdout of get manifest is returned and never printed, --debug included', async () => {
    const manifest = `---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: web-db\ndata:\n  password: ${Buffer.from(PASSWORD).toString('base64')}\n`;
    const { helm } = setup([{ command: /'get' 'manifest'/, respond: { exitCode: 0, stdout: manifest } }], [PASSWORD]);
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
      stdout = (await helm.run({ args: ['get', 'manifest', 'web', '-n', NS], mutating: false, timeoutS: 30 })).stdout;
    } finally {
      setVerbose(false);
      delete process.env.VERBOSE;
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
    expect(stdout).toBe(manifest);
    const printed = writes.join('');
    expect(printed).toContain(`helm get manifest web -n ${NS} on server_1: exit 0`);
    expect(printed).not.toContain('kind: Secret');
    expect(printed).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });
});
