// design-06 3.1-3.3, 3.9 and 10.2 (`backends/containers.test.ts`), design-07 10.2 (U-BE-CONT-01..12):
// exec with the `sh -c` wrapper and its classification (K63b), I/O injection (K78), Helm targets
// (m9, R-25), cp over tar streams with the completion contract, stats filtered by role (K63a), and
// logs with and without --follow (K64a) over the real inventory and FakeKubeExecutor.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { PassThrough, type Readable } from 'node:stream';
import { join } from 'path';
import { ContainerPathError } from '../../../services/orchestrator/copy';
import type { ExecRequest, HelmReleaseStatus, LogLine, StackRef, StackRole } from '../../../services/orchestrator/interfaces';
import {
  cpuMillicores,
  EXEC_WRAPPER_SCRIPT,
  KubernetesContainerBackend,
  LOG_IDLE_NOTICE,
  memoryBytes,
  runtimeStartFailure,
  wrapExecArgv,
} from '../../../services/orchestrator/kubernetes/backends/containers';
import { createInventoryReader, INVENTORY_RESOURCES } from '../../../services/orchestrator/kubernetes/backends/inventory';
import { HELM_MANAGED_BY, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import type { K8sDistribution } from '../../../services/orchestrator/kubernetes/distribution';
import { type KubectlResult, kubectlCommand } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { SINCE_ERROR_MESSAGE } from '../../../services/orchestrator/kubernetes/status/logs';
import {
  CLIError,
  ConnectionError,
  ErrorCode,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
  ValidationError,
} from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeKubeExecutor, type KubeStep, type RecordedKubeCall } from '../fakes/fake-kube-executor';
import { shellTokens } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const APP: StackRef = { project: 'shop', env: 'production', role: 'app' };
const ACC: StackRef = { ...APP, role: 'accessory' };
const START = '2026-09-17T09:00:00Z';
const WEB = 'web-6d4b9c7f8-x2x4q';
/** the fake's default distribution, so command strings are built exactly as the executor builds them */
const DISTRIBUTION: K8sDistribution = new FakeKubeExecutor({ redactor: new Redactor([]) }).distribution;

/** recorded container-runtime start failures (design-07 10.2, re-recorded on the test machine per PD-12) */
function execStderr(name: 'sh-not-found' | 'sh-stat' | 'named-shell-stat' | 'tar-not-found'): string {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr', 'exec', `${name}.txt`), 'utf8').replace(/\r\n/g, '\n');
}

const R20_STDERR = execStderr('sh-not-found');
const R20_STAT_STDERR = execStderr('sh-stat');
const R20_BASH_STDERR = execStderr('named-shell-stat');
const NO_TAR_STDERR = execStderr('tar-not-found');

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function composeLabels(role: StackRole, serviceName: string): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'dockflow',
    [`${P}/stack`]: NS,
    [`${P}/role`]: role,
    [`${P}/service`]: serviceName,
    [`${P}/part`]: 'stack',
  };
}

function templateLabels(role: StackRole, serviceName: string): Record<string, string> {
  return { [`${P}/stack`]: NS, [`${P}/role`]: role, [`${P}/service`]: serviceName };
}

function template(containers: string[]): Obj {
  return { metadata: {}, spec: { containers: containers.map((name) => ({ name, image: `registry.example.com/shop/${name}:1.4.2` })) } };
}

function deployment(service: string, role: StackRole = 'app'): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: service, namespace: NS, uid: `uid-${service}`, labels: composeLabels(role, service), annotations: { [`${P}/compose-service`]: service } },
    spec: { replicas: 1, selector: {}, template: template([service]) },
  };
}

function statefulSet(service: string, role: StackRole, revisions: { update: string; current: string }): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: service, namespace: NS, uid: `uid-${service}`, labels: composeLabels(role, service), annotations: { [`${P}/compose-service`]: service } },
    spec: { replicas: 2, serviceName: service, selector: {}, template: template([service]) },
    status: { updateRevision: revisions.update, currentRevision: revisions.current },
  };
}

function helmDeployment(name: string, release: string): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: NS,
      uid: `uid-${name}`,
      labels: { 'app.kubernetes.io/managed-by': HELM_MANAGED_BY, 'app.kubernetes.io/instance': release },
      annotations: { [KUBE_KEYS.helmReleaseName]: release, [KUBE_KEYS.helmReleaseNamespace]: NS },
    },
    spec: { replicas: 1, selector: {}, template: template([name]) },
  };
}

interface PodOptions {
  containers?: string[];
  phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed';
  ready?: boolean;
  node?: string;
  startTime?: string;
  restarts?: number;
  waiting?: string;
  deleting?: boolean;
  /** memory limit of every container */
  limit?: string;
  labels?: Record<string, string>;
}

function podObject(name: string, owner: { kind: string; name: string } | null, labels: Record<string, string>, defaults: string[], o: PodOptions): Obj {
  const containers = o.containers ?? defaults;
  const phase = o.phase ?? (o.waiting ? 'Pending' : 'Running');
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: NS,
      uid: `uid-${name}`,
      labels: { ...labels, ...o.labels },
      ...(o.deleting ? { deletionTimestamp: START } : {}),
      ...(owner ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: owner.kind, name: owner.name, uid: `uid-${owner.name}`, controller: true }] } : {}),
    },
    spec: {
      nodeName: o.node ?? 'worker-1',
      containers: containers.map((c) => ({
        name: c,
        image: `registry.example.com/shop/${c}:1.4.2`,
        ...(o.limit ? { resources: { limits: { memory: o.limit } } } : {}),
      })),
    },
    status: {
      phase,
      startTime: o.startTime ?? START,
      containerStatuses: containers.map((c) => ({
        name: c,
        ready: o.ready ?? phase === 'Running',
        restartCount: o.restarts ?? 0,
        image: `registry.example.com/shop/${c}:1.4.2`,
        state: o.waiting ? { waiting: { reason: o.waiting } } : phase === 'Running' ? { running: { startedAt: START } } : {},
      })),
    },
  };
}

function composePod(service: string, role: StackRole, hash: string, suffix: string, o: PodOptions = {}): Obj {
  return podObject(
    `${service}-${hash}-${suffix}`,
    { kind: 'ReplicaSet', name: `${service}-${hash}` },
    { ...templateLabels(role, service), 'pod-template-hash': hash },
    [service],
    o,
  );
}

function webPod(suffix: string, o: PodOptions = {}): Obj {
  return composePod('web', 'app', '6d4b9c7f8', suffix, o);
}

function statefulPod(service: string, role: StackRole, ordinal: number, revision: string, o: PodOptions = {}): Obj {
  return podObject(
    `${service}-${ordinal}`,
    { kind: 'StatefulSet', name: service },
    { ...templateLabels(role, service), 'controller-revision-hash': revision },
    [service],
    o,
  );
}

function helmPod(workload: string, release: string, suffix: string, o: PodOptions = {}): Obj {
  return podObject(
    `${workload}-7c9d8-${suffix}`,
    { kind: 'ReplicaSet', name: `${workload}-7c9d8` },
    { 'app.kubernetes.io/instance': release, 'pod-template-hash': '7c9d8' },
    [workload],
    o,
  );
}

function helperPod(name: string): Obj {
  return podObject(name, null, { 'app.kubernetes.io/managed-by': 'dockflow', [`${P}/part`]: 'helper', [`${P}/stack`]: NS }, ['archive'], {});
}

