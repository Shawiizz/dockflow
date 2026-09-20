import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { DOCKFLOW_VERSION } from '../../../../constants';
import { SETUP_LOCK_FILE } from '../../../../commands/setup/k3s/constants';
import { inspect, runK3sNodeStep } from '../../../../commands/setup/k3s/node';
import { buildLocalPlan, buildNodePlan, finalizeClusterPlan, type K3sNodeInspection, type K3sNodePlan } from '../../../../commands/setup/k3s/plan';
import { sha256Hex } from '../../../../utils/hash';
import * as output from '../../../../utils/output';
import { FakeHostRunner } from '../../fakes/fake-host-runner';
import { assertExecutorInvariants } from '../../support/invariants';
import { Redactor } from '../../../../utils/redact';

const KEY = 'srv-1';
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOZ4hf7ZqvJ8n3x9C1Y7q6qgv9r0K5Z8mF3x2Q1w0e9 dockflow-deploy';

let runners: FakeHostRunner[] = [];

function host(options: ConstructorParameters<typeof FakeHostRunner>[0] = {}): FakeHostRunner {
  const runner = new FakeHostRunner(options);
  runners.push(runner);
  return runner;
}

/**
 * A handful of read-only host probes of inspect() (4.1) that FakeHostRunner's stock handlers do not
 * cover (design-07's R-S6-05 seam has no opinion on them): stubbed here with plausible answers.
 */
function withInspectStubs(runner: FakeHostRunner): FakeHostRunner {
  runner.seedFile('/proc/meminfo', 'MemTotal:        4046456 kB\n');
  return runner
    .on(['getenforce'], { exitCode: 1, stderr: 'getenforce: command not found' })
    .on(['nproc'], { stdout: '4\n' })
    .on(['df', '-B1', '--output=avail', '/var/lib'], { stdout: 'Avail\n21474836480\n' })
    .on(['ss', '-Hlntup'], { stdout: '' })
    .on(['docker', 'info', '--format', '{{.Swarm.LocalNodeState}}'], { exitCode: 1, stderr: 'docker: command not found' })
    .on(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], { exitCode: 1, stderr: 'timedatectl: command not found' })
    .on(['ip', 'link', 'add', 'dockflow-wgtest', 'type', 'wireguard'], { exitCode: 1, stderr: 'RTNETLINK answers: Operation not permitted' })
    .on(['ip', 'link', 'del', 'dockflow-wgtest'], { exitCode: 1, stderr: 'Cannot find device "dockflow-wgtest"' });
}

function inspectPlan(): K3sNodePlan {
  const cluster = buildLocalPlan({
    nodeName: KEY,
    deployUser: 'dockflow',
    deployPublicKey: PUBLIC_KEY,
    privateHost: null,
    publicHost: '10.0.0.10',
    requestedBackend: null,
    dockflowVersion: DOCKFLOW_VERSION,
  });
  return buildNodePlan({ operation: 'inspect', node: cluster.nodes[0].key, arch: 'amd64', plan: cluster });
}

function stdinOf(text: string): Readable {
  return Readable.from([text]);
}