function release(name: string, role: StackRole): HelmReleaseStatus {
  return { name, namespace: NS, role, revision: 1, status: 'deployed', chart: `${name}-2.4.1`, appVersion: '2.4.1', updated: null };
}

function list(items: Obj[]): { json: Obj } {
  return { json: { apiVersion: 'v1', kind: 'List', items } };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cmd(args: string[], namespace = NS): string {
  return kubectlCommand(DISTRIBUTION, { args, namespace, requestTimeoutS: null });
}

function channelStep(args: string[], respond: KubeStep['respond'], extra: Partial<KubeStep> = {}): KubeStep {
  return { method: 'channel', args: [cmd(args)], respond, ...extra };
}

function result(exitCode: number, stdout = '', stderr = ''): KubectlResult {
  return { exitCode, stdout, stderr };
}

interface Harness {
  kube: FakeKubeExecutor;
  backend: KubernetesContainerBackend;
  clock: FakeClock;
  announced: string[];
  interrupt(): void;
}

const created: FakeKubeExecutor[] = [];

afterEach(() => {
  const kubes = created.splice(0);
  for (const kube of kubes) if (!kube.asserted) kube.assertDone();
  assertExecutorInvariants({ kube: kubes });
});

function harness(items: Obj[], script: KubeStep[] = [], options: { releases?: HelmReleaseStatus[]; redactor?: Redactor } = {}): Harness {
  const clock = new FakeClock();
  const redactor = options.redactor ?? new Redactor([]);
  const inventory: KubeStep = {
    id: 'inventory',
    method: 'getJson',
    namespace: NS,
    args: ['get', INVENTORY_RESOURCES.join(','), '-o', 'json'],
    respond: list(items),
    optional: true,
  };
  const kube = new FakeKubeExecutor({ redactor, script: [inventory, ...script], order: 'any', clock });
  created.push(kube);
  const handlers = new Set<() => void>();
  const announced: string[] = [];
  const backend = new KubernetesContainerBackend({
    deps: { kubectl: kube, clock, redactor, distribution: kube.distribution },
    inventory: createInventoryReader({ kubectl: kube, helm: { listAll: async () => options.releases ?? [] } }),
    env: 'production',
    serverNames: ['server_1', 'worker_1'],
    localOffset: 0,
    interrupts: (onInterrupt) => {
      handlers.add(onInterrupt);
      return () => {
        handlers.delete(onInterrupt);
      };
    },
    announce: (text) => announced.push(text),
  });
  return {
    kube,
    backend,
    clock,
    announced,
    interrupt: () => {
      for (const handler of [...handlers]) handler();
    },
  };
}

function captureIo(stdinText?: string): { io: NonNullable<ExecRequest['io']>; text: { out: string; err: string } } {
  const stdin = new PassThrough();
  if (stdinText !== undefined) stdin.end(stdinText);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const text = { out: '', err: '' };
  stdout.on('data', (chunk: Buffer) => {
    text.out += chunk.toString('utf8');
  });
  stderr.on('data', (chunk: Buffer) => {
    text.err += chunk.toString('utf8');
  });
  return { io: { stdin, stdout, stderr }, text };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function channels(kube: FakeKubeExecutor): RecordedKubeCall[] {
  return kube.calls.filter((call) => call.method === 'channel');
}

function argvAfterDashes(script: string): string[] {
  const words = shellTokens(script).map((token) => token.value);
  return words.slice(words.indexOf('--') + 1);
}

const WEB_ITEMS: Obj[] = [deployment('web'), webPod('x2x4q')];

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('exec', () => {
  it('U-BE-CONT-01: each argv element reaches the channel quoted on its own; the exit code is returned', async () => {
    const argv = ['sh', '-c', 'echo "$0 $1"', 'a b', "it's", '$(id)', 'line1\nline2'];
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', ...argv], result(3, 'out\n', 'boom\ncommand terminated with exit code 3\n'))]);
    const { io, text } = captureIo();
    expect(await h.backend.exec(APP, { service: 'web' }, { argv, tty: false, stdin: false, io })).toBe(3);
    expect(argvAfterDashes(channels(h.kube)[0].commandString)).toEqual(argv);
    expect(text.out).toBe('out\n');
    // kubectl's own line is not the container's stderr
    expect(text.err).toBe('boom\n');
  });

  it('U-BE-CONT-02: the --workdir/--env wrapper, exact for workdir only, env only and both', async () => {
    expect(EXEC_WRAPPER_SCRIPT).toBe(
      '[ -n "$1" ] && { cd "$1" 2>/dev/null || { echo DOCKFLOW_NO_WORKDIR >&2; exit 125; }; }; shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done; shift; exec "$@"',
    );
    const wrapper = ['sh', '-c', EXEC_WRAPPER_SCRIPT, 'dockflow-exec'];
    expect(wrapExecArgv(['ls', '-la'], '/srv', undefined)).toEqual([...wrapper, '/srv', '--', 'ls', '-la']);
    expect(wrapExecArgv(['env'], undefined, { A: '1', B: 'x y' })).toEqual([...wrapper, '', 'A=1', 'B=x y', '--', 'env']);
    const both = wrapExecArgv(['pwd'], '/tmp', { TOKEN: "a'b $c" });
    expect(both).toEqual([...wrapper, '/tmp', "TOKEN=a'b $c", '--', 'pwd']);

    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', ...both], result(0, '/tmp\n'))]);
    const { io, text } = captureIo();
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['pwd'], workdir: '/tmp', env: { TOKEN: "a'b $c" }, tty: false, stdin: false, io })).toBe(0);
    expect(text.out).toBe('/tmp\n');
    // values are positional parameters, never part of the script
    expect(argvAfterDashes(channels(h.kube)[0].commandString)).toEqual(both);
  });

  it('forwards local stdin with -i only when asked', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(['exec', '-i', WEB, '-c', 'web', '--', 'cat'], (_call, recorded) => result(0, recorded.stdinText.toUpperCase()), { stdin: /^hello$/ }),
      channelStep(['exec', WEB, '-c', 'web', '--', 'true'], result(0)),
    ]);
    const piped = captureIo('hello');
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['cat'], tty: false, stdin: true, io: piped.io })).toBe(0);
    expect(piped.text.out).toBe('HELLO');
    const plain = captureIo();
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['true'], tty: false, stdin: false, io: plain.io })).toBe(0);
  });

  it('runs a TTY command through interactive with -i -t and names the pod it lands in', async () => {
    const h = harness(WEB_ITEMS, [{ method: 'interactive', args: [cmd(['exec', '-i', '-t', WEB, '-c', 'web', '--', 'top'])], respond: result(130) }]);
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['top'], tty: true, stdin: true })).toBe(130);
    expect(h.announced).toEqual([`(pod ${WEB} on worker_1)`]);
  });

  it('U-BE-CONT-03: --user is refused before any call (R-01)', async () => {
    const h = harness(WEB_ITEMS);
    const error = await failure(h.backend.exec(APP, { service: 'web' }, { argv: ['id'], user: 'root', tty: false, stdin: false, io: captureIo().io }));
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error.message).toBe('dockflow exec --user is not supported with orchestrator: k3s: the Kubernetes exec API runs commands as the container user');
    const accessory = await failure(h.backend.exec(ACC, { service: 'db' }, { argv: ['id'], user: 'root', tty: false, stdin: false }));
    expect(accessory.message).toStartWith('dockflow accessories exec --user is not supported');
    expect(h.kube.calls).toEqual([]);
  });

  it('a channel lost mid-command is a ConnectionError', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'sleep', '60'], { transportError: true })]);
    const error = await failure(h.backend.exec(APP, { service: 'web' }, { argv: ['sleep', '60'], tty: false, stdin: false, io: captureIo().io }));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe('Lost the connection to server_1 while running a command in web');
  });
});

describe('exec classification (K63b)', () => {
  const wrapped = wrapExecArgv(['true'], '/does/not/exist', undefined);

  it('exit 125 with the marker is the --workdir ValidationError, and the marker is not forwarded', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', ...wrapped], result(125, '', 'DOCKFLOW_NO_WORKDIR\ncommand terminated with exit code 125\n'))]);
    const { io, text } = captureIo();
    const error = (await failure(h.backend.exec(APP, { service: 'web' }, { argv: ['true'], workdir: '/does/not/exist', tty: false, stdin: false, io }))) as CLIError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('--workdir /does/not/exist does not exist in web');
    expect(error.suggestion).toBe('Check the path with: `dockflow exec production web -- ls /does/not`.');
    expect(text.err).not.toContain('DOCKFLOW_NO_WORKDIR');
  });

  for (const exitCode of [1, 126, 127, 128]) {
    it(`the runtime's exec: "sh" start failure with exit ${exitCode} is R-20`, async () => {
      const env = { A: '1' };
      const argv = wrapExecArgv(['env'], undefined, env);
      const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', ...argv], result(exitCode, '', exitCode === 128 ? R20_STAT_STDERR : R20_STDERR))]);
      const error = (await failure(h.backend.exec(APP, { service: 'web' }, { argv: ['env'], env, tty: false, stdin: false, io: captureIo().io }))) as CLIError;
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect(error.message).toBe('--workdir and --env require /bin/sh in the container on orchestrator: k3s');
      expect(error.suggestion).toBe('Run the command without `--workdir` and `--env`.');
    });
  }

  it('a missing user binary run by a present shell is the user exit code, not R-20', async () => {
    const argv = wrapExecArgv(['foo'], undefined, { A: '1' });
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', ...argv], result(127, '', 'sh: 1: exec: foo: not found\ncommand terminated with exit code 127\n'))]);
    const { io, text } = captureIo();
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['foo'], env: { A: '1' }, tty: false, stdin: false, io })).toBe(127);
    expect(text.err).toBe('sh: 1: exec: foo: not found\n');
  });

  it('exit 125 without the marker and exit 126 are passed through', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(['exec', WEB, '-c', 'web', '--', ...wrapExecArgv(['tool'], '/srv', undefined)], result(125, '', 'tool failed\n')),
      channelStep(['exec', WEB, '-c', 'web', '--', ...wrapExecArgv(['script.sh'], '/srv', undefined)], result(126, '', 'sh: 1: script.sh: Permission denied\n')),
    ]);
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['tool'], workdir: '/srv', tty: false, stdin: false, io: captureIo().io })).toBe(125);
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['script.sh'], workdir: '/srv', tty: false, stdin: false, io: captureIo().io })).toBe(126);
  });

  it('without the wrapper the runtime text is the command own failure', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'sh'], result(1, '', R20_STDERR))]);
    const { io, text } = captureIo();
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['sh'], tty: false, stdin: false, io })).toBe(1);
    expect(text.err).toBe(R20_STDERR);
  });

  it('runtimeStartFailure keys on the quoted program name', () => {
    expect(runtimeStartFailure(R20_STDERR, 'sh')).toBe(true);
    expect(runtimeStartFailure(R20_STAT_STDERR, 'sh')).toBe(true);
    expect(runtimeStartFailure(R20_BASH_STDERR, '/bin/bash')).toBe(true);
    expect(runtimeStartFailure(NO_TAR_STDERR, 'tar')).toBe(true);
    expect(runtimeStartFailure('sh: 1: exec: foo: not found', 'sh')).toBe(false);
    expect(runtimeStartFailure(R20_STDERR, 'bash')).toBe(false);
  });
});

describe('I/O injection (U-BE-CONT-11, K78)', () => {
  it('with io given no byte touches the process streams, and a TTY request runs without a PTY', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', '-i', WEB, '-c', 'web', '--', 'cat'], (_call, recorded) => result(0, recorded.stdinText.toUpperCase(), 'note\n'))]);
    const out = spyOn(process.stdout, 'write');
    const err = spyOn(process.stderr, 'write');
    const pipe = spyOn(process.stdin, 'pipe');
    const pause = spyOn(process.stdin, 'pause');
    try {
      const { io, text } = captureIo('hello');
      expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['cat'], tty: true, stdin: true, io })).toBe(0);
      expect(text).toEqual({ out: 'HELLO', err: 'note\n' });
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(pipe).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(h.announced).toEqual([]);
    } finally {
      out.mockRestore();
      err.mockRestore();
      pipe.mockRestore();
      pause.mockRestore();
    }
  });

  it('without io the process streams are used', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'hostname'], result(0, 'web-host\n', 'warning\n'))]);
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['hostname'], tty: false, stdin: false })).toBe(0);
      expect(out.mock.calls.map((call) => String(call[0])).join('')).toContain('web-host');
      expect(err.mock.calls.map((call) => String(call[0])).join('')).toContain('warning');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(h.announced).toEqual([`(pod ${WEB} on worker_1)`]);
  });
});