async function run(text: string, runner: FakeHostRunner): Promise<{ lines: unknown[]; errors: string[]; exitCode: number | undefined }> {
  const raw = spyOn(output, 'printRaw').mockImplementation(() => {});
  const err = spyOn(output, 'printError').mockImplementation(() => {});
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await runK3sNodeStep(stdinOf(text), { runner });
    return {
      lines: raw.mock.calls.map((call) => JSON.parse(String(call[0]))),
      errors: err.mock.calls.map((call) => String(call[0])),
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExit;
    raw.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => {
  const hostRunner = runners;
  runners = [];
  for (const runner of hostRunner) runner.assertDone();
  assertExecutorInvariants({ hostRunner, redactor: new Redactor() });
});

describe('runK3sNodeStep protocol (3.4)', () => {
  it('N1 refuses a non-root invocation with exit 2 and no result line', async () => {
    const runner = host({ euid: 1000 });
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N2 invalid JSON is refused with exit 2 and no result line', async () => {
    const runner = host();
    const result = await run('{not valid json', runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N2 a schema violation is refused with exit 2 and no result line', async () => {
    const runner = host();
    const plan = inspectPlan() as unknown as Record<string, unknown>;
    delete plan.schema; // required by the zod schema
    const result = await run(JSON.stringify(plan), runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N3 a plan from another Dockflow version is refused, with a result line', async () => {
    const runner = host();
    const plan = { ...inspectPlan(), dockflowVersion: '0.0.1-does-not-exist' };
    const result = await run(JSON.stringify(plan), runner);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toHaveLength(1);
    const body = result.lines[0] as { dockflowNodeResult: { status: string; error: { message: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('refused');
    expect(body.dockflowNodeResult.error?.message).toContain('0.0.1-does-not-exist');
  });

  it('N4 a lock held by a live pid is refused with a message', async () => {
    const runner = host();
    await runner.writeFile(SETUP_LOCK_FILE, '4242\n', { mode: 0o600 });
    runner.seedDir('/proc/4242');
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(1);
    const body = result.lines[0] as { dockflowNodeResult: { status: string; error: { message: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('refused');
    expect(body.dockflowNodeResult.error?.message).toBe(`Another dockflow setup is running on ${KEY} (pid 4242)`);
    expect(await runner.stat(SETUP_LOCK_FILE)).not.toBeNull();
  });

  it('N4 a stale lock (dead pid) is removed and the run proceeds', async () => {
    const runner = withInspectStubs(host());
    await runner.writeFile(SETUP_LOCK_FILE, '9999\n', { mode: 0o600 });
    // /proc/9999 does not exist: the pid is dead
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    const body = result.lines[0] as { dockflowNodeResult: { status: string } };
    expect(body.dockflowNodeResult.status).toBe('ok');
  });

  it('N5 stdout carries exactly one JSON line, the result, and install.sh output never reaches it', async () => {
    const runner = withInspectStubs(host());
    runner.installScript = { exitCode: 0, stdout: 'super secret install.sh chatter that must stay off stdout' };
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(1);
    const body = result.lines[0] as { dockflowNodeResult: { schema: number; node: string; operation: string } };
    expect(body.dockflowNodeResult.schema).toBe(1);
    expect(body.dockflowNodeResult.node).toBe(KEY);
    expect(body.dockflowNodeResult.operation).toBe('inspect');
    for (const line of result.lines) expect(JSON.stringify(line)).not.toContain('super secret install.sh chatter');
  });
});

describe('inspect (4.1, N6)', () => {
  // read-only per 4.1, plus the two exceptions the design's own probe table specifies: the
  // `ip link add/del` pair that measures WireGuard kernel support.
  const READ_ONLY_PREFIXES: readonly string[] = [
    'uname',
    'getenforce',
    'nproc',
    'df',
    'ip',
    'getent',
    'which',
    'systemctl',
    'ss',
    'docker',
    'timedatectl',
    'ufw',
    '/usr/local/bin/k3s',
    '/usr/local/lib/dockflow/bin/helm',
  ];

  it('performs only read-only host commands (allowlist)', async () => {
    const runner = withInspectStubs(host());
    const plan = inspectPlan();
    const result = await inspect(runner, plan);
    expect(result.os.arch).toBe('amd64');

    for (const call of runner.calls) {
      const cmd = call.argv[0];
      expect(READ_ONLY_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(prefix))).toBe(true);
    }
    // the wireguard capability probe: an interface created and removed in the same pass, never left behind
    const links = runner.calls.filter((call) => call.argv[0] === 'ip' && call.argv[1] === 'link');
    expect(links.map((call) => call.argv[2])).toEqual(['add', 'del']);
    runner.assertDone();
  });

  it('inspect takes the lock itself when run through the full step (no dry-run races a real run)', async () => {
    const runner = withInspectStubs(host());
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    expect(await runner.stat(SETUP_LOCK_FILE)).toBeNull();
  });
});

describe('dockflowNodeEvent progress lines (3.4)', () => {
  /** an unmanaged, freshly reachable node: fed straight to `finalizeClusterPlan`, no real `inspect()` needed */
  function freshLocalInspection(): K3sNodeInspection {
    return {
      os: { id: 'ubuntu', versionId: '24.04', kernel: '6.8.0-45-generic', arch: 'amd64', systemd: true, selinux: 'absent' },
      resources: { cpus: 4, memoryBytes: 8 * 1024 ** 3, varLibFreeBytes: 100 * 1024 ** 3 },
      network: { localIpv4: ['10.0.0.10'], resolvedHost: null, defaultRouteIp: '10.0.0.10' },
      commands: { missing: [], packageManager: 'apt-get' },
      k3s: {
        binaryVersion: null,
        unit: null,
        activeState: null,
        subState: null,
        managed: false,
        state: null,
        dropinSha256: null,
        restartSha256: null,
        dropin: null,
        foreignConfig: [],
        unitEnvK3sVars: [],
        tokenFingerprints: { token: null, agentToken: null },
        caSha256: null,
        datastore: null,
        apiReady: null,
        netcheckPresent: null,
        defaultStorageClasses: null,
      },
      helmVersion: null,
      firewall: { ufw: 'absent', firewalld: 'absent' },
      portsInUse: [],
      swarmActive: false,
      dockerPresent: false,
      nmCloudSetupEnabled: false,
      wireguardAvailable: true,
      cgroupMemory: true,
      ntpSynchronized: true,
      deployUser: { exists: false, uid: null, home: null, keyAuthorized: false },
      legacySudoRules: [],
    };
  }

  it('prepare emits a start event and a matching finish event around every step, before the result line', async () => {
    const localCluster = buildLocalPlan({
      nodeName: KEY,
      deployUser: 'dockflow',
      deployPublicKey: PUBLIC_KEY,
      privateHost: null,
      publicHost: '10.0.0.10',
      requestedBackend: null,
      dockflowVersion: DOCKFLOW_VERSION,
      flags: { skipFirewall: true },
    });
    const resolved = finalizeClusterPlan(localCluster, { [KEY]: freshLocalInspection() });
    expect(resolved.refusals).toEqual([]);
    const plan = buildNodePlan({ operation: 'prepare', node: KEY, arch: 'amd64', plan: localCluster, cluster: resolved });

    // self-consistent fake pins (real K3S_PIN/HELM_PIN hashes are of actual release artefacts, unreproducible here)
    const k3sBytes = Buffer.from('#!fake k3s binary\n');
    const scriptBytes = Buffer.from('#!/bin/sh\nexit 0\n');
    const helmBytes = Buffer.from('#!fake helm archive\n');
    const runner = host();
    runner.seedCache(k3sBytes);
    runner.seedCache(scriptBytes);
    runner.seedCache(helmBytes);
    const wired: K3sNodePlan = {
      ...plan,
      pins: {
        k3s: {
          version: plan.pins.k3s.version,
          binary: { url: 'https://fake.invalid/k3s', sha256: sha256Hex(k3sBytes) },
          installScript: { url: 'https://fake.invalid/install.sh', sha256: sha256Hex(scriptBytes) },
        },
        helm: plan.pins.helm === null ? null : { version: plan.pins.helm.version, archive: { url: 'https://fake.invalid/helm', sha256: sha256Hex(helmBytes) } },
      },
    };

    const result = await run(JSON.stringify(wired), runner);
    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThan(1);

    type EventLine = { dockflowNodeEvent: { step: string; status: string; detail?: string } };
    type ResultLine = { dockflowNodeResult: { steps: { id: string }[] } };
    const eventLines = result.lines.slice(0, -1) as EventLine[];
    const resultLine = result.lines.at(-1) as ResultLine;
    expect(resultLine).toHaveProperty('dockflowNodeResult');
    for (const line of eventLines) expect(line).toHaveProperty('dockflowNodeEvent');

    const events = eventLines.map((line) => line.dockflowNodeEvent);
    const starts = events.filter((e) => e.status === 'start').map((e) => e.step);
    // one start event per recorded step, in the same order the result lists them (3.4's own example: `download-k3s`)
    expect(starts).toEqual(resultLine.dockflowNodeResult.steps.map((s) => s.id));
    expect(starts).toContain('download-k3s');
    const startIndex = events.findIndex((e) => e.step === 'download-k3s' && e.status === 'start');
    const finishIndex = events.findIndex((e) => e.step === 'download-k3s' && e.status === 'ok');
    expect(finishIndex).toBeGreaterThan(startIndex);
  });

  it('inspect (no steps) prints no event lines, only the result (N5 stays exactly one line)', async () => {
    const runner = withInspectStubs(host());
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toHaveProperty('dockflowNodeResult');
  });
});