describe('target selection (U-BE-CONT-04)', () => {
  const items: Obj[] = [
    deployment('web'),
    webPod('aaaaa', { deleting: true }),
    webPod('bbbbb'),
    statefulSet('db', 'accessory', { update: 'db-new', current: 'db-old' }),
    statefulPod('db', 'accessory', 0, 'db-old'),
    statefulPod('db', 'accessory', 1, 'db-new'),
  ];

  it('skips terminating pods and prefers the current revision', async () => {
    const h = harness(items, [
      channelStep(['exec', 'web-6d4b9c7f8-bbbbb', '-c', 'web', '--', 'true'], result(0)),
      channelStep(['exec', 'db-1', '-c', 'db', '--', 'true'], result(0)),
    ]);
    expect(await h.backend.exec(APP, { service: 'web' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io })).toBe(0);
    expect(await h.backend.exec(ACC, { service: 'db' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io })).toBe(0);
  });

  it('an app ref never reaches an accessory pod, and --pod must name an instance of the service', async () => {
    const h = harness(items, [channelStep(['exec', 'db-0', '-c', 'db', '--', 'true'], result(0))]);
    const other = (await failure(h.backend.exec(APP, { service: 'db' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }))) as CLIError;
    expect(other.code).toBe(ErrorCode.SERVICE_NOT_FOUND);
    expect(other.message).toBe(`Service db is not deployed in namespace ${NS}`);
    const foreign = await failure(h.backend.exec(APP, { service: 'web', instance: 'db-0' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }));
    expect(foreign).toBeInstanceOf(ValidationError);
    expect(foreign.message).toBe('Instance db-0 does not belong to service web');
    // an older revision is still a valid explicit choice
    expect(await h.backend.exec(ACC, { service: 'db', instance: 'db-0' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io })).toBe(0);
  });

  it('a service without a running pod is CONTAINER_NOT_FOUND', async () => {
    const h = harness([deployment('web'), webPod('ccccc', { waiting: 'ImagePullBackOff' })]);
    const error = (await failure(h.backend.exec(APP, { service: 'web' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }))) as CLIError;
    expect(error.code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect(error.message).toBe('Service web has no running instance (1 ImagePullBackOff)');
  });
});

describe('Helm targets (U-BE-CONT-12, m9)', () => {
  const items: Obj[] = [
    helmDeployment('search-api', 'search'),
    helmDeployment('search-worker', 'search'),
    helmPod('search-api', 'search', 'aaaaa'),
    helmPod('search-worker', 'search', 'bbbbb'),
    helmDeployment('cache', 'cache'),
    helmPod('cache', 'cache', 'ccccc'),
    ...WEB_ITEMS,
  ];
  const releases = [release('search', 'app'), release('cache', 'app')];

  it('a named workload restricts the pod choice to it', async () => {
    const h = harness(items, [channelStep(['exec', 'search-worker-7c9d8-bbbbb', '-c', 'search-worker', '--', 'true'], result(0))], { releases });
    const code = await h.backend.exec(APP, { service: 'search', workload: 'search-worker' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io });
    expect(code).toBe(0);
  });

  it('an unknown workload names the release workloads', async () => {
    const h = harness(items, [], { releases });
    const error = (await failure(h.backend.exec(APP, { service: 'search', workload: 'nope' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }))) as CLIError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Helm release search has no workload nope');
    expect(error.suggestion).toBe('Choose one of: `search-api, search-worker`.');
  });

  it('R-25: a bare release owning two workloads is refused before any exec', async () => {
    const h = harness(items, [], { releases });
    const error = (await failure(h.backend.exec(APP, { service: 'search' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }))) as CLIError;
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error.message).toBe('Helm release search owns 2 workloads; name the one you mean');
    expect(error.suggestion).toBe('Run it again with `<release>/<workload>`: `search/search-api, search/search-worker`.');
    expect(channels(h.kube)).toEqual([]);
    // cp builds the same target
    const copy = await failure(h.backend.copyOut(APP, { service: 'search' }, '/data'));
    expect(copy).toBeInstanceOf(UnsupportedOperationError);
  });

  it('a bare release owning one workload uses it; a compose service takes no workload', async () => {
    const h = harness(items, [channelStep(['exec', 'cache-7c9d8-ccccc', '-c', 'cache', '--', 'true'], result(0))], { releases });
    expect(await h.backend.exec(APP, { service: 'cache' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io })).toBe(0);
    const compose = await failure(h.backend.exec(APP, { service: 'web', workload: 'web' }, { argv: ['true'], tty: false, stdin: false, io: captureIo().io }));
    expect(compose).toBeInstanceOf(ValidationError);
    expect(compose.message).toBe('web/web names a workload, but web is not a Helm release');
  });
});

describe('capture, shell and interactiveCommand', () => {
  it('capture is a buffered, read-only exec', async () => {
    const h = harness(WEB_ITEMS, [{ method: 'run', namespace: NS, mutating: false, args: ['exec', WEB, '-c', 'web', '--', 'cat', '/etc/hostname'], respond: result(0, 'web-1\n') }]);
    expect(await h.backend.capture(APP, { service: 'web' }, ['cat', '/etc/hostname'])).toEqual({ exitCode: 0, stdout: 'web-1\n', stderr: '' });
  });

  it('shell auto asks for bash, then opens a PTY session on the detected path', async () => {
    const h = harness(WEB_ITEMS, [
      { method: 'run', namespace: NS, args: ['exec', WEB, '-c', 'web', '--', 'sh', '-c', 'command -v bash || command -v sh'], respond: result(0, '/usr/bin/bash\n') },
      { method: 'interactive', args: [cmd(['exec', '-i', '-t', WEB, '-c', 'web', '--', '/usr/bin/bash'])], respond: result(0) },
    ]);
    expect(await h.backend.shell(APP, { service: 'web' }, 'auto')).toBe(0);
    expect(h.announced).toEqual([`(pod ${WEB} on worker_1)`]);
    expect(h.kube.calls.filter((call) => call.method !== 'command').map((call) => call.method)).toEqual(['getJson', 'run', 'interactive']);
  });

  it('R-18: an image without the shell, for auto and for a named shell', async () => {
    const h = harness(WEB_ITEMS, [
      { method: 'run', namespace: NS, args: ['exec', WEB, '-c', 'web', '--', 'sh', '-c', 'command -v bash || command -v sh'], respond: result(1, '', R20_STDERR) },
      {
        method: 'run',
        namespace: NS,
        args: ['exec', WEB, '-c', 'web', '--', '/bin/bash', '-c', 'exit 0'],
        respond: result(1, '', R20_BASH_STDERR),
      },
    ]);
    const auto = (await failure(h.backend.shell(APP, { service: 'web' }, 'auto'))) as CLIError;
    expect(auto.code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect(auto.message).toBe('Service web has no shell (/bin/sh not found in the image)');
    expect(auto.suggestion).toBe('Run a binary directly: `dockflow exec production web -- <binary> <args>`.');
    const bash = await failure(h.backend.shell(APP, { service: 'web' }, '/bin/bash'));
    expect(bash.message).toBe('Service web has no shell (/bin/bash not found in the image)');
    expect(h.kube.calls.some((call) => call.method === 'interactive')).toBe(false);
  });

  it('U-BE-CONT-09: interactiveCommand returns the control-plane connection and the exact command', async () => {
    const h = harness(WEB_ITEMS);
    const found = await h.backend.interactiveCommand(APP, { service: 'web' }, '/bin/sh');
    expect(found.connection).toEqual(h.kube.node.connection);
    expect(found.command).toBe(cmd(['exec', '-i', '-t', WEB, '-c', 'web', '--', '/bin/sh']));
    expect(found.command).toStartWith(`${DISTRIBUTION.kubectlCommand} --kubeconfig=`);
    expect(h.kube.calls.filter((call) => call.method !== 'command').map((call) => call.method)).toEqual(['getJson']);
  });
});

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('cp (U-BE-CONT-08)', () => {
  it('copyOut runs tar cf - -C <dir> <entry> and streams the archive once the exit status is 0', async () => {
    const nul = String.fromCharCode(0);
    const bytes = `tar${nul}bytes${nul}`;
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app', 'logs'], result(0, bytes))]);
    const archive = await h.backend.copyOut(APP, { service: 'web' }, '/app/logs');
    expect((await readAll(archive)).toString('utf8')).toBe(bytes);
  });

  it('copyOut archives the entries for SRC/.', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app/logs', '.'], result(0, 'x'))]);
    await readAll(await h.backend.copyOut(APP, { service: 'web' }, '/app/logs/.'));
  });

  it('a failed copyOut errors the stream with the reason: not-found, no-tar, not-a-directory', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(
        ['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app', 'missing'],
        result(2, '', "tar: missing: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\ncommand terminated with exit code 2\n"),
      ),
      channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app', 'data'], result(1, '', NO_TAR_STDERR)),
      channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app', 'bin'], result(127, '')),
      channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/app/file.txt', '.'], result(2, '', "tar: /app/file.txt: Cannot open: Not a directory\n")),
    ]);
    const missing = (await failure(readAll(await h.backend.copyOut(APP, { service: 'web' }, '/app/missing')))) as ContainerPathError;
    expect(missing).toBeInstanceOf(ContainerPathError);
    expect(missing.reason).toBe('not-found');
    expect(missing.message).toBe('Path /app/missing does not exist in web');
    const noTar = (await failure(readAll(await h.backend.copyOut(APP, { service: 'web' }, '/app/data')))) as ContainerPathError;
    expect(noTar.reason).toBe('no-tar');
    expect(noTar.message).toBe('Copying files requires tar in the container image of web');
    expect(noTar.suggestion).toBe('Add tar to the image, or copy through a volume.');
    const exit127 = (await failure(readAll(await h.backend.copyOut(APP, { service: 'web' }, '/app/bin')))) as ContainerPathError;
    expect(exit127.reason).toBe('no-tar');
    const notDirectory = (await failure(readAll(await h.backend.copyOut(APP, { service: 'web' }, '/app/file.txt/.')))) as ContainerPathError;
    expect(notDirectory.reason).toBe('not-a-directory');
    expect(notDirectory.message).toBe('Path /app/file.txt in web is not a directory');
  });

  it('a reader that stops early closes the channel', async () => {
    const h = harness(WEB_ITEMS, [channelStep(['exec', WEB, '-c', 'web', '--', 'tar', 'cf', '-', '-C', '/', 'data'], { hang: true })]);
    const archive = await h.backend.copyOut(APP, { service: 'web' }, '/data');
    archive.destroy();
    await h.clock.advance(0);
    expect(channels(h.kube)[0].closed).toBe(true);
  });

  it('copyIn runs tar xf - -C <dir> with -i and forwards the archive bytes unchanged', async () => {
    const bytes = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0xff, 0x00, 0x1f, 0x8b, 0x0a]);
    const h = harness(WEB_ITEMS, [
      channelStep(['exec', '-i', WEB, '-c', 'web', '--', 'tar', 'xf', '-', '-C', '/etc/app'], (_call, recorded) => {
        expect(Buffer.from(recorded.stdinBytes).equals(bytes)).toBe(true);
        return result(0);
      }),
      channelStep(['exec', '-i', WEB, '-c', 'web', '--', 'tar', 'xf', '-', '-C', '/nope'], result(2, '', "tar: /nope: Cannot open: No such file or directory\n")),
    ]);
    const source = new PassThrough();
    source.end(bytes);
    await h.backend.copyIn(APP, { service: 'web' }, '/etc/app', source);
    const failed = new PassThrough();
    failed.end(bytes);
    const error = (await failure(h.backend.copyIn(APP, { service: 'web' }, '/nope', failed))) as ContainerPathError;
    expect(error.reason).toBe('not-found');
    expect(error.message).toBe('Path /nope does not exist in web');
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function metricsStep(respond: KubeStep['respond']): KubeStep {
  return { id: 'metrics', method: 'run', namespace: null, args: ['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`], respond };
}

function podMetrics(name: string, usage: Record<string, { cpu: string; memory: string }>): Obj {
  return { metadata: { name, namespace: NS }, containers: Object.entries(usage).map(([container, u]) => ({ name: container, usage: u })) };
}

describe('stats (K63a)', () => {
  it('converts CPU and memory units', () => {
    expect(cpuMillicores('104311n')).toBe(0.104311);
    expect(cpuMillicores('250u')).toBe(0.25);
    expect(cpuMillicores('5m')).toBe(5);
    expect(cpuMillicores('2')).toBe(2000);
    expect(cpuMillicores('bogus')).toBeNull();
    expect(memoryBytes('412Ki')).toBe(421888);
    expect(memoryBytes('20Mi')).toBe(20971520);
    expect(memoryBytes('1G')).toBe(1e9);
    expect(memoryBytes('1048576')).toBe(1048576);
    expect(memoryBytes(undefined)).toBeNull();
  });

  it('keeps the rows of the ref role only, helper pods and pods without metrics excluded, with one metrics read', async () => {
    const items: Obj[] = [
      deployment('web'),
      webPod('aaaaa', { limit: '512Mi' }),
      webPod('bbbbb', { limit: '512Mi' }),
      statefulSet('db', 'accessory', { update: 'db-1', current: 'db-1' }),
      statefulPod('db', 'accessory', 0, 'db-1', { node: 'server-1' }),
      helmDeployment('search-api', 'search'),
      helmPod('search-api', 'search', 'ccccc'),
      helmDeployment('cache', 'cache'),
      helmPod('cache', 'cache', 'ddddd'),
      helperPod('dockflow-helper-archive-3f9a2c1b'),
    ];
    const metrics = {
      kind: 'PodMetricsList',
      apiVersion: 'metrics.k8s.io/v1beta1',
      metadata: {},
      items: [
        podMetrics('web-6d4b9c7f8-aaaaa', { web: { cpu: '250u', memory: '20Mi' } }),
        podMetrics('db-0', { db: { cpu: '5m', memory: '1048576' } }),
        podMetrics('search-api-7c9d8-ccccc', { 'search-api': { cpu: '104311n', memory: '412Ki' } }),
        podMetrics('cache-7c9d8-ddddd', { cache: { cpu: '2', memory: '1G' } }),
        podMetrics('dockflow-helper-archive-3f9a2c1b', { archive: { cpu: '0', memory: '240Ki' } }),
        podMetrics('stranger-1', { stranger: { cpu: '1m', memory: '1Mi' } }),
      ],
    };
    const h = harness(items, [metricsStep({ json: metrics })], { releases: [release('search', 'app'), release('cache', 'accessory')] });
    const app = await h.backend.stats(APP);
    expect(app).toEqual([
      { service: 'search', role: 'app', instance: 'search-api-7c9d8-ccccc', container: 'search-api', node: 'worker_1', cpuMilli: 0.104311, memoryBytes: 421888, memoryLimitBytes: null, netIO: null, blockIO: null },
      { service: 'web', role: 'app', instance: 'web-6d4b9c7f8-aaaaa', container: 'web', node: 'worker_1', cpuMilli: 0.25, memoryBytes: 20971520, memoryLimitBytes: 536870912, netIO: null, blockIO: null },
    ]);
    const accessory = await h.backend.stats(ACC);
    expect(accessory.map((row) => [row.service, row.role, row.instance, row.node, row.cpuMilli, row.memoryBytes])).toEqual([
      ['cache', 'accessory', 'cache-7c9d8-ddddd', 'worker_1', 2000, 1e9],
      ['db', 'accessory', 'db-0', 'server_1', 5, 1048576],
    ]);
    expect(h.kube.calls.filter((call) => call.method === 'run')).toHaveLength(1);
  });

  it('U-BE-CONT-10: the recorded metrics-top fixture', async () => {
    const hash = '782lrz9hsf';
    const items: Obj[] = [
      deployment('web'),
      composePod('web', 'app', hash, '6dfnp'),
      composePod('web', 'app', hash, '7fvrw'),
      statefulSet('db', 'accessory', { update: 'db-f45wdkz2dv', current: 'db-f45wdkz2dv' }),
      statefulPod('db', 'accessory', 0, 'db-f45wdkz2dv'),
      helperPod('dockflow-helper-archive-3f9a2c1b'),
    ];
    const h = harness(items, [metricsStep({ fixture: 'metrics/metrics-top' })]);
    expect((await h.backend.stats(APP)).map((row) => [row.instance, row.cpuMilli, row.memoryBytes, row.netIO, row.blockIO])).toEqual([
      [`web-${hash}-6dfnp`, 0.987204, 4059136, null, null],
      [`web-${hash}-7fvrw`, 1.523871, 4280320, null, null],
    ]);
    expect((await h.backend.stats(ACC)).map((row) => [row.service, row.cpuMilli, row.memoryBytes])).toEqual([['db', 0.104311, 421888]]);
  });

  for (const [label, stderr] of [
    ['404', 'Error from server (NotFound): the server could not find the requested resource\n'],
    ['503', 'Error from server (ServiceUnavailable): the server is currently unable to handle the request (get pods.metrics.k8s.io)\n'],
  ]) {
    it(`metrics-server answering ${label} is OrchestratorUnavailableError`, async () => {
      const h = harness(WEB_ITEMS, [metricsStep(result(1, '', stderr))]);
      const error = (await failure(h.backend.stats(APP))) as CLIError;
      expect(error).toBeInstanceOf(OrchestratorUnavailableError);
      expect(error.message).toBe('metrics-server is not available on server_1');
      expect(error.suggestion).toBe(
        'k3s runs metrics-server by default; check it with `dockflow ssh production`, then `k3s kubectl -n kube-system get deploy metrics-server`.',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// logs without --follow
// ---------------------------------------------------------------------------

interface Collected {
  lines: LogLine[];
  warnings: string[];
  sink: { line(line: LogLine): void; warn(message: string): void };
}

function collector(): Collected {
  const lines: LogLine[] = [];
  const warnings: string[] = [];
  return { lines, warnings, sink: { line: (line) => lines.push(line), warn: (message) => warnings.push(message) } };
}

const LOGS = { follow: false, tail: 100 as number | 'all', timestamps: false, includeTerminated: false };

function logsStep(pod: string, flags: string[], respond: KubeStep['respond'], container = 'web'): KubeStep {
  return { method: 'run', namespace: NS, mutating: false, args: ['logs', pod, '-c', container, ...flags], respond };
}

describe('logs', () => {
  it('reads one pod with explicit --timestamps, --tail and --since flags, split into timestamp and text', async () => {
    const h = harness(WEB_ITEMS, [
      logsStep(WEB, ['--timestamps', '--tail=-1', '--since-time=2026-09-17T10:00:00Z'], result(0, '2026-09-17T10:00:01.000000001Z GET /health 200\n2026-09-17T10:00:02Z done\n')),
    ]);
    const out = collector();
    await h.backend.streamLogs(APP, 'web', { ...LOGS, tail: 'all', since: '2026-09-17T10:00:00Z' }, out.sink);
    expect(out.lines).toEqual([
      { service: 'web', instance: WEB, timestamp: '2026-09-17T10:00:01.000000001Z', text: 'GET /health 200' },
      { service: 'web', instance: WEB, timestamp: '2026-09-17T10:00:02Z', text: 'done' },
    ]);
    const call = h.kube.calls.find((c) => c.method === 'run');
    expect(call?.call.requestTimeoutS).toBeNull();
    expect(call?.call.guardS).toBe(300);
    expect(call?.commandString).not.toContain('--request-timeout');
  });

  it('renders durations and days for kubectl', async () => {
    for (const [since, flag] of [
      ['30m', '--since=30m'],
      ['2d', '--since=48h'],
      ['1758100000', '--since-time=2025-09-17T09:06:40Z'],
    ]) {
      const h = harness(WEB_ITEMS, [logsStep(WEB, ['--timestamps', '--tail=100', flag], result(0))]);
      await h.backend.streamLogs(APP, 'web', { ...LOGS, since }, collector().sink);
      h.kube.assertDone();
    }
  });

  it('refuses a bad --since before any call', async () => {
    const h = harness(WEB_ITEMS);
    const error = await failure(h.backend.streamLogs(APP, 'web', { ...LOGS, since: 'yesterday' }, collector().sink));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe(SINCE_ERROR_MESSAGE);
    expect(h.kube.calls).toEqual([]);
  });

  it('U-BE-CONT-07: --previous first, only with includeTerminated and restarts; a missing previous run is ignored', async () => {
    const items = [deployment('web'), webPod('aaaaa', { restarts: 2 }), webPod('bbbbb', { restarts: 1 }), webPod('ccccc')];
    const h = harness(items, [
      logsStep('web-6d4b9c7f8-aaaaa', ['--previous', '--timestamps', '--tail=100'], result(0, '2026-09-17T08:00:00Z crashed\n')),
      logsStep('web-6d4b9c7f8-aaaaa', ['--timestamps', '--tail=100'], result(0, '2026-09-17T09:30:00Z back\n')),
      logsStep(
        'web-6d4b9c7f8-bbbbb',
        ['--previous', '--timestamps', '--tail=100'],
        result(1, '', 'Error from server (BadRequest): previous terminated container "web" in pod "web-6d4b9c7f8-bbbbb" not found\n'),
      ),
      logsStep('web-6d4b9c7f8-bbbbb', ['--timestamps', '--tail=100'], result(0, '2026-09-17T09:10:00Z b\n')),
      logsStep('web-6d4b9c7f8-ccccc', ['--timestamps', '--tail=100'], result(0, '2026-09-17T09:20:00Z c\n')),
    ]);
    const out = collector();
    await h.backend.streamLogs(APP, 'web', { ...LOGS, includeTerminated: true }, out.sink);
    const runs = h.kube.calls.filter((c) => c.method === 'run').map((c) => c.call.args.join(' '));
    expect(runs.indexOf('logs web-6d4b9c7f8-aaaaa -c web --previous --timestamps --tail=100')).toBeLessThan(
      runs.indexOf('logs web-6d4b9c7f8-aaaaa -c web --timestamps --tail=100'),
    );
    expect(runs.filter((r) => r.includes('ccccc'))).toEqual(['logs web-6d4b9c7f8-ccccc -c web --timestamps --tail=100']);
    expect(out.warnings).toEqual([]);
    expect(out.lines.map((l) => l.text)).toEqual(['crashed', 'b', 'c', 'back']);

    const plain = harness(items, [
      logsStep('web-6d4b9c7f8-aaaaa', ['--timestamps', '--tail=100'], result(0)),
      logsStep('web-6d4b9c7f8-bbbbb', ['--timestamps', '--tail=100'], result(0)),
      logsStep('web-6d4b9c7f8-ccccc', ['--timestamps', '--tail=100'], result(0)),
    ]);
    await plain.backend.streamLogs(APP, 'web', LOGS, collector().sink);
  });

  it('warns about a pod whose container has not started', async () => {
    const h = harness([deployment('web'), webPod('aaaaa'), webPod('wwwww', { waiting: 'ContainerCreating' })], [logsStep('web-6d4b9c7f8-aaaaa', ['--timestamps', '--tail=100'], result(0))]);
    const out = collector();
    await h.backend.streamLogs(APP, 'web', LOGS, out.sink);
    expect(out.warnings).toEqual(['web.wwwww is waiting (ContainerCreating); no logs yet']);
  });

  it('reads at most 4 pods at once and merges their lines by timestamp', async () => {
    const suffixes = ['aaaa1', 'aaaa2', 'aaaa3', 'aaaa4', 'aaaa5', 'aaaa6'];
    let active = 0;
    let peak = 0;
    const steps = suffixes.map(
      (suffix, i): KubeStep =>
        logsStep(`web-6d4b9c7f8-${suffix}`, ['--timestamps', '--tail=100'], async () => {
          active += 1;
          peak = Math.max(peak, active);
          for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
          active -= 1;
          return result(0, `2026-09-17T10:00:0${i}Z first ${suffix}\n2026-09-17T10:00:1${5 - i}Z second ${suffix}\n`);
        }),
    );
    const h = harness([deployment('web'), ...suffixes.map((s) => webPod(s))], steps);
    const out = collector();
    await h.backend.streamLogs(APP, 'web', LOGS, out.sink);
    expect(peak).toBe(4);
    const stamps = out.lines.map((l) => l.timestamp ?? '');
    expect(stamps).toEqual([...stamps].sort());
    expect(out.lines).toHaveLength(12);
  });

  it('a service without a readable pod is CONTAINER_NOT_FOUND; the whole role without pods only warns', async () => {
    const h = harness([deployment('web'), webPod('fffff', { phase: 'Failed' })]);
    const error = (await failure(h.backend.streamLogs(APP, 'web', LOGS, collector().sink))) as CLIError;
    expect(error.code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect(error.message).toBe('Service web has no running instance (1 Failed)');
    expect(error.suggestion).toBe('Add `--all-tasks` to include terminated instances, or run `dockflow diagnose production`.');
    // following one service does not wait for pods: only the whole role does
    const followed = (await failure(h.backend.streamLogs(APP, 'web', { ...LOGS, follow: true }, collector().sink))) as CLIError;
    expect(followed.code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    const role = collector();
    await h.backend.streamLogs(APP, null, LOGS, role.sink);
    expect(role.warnings).toEqual([`No application pod is running in namespace ${NS}`]);
  });
});

// ---------------------------------------------------------------------------
// logs --follow
// ---------------------------------------------------------------------------

const FOLLOW = { ...LOGS, follow: true };

function podsStep(selector: string, respond: KubeStep['respond']): KubeStep {
  return { method: 'getJson', namespace: NS, args: ['get', 'pods', '-l', selector, '-o', 'json'], respond, times: 'any' };
}

function settledFlag(promise: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  promise.then(
    () => {
      flag.settled = true;
    },
    () => {
      flag.settled = true;
    },
  );
  return flag;
}

const SERVICE_SELECTOR = `${P}/stack=${NS},${P}/service=web`;
const ROLE_SELECTOR = `${P}/stack=${NS},${P}/role=app`;

describe('logs --follow', () => {
  it('follows a service through one prefixed selector channel; stderr becomes warnings; Ctrl+C resolves', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(
        ['logs', '-f', '-l', SERVICE_SELECTOR, '-c', 'web', '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'],
        result(0, `[pod/${WEB}/web] 2026-09-17T10:00:01Z hello\n[pod/${WEB}/web] 2026-09-17T10:00:02Z [not a prefix] kept\n`, 'error: unexpected EOF\n'),
      ),
      podsStep(SERVICE_SELECTOR, list([webPod('x2x4q')])),
    ]);
    const out = collector();
    const run = h.backend.streamLogs(APP, 'web', FOLLOW, out.sink);
    const flag = settledFlag(run);
    await h.clock.advance(0);
    await h.clock.advance(5000);
    expect(flag.settled).toBe(false);
    expect(out.lines).toEqual([
      { service: 'web', instance: WEB, timestamp: '2026-09-17T10:00:01Z', text: 'hello' },
      { service: 'web', instance: WEB, timestamp: '2026-09-17T10:00:02Z', text: '[not a prefix] kept' },
    ]);
    expect(out.warnings).toEqual(['error: unexpected EOF']);
    h.interrupt();
    await run;
    expect(h.clock.sleeps.every((ms) => ms === 5000)).toBe(true);
  });

  it('follows the whole role without -c, --max-log-requests = pod count above 5', async () => {
    const suffixes = ['bbbb1', 'bbbb2', 'bbbb3', 'bbbb4', 'bbbb5', 'bbbb6', 'bbbb7'];
    const h = harness(
      [deployment('web'), ...suffixes.map((s) => webPod(s))],
      [
        channelStep(['logs', '-f', '-l', ROLE_SELECTOR, '--prefix', '--timestamps', '--tail=100', '--max-log-requests=7', '--ignore-errors'], { hang: true }),
        podsStep(ROLE_SELECTOR, list(suffixes.map((s) => webPod(s)))),
      ],
    );
    const run = h.backend.streamLogs(APP, null, FOLLOW, collector().sink);
    await h.clock.advance(0);
    h.interrupt();
    await run;
    // Ctrl+C closed the channel it opened
    expect(channels(h.kube).every((call) => call.closed === true)).toBe(true);
  });

  it('the watcher opens one channel per new pod with --since-time, never twice, at most 6, warning once', async () => {
    const fresh = (i: number): Obj => webPod(`new0${i}`, { startTime: `2026-09-17T10:0${i}:00Z` });
    let polls = 0;
    const h = harness(WEB_ITEMS, [
      channelStep(['logs', '-f', '-l', SERVICE_SELECTOR, '-c', 'web', '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'], result(0)),
      podsStep(SERVICE_SELECTOR, () => {
        polls += 1;
        const count = polls === 1 ? 1 : 8;
        return result(0, JSON.stringify({ items: [webPod('x2x4q'), ...Array.from({ length: count }, (_, i) => fresh(i + 1))] }));
      }),
      { method: 'channel', args: [/--since-time=/], times: 'any', respond: result(0, `[pod/web-6d4b9c7f8-new01/web] 2026-09-17T10:01:05Z from new pod\n`) },
    ]);
    const out = collector();
    const run = h.backend.streamLogs(APP, 'web', FOLLOW, out.sink);
    await h.clock.advance(0);
    await h.clock.advance(5000);
    const first = channels(h.kube).filter((c) => c.commandString.includes('--since-time='));
    expect(first.map((c) => c.commandString)).toEqual([
      cmd(['logs', '-f', 'web-6d4b9c7f8-new01', '-c', 'web', '--prefix', '--timestamps', '--since-time=2026-09-17T10:01:00Z']),
    ]);
    expect(out.lines).toContainEqual({ service: 'web', instance: 'web-6d4b9c7f8-new01', timestamp: '2026-09-17T10:01:05Z', text: 'from new pod' });
    await h.clock.advance(5000);
    await h.clock.advance(5000);
    const opened = channels(h.kube).filter((c) => c.commandString.includes('--since-time='));
    expect(opened).toHaveLength(6);
    expect(new Set(opened.map((c) => c.commandString)).size).toBe(6);
    expect(out.warnings.filter((w) => w === 'More than 6 new pods appeared; run the command again to follow them')).toHaveLength(1);
    h.interrupt();
    await run;
  });

  it('a throwing sink never breaks the stream, and stderr is redacted', async () => {
    const redactor = new Redactor(['hunter2secret']);
    const h = harness(
      WEB_ITEMS,
      [
        channelStep(
          ['logs', '-f', '-l', SERVICE_SELECTOR, '-c', 'web', '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'],
          result(0, `[pod/${WEB}/web] 2026-09-17T10:00:01Z hello\n`, 'error: token hunter2secret rejected\n'),
        ),
        podsStep(SERVICE_SELECTOR, list([webPod('x2x4q')])),
      ],
      { redactor },
    );
    const warnings: string[] = [];
    const run = h.backend.streamLogs(APP, 'web', FOLLOW, {
      line: () => {
        throw new Error('printer failed');
      },
      warn: (message) => warnings.push(message),
    });
    await h.clock.advance(0);
    expect(warnings).toEqual(['error: token *** rejected']);
    h.interrupt();
    await run;
  });

  it('K64a (U-BE-CONT-05): the whole role adds per-pod channels for Helm pods, 8 shared by every release', async () => {
    const a = ['aaaa1', 'aaaa2', 'aaaa3', 'aaaa4', 'aaaa5'].map((s) => helmPod('alpha', 'alpha', s));
    const b = ['bbbb1', 'bbbb2', 'bbbb3', 'bbbb4', 'bbbb5'].map((s) => helmPod('beta', 'beta', s));
    const items = [
      ...WEB_ITEMS,
      helmDeployment('alpha', 'alpha'),
      helmDeployment('beta', 'beta'),
      helmDeployment('idle', 'idle'),
      helmDeployment('gamma', 'gamma'),
      helmPod('gamma', 'gamma', 'ccccc'),
      ...a,
      ...b,
    ];
    const h = harness(
      items,
      [
        channelStep(['logs', '-f', '-l', ROLE_SELECTOR, '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'], { hang: true }),
        { method: 'channel', args: [/'logs' '-f' '(alpha|beta)-7c9d8-/], times: 'any', respond: { hang: true } },
        podsStep(ROLE_SELECTOR, list([webPod('x2x4q')])),
        podsStep('app.kubernetes.io/instance=alpha', list(a)),
        podsStep('app.kubernetes.io/instance=beta', list(b)),
        podsStep('app.kubernetes.io/instance=idle', list([])),
      ],
      { releases: [release('alpha', 'app'), release('beta', 'app'), release('idle', 'app'), release('gamma', 'accessory')] },
    );
    const out = collector();
    const run = h.backend.streamLogs(APP, null, FOLLOW, out.sink);
    await h.clock.advance(0);
    await h.clock.advance(5000);
    const perPod = channels(h.kube).filter((c) => /'(alpha|beta)-7c9d8-/.test(c.commandString));
    expect(perPod).toHaveLength(8);
    expect(perPod[0].commandString).toBe(cmd(['logs', '-f', 'alpha-7c9d8-aaaa1', '-c', 'alpha', '--timestamps', '--tail=100']));
    expect(channels(h.kube).some((c) => c.commandString.includes('gamma'))).toBe(false);
    expect(out.warnings).toEqual([
      'Helm release idle has no running pod yet; its logs are followed once one starts',
      'Following the first 8 of 10 Helm pods; name a release with `dockflow logs production <release> -f`',
    ]);
    h.interrupt();
    await run;
    expect(channels(h.kube).every((call) => call.closed === true)).toBe(true);
  });

  it('K64a: `logs <env>` and `logs <env> -f` cover the same services', async () => {
    const items = [...WEB_ITEMS, helmDeployment('search', 'search'), helmPod('search', 'search', 'sssss'), helmDeployment('cache', 'cache'), helmPod('cache', 'cache', 'ccccc')];
    const releases = [release('search', 'app'), release('cache', 'app')];
    const once = harness(
      items,
      [
        logsStep(WEB, ['--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:01Z w\n')),
        logsStep('search-7c9d8-sssss', ['--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:02Z s\n'), 'search'),
        logsStep('cache-7c9d8-ccccc', ['--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:03Z c\n'), 'cache'),
      ],
      { releases },
    );
    const read = collector();
    await once.backend.streamLogs(APP, null, LOGS, read.sink);

    const follow = harness(
      items,
      [
        channelStep(['logs', '-f', '-l', ROLE_SELECTOR, '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'], result(0, `[pod/${WEB}/web] 2026-09-17T10:00:01Z w\n`)),
        channelStep(['logs', '-f', 'search-7c9d8-sssss', '-c', 'search', '--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:02Z s\n')),
        channelStep(['logs', '-f', 'cache-7c9d8-ccccc', '-c', 'cache', '--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:03Z c\n')),
        podsStep(ROLE_SELECTOR, list([webPod('x2x4q')])),
        podsStep('app.kubernetes.io/instance=search', list([helmPod('search', 'search', 'sssss')])),
        podsStep('app.kubernetes.io/instance=cache', list([helmPod('cache', 'cache', 'ccccc')])),
      ],
      { releases },
    );
    const followed = collector();
    const run = follow.backend.streamLogs(APP, null, FOLLOW, followed.sink);
    await follow.clock.advance(0);
    follow.interrupt();
    await run;
    const services = (lines: LogLine[]): string[] => [...new Set(lines.map((l) => l.service))].sort();
    expect(services(read.lines)).toEqual(['cache', 'search', 'web']);
    expect(services(followed.lines)).toEqual(services(read.lines));
  });

  it('a Helm release target follows at most 8 pods and says how to pick one', async () => {
    const suffixes = ['p0001', 'p0002', 'p0003', 'p0004', 'p0005', 'p0006', 'p0007', 'p0008', 'p0009'];
    const h = harness(
      [helmDeployment('search-api', 'search'), ...suffixes.map((s) => helmPod('search-api', 'search', s))],
      [
        { method: 'channel', args: [/'logs' '-f' 'search-api-7c9d8-/], times: 'any', respond: { hang: true } },
        podsStep('app.kubernetes.io/instance=search', list(suffixes.map((s) => helmPod('search-api', 'search', s)))),
      ],
      { releases: [release('search', 'app')] },
    );
    const out = collector();
    const run = h.backend.streamLogs(APP, 'search', FOLLOW, out.sink);
    await h.clock.advance(0);
    expect(channels(h.kube)).toHaveLength(8);
    expect(out.warnings).toEqual(['Following the first 8 of 9 pods; name one with `--pick`']);
    h.interrupt();
    await run;
  });

  it('U-BE-CONT-06: the whole role without pods says so once, keeps watching, resolves on Ctrl+C', async () => {
    const h = harness([deployment('web')], [podsStep(ROLE_SELECTOR, list([]))]);
    const out = collector();
    const run = h.backend.streamLogs(APP, null, FOLLOW, out.sink);
    const flag = settledFlag(run);
    await h.clock.advance(0);
    await h.clock.advance(10_000);
    expect(flag.settled).toBe(false);
    expect(out.warnings).toEqual([LOG_IDLE_NOTICE]);
    expect(h.kube.calls.filter((c) => c.method === 'getJson' && c.call.args[1] === 'pods')).toHaveLength(2);
    h.interrupt();
    await run;
  });

  it('a picked instance is followed alone, unprefixed, until its channel ends', async () => {
    const h = harness([deployment('web'), webPod('x2x4q'), webPod('yyyyy')], [
      channelStep(['logs', '-f', WEB, '-c', 'web', '--timestamps', '--tail=100'], result(0, '2026-09-17T10:00:01Z hi\n')),
    ]);
    const out = collector();
    await h.backend.streamLogs(APP, 'web', { ...FOLLOW, instance: WEB }, out.sink);
    expect(out.lines).toEqual([{ service: 'web', instance: WEB, timestamp: '2026-09-17T10:00:01Z', text: 'hi' }]);
    const missing = await failure(h.backend.streamLogs(APP, 'web', { ...FOLLOW, instance: 'db-0' }, collector().sink));
    expect(missing.message).toBe('Instance db-0 does not belong to service web');
  });

  it('a channel lost while following is a ConnectionError', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(['logs', '-f', '-l', SERVICE_SELECTOR, '-c', 'web', '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'], { transportError: true }),
    ]);
    const outcome = failure(h.backend.streamLogs(APP, 'web', FOLLOW, collector().sink));
    await h.clock.advance(0);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe('Lost the connection to server_1 while following logs');
  });

  it('the watcher tolerates two transient poll failures in a row, not a third', async () => {
    const h = harness(WEB_ITEMS, [
      channelStep(['logs', '-f', '-l', SERVICE_SELECTOR, '-c', 'web', '--prefix', '--timestamps', '--tail=100', '--max-log-requests=5', '--ignore-errors'], result(0)),
      { ...podsStep(SERVICE_SELECTOR, { transportError: true }), times: 3 },
    ]);
    const run = h.backend.streamLogs(APP, 'web', FOLLOW, collector().sink);
    const flag = settledFlag(run);
    await h.clock.advance(0);
    await h.clock.advance(10_000);
    expect(flag.settled).toBe(false);
    await h.clock.advance(5000);
    const error = await failure(run);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe('Lost the connection to server_1 while following logs');
  });
});
