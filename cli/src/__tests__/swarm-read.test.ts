import { describe, expect, it } from 'bun:test';
import { PassThrough, type Readable } from 'stream';
import { formatPorts } from '../services/orchestrator/format';
import type {
  ClusterNodeRef,
  LogLine,
  LogSink,
  LogsOptions,
  OrchestratorTarget,
  StackRef,
} from '../services/orchestrator/interfaces';
import { SINCE_ERROR_MESSAGE } from '../services/orchestrator/kubernetes/status/logs';
import { parseNodeLsLine, SwarmClusterBackend } from '../services/orchestrator/swarm/swarm-cluster';
import {
  type CopyFailureReason,
  dockerExecCommand,
  SwarmContainerBackend,
  SwarmCopyError,
} from '../services/orchestrator/swarm/swarm-container';
import { swarmNaming, swarmScope } from '../services/orchestrator/swarm/swarm-naming';
import {
  listSwarmInstances,
  listSwarmServices,
  parseByteSize,
  parseDockerStatsLine,
  parseStackPsLine,
  parseStackPsOutput,
  parseStackServicesLine,
  parseSwarmPorts,
  runSwarmQuery,
  SWARM_NO_EXIT_CODE,
  type SwarmChannel,
  type SwarmExecResult,
  type SwarmSsh,
  swarmServiceState,
} from '../services/orchestrator/swarm/swarm-utils';
import { SwarmVolumeBackend } from '../services/orchestrator/swarm/swarm-volumes';
import {
  CLIError,
  ConnectionError,
  ErrorCode,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
  ValidationError,
} from '../utils/errors';

// ---------------------------------------------------------------------------
// Scripted SSH stub
// ---------------------------------------------------------------------------

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** exec rejects / channel `done` rejects: a lost connection */
  reject?: Error;
}

interface Call {
  kind: 'exec' | 'channel' | 'interactive';
  node: string;
  command: string;
  /** what the backend wrote to a channel's stdin */
  stdin?: string;
}

interface Rule {
  match: RegExp;
  node?: string;
  reply: Reply;
}

/** First matching rule answers; an unscripted command fails the test. */
class ScriptedSsh implements SwarmSsh {
  readonly calls: Call[] = [];
  readonly closed: string[] = [];
  private readonly rules: Rule[] = [];

  on(match: RegExp, reply: Reply, node?: string): this {
    this.rules.push({ match, reply, node });
    return this;
  }

  commands(kind?: Call['kind']): string[] {
    return this.calls.filter((c) => kind === undefined || c.kind === kind).map((c) => c.command);
  }

  private answer(kind: Call['kind'], node: ClusterNodeRef, command: string): { call: Call; reply: Reply } {
    const call: Call = { kind, node: node.name, command };
    this.calls.push(call);
    const rule = this.rules.find((r) => r.match.test(command) && (r.node === undefined || r.node === node.name));
    if (!rule) throw new Error(`unscripted ${kind} on ${node.name}: ${command}`);
    return { call, reply: rule.reply };
  }

  async exec(node: ClusterNodeRef, command: string): Promise<SwarmExecResult> {
    const { reply } = this.answer('exec', node, command);
    if (reply.reject) throw reply.reject;
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  }

  async interactive(node: ClusterNodeRef, command: string): Promise<number> {
    return this.answer('interactive', node, command).reply.exitCode ?? 0;
  }

  /** Answers once the backend ended stdin: output, EOF on both streams, then the exit status. */
  async channel(node: ClusterNodeRef, command: string): Promise<SwarmChannel> {
    const { call, reply } = this.answer('channel', node, command);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Buffer[] = [];
    let settle: (status: { exitCode: number }) => void = () => {};
    const done = new Promise<{ exitCode: number }>((resolve, reject) => {
      settle = resolve;
      stdin.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
      stdin.once('end', () => {
        call.stdin = Buffer.concat(received).toString('utf8');
        if (reply.stdout) stdout.write(reply.stdout);
        stdout.end();
        if (reply.stderr) stderr.write(reply.stderr);
        stderr.end();
        setImmediate(() => (reply.reject ? reject(reply.reject) : resolve({ exitCode: reply.exitCode ?? 0 })));
      });
    });
    done.catch(() => {});
    return {
      stdin,
      stdout,
      stderr,
      done,
      close: () => {
        this.closed.push(command);
        stdout.end();
        stderr.end();
        settle({ exitCode: SWARM_NO_EXIT_CODE });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function nodeRef(name: string, role: 'manager' | 'worker', host: string): ClusterNodeRef {
  return { name, role, host, privateHost: host, connection: { host, port: 22, user: 'deploy', privateKey: 'unused' } };
}

const manager = nodeRef('manager-1', 'manager', '10.0.0.1');
const worker = nodeRef('worker-1', 'worker', '10.0.0.2');

const target: OrchestratorTarget = {
  kind: 'swarm',
  project: 'shop',
  env: 'production',
  stackName: 'shop-production',
  controlPlane: manager,
  managers: [manager],
  workers: [worker],
  probes: [],
};

const app: StackRef = { project: 'shop', env: 'production', role: 'app' };
const accessories: StackRef = { project: 'shop', env: 'production', role: 'accessory' };

const TIMESTAMP = '2026-09-17T10:00:00.123456789Z';

function logOptions(overrides: Partial<LogsOptions> = {}): LogsOptions {
  return { follow: false, tail: 100, timestamps: false, includeTerminated: false, ...overrides };
}

function collectingSink(): LogSink & { lines: LogLine[]; warnings: string[] } {
  const lines: LogLine[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    line: (line) => lines.push(line),
    warn: (message) => warnings.push(message),
  };
}

/** web.2 running on worker-1, its container c0ffee found there only */
function scriptRunningWeb(ssh: ScriptedSsh): ScriptedSsh {
  return ssh
    .on(/^docker stack ps /, { stdout: 'task-web-2|shop-production_web.2|shop-web:1.4.2|worker-1|Running|Running 3 hours ago|\n' })
    .on(/task\.id=task-web-2/, { stdout: 'c0ffee\n' }, 'worker-1')
    .on(/task\.id=task-web-2/, { stdout: '' })
    .on(/service\.name=shop-production_web'/, { stdout: 'c0ffee\n' }, 'worker-1')
    .on(/service\.name=shop-production_web'/, { stdout: '' });
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString('utf8');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('swarmNaming', () => {
  it('names one stack per role and prefixes services with it', () => {
    expect(swarmNaming.scope(app)).toBe('shop-production');
    expect(swarmNaming.scope(accessories)).toBe('shop-production-accessories');
    expect(swarmScope(accessories)).toBe('shop-production-accessories');
    expect(swarmNaming.describe(accessories)).toBe('stack shop-production-accessories');
    expect(swarmNaming.serviceNativeName(app, 'web')).toBe('shop-production_web');
    expect(swarmNaming.serviceNativeName(accessories, 'db')).toBe('shop-production-accessories_db');
  });
});

// ---------------------------------------------------------------------------
// docker stack ps -> InstanceInfo
// ---------------------------------------------------------------------------

describe('parseStackPsLine', () => {
  it('maps a running task; restarts and start time stay unknown (U-SWARM-13)', () => {
    const info = parseStackPsLine(
      'x2x4qabcdefghijklmnopqrst|shop-production_web.2|shop-web:1.4.2|worker-1|Running|Running 3 hours ago|',
      'shop-production',
    );
    expect(info).toEqual({
      id: 'x2x4qabcdefghijklmnopqrst',
      label: 'web.2',
      service: 'web',
      node: 'worker-1',
      status: 'Running 3 hours ago',
      severity: 'ok',
      ready: true,
      restarts: null,
      current: true,
      startedAt: null,
      error: null,
      containers: [],
    });
  });

  it('maps a failed task with its error', () => {
    const info = parseStackPsLine(
      't2|shop-production_web.1|shop-web:1.4.2|worker-1|Shutdown|Failed 2 minutes ago|"task: non-zero exit (1)"',
      'shop-production',
    );
    expect(info).toMatchObject({ severity: 'error', ready: false, current: false, error: 'task: non-zero exit (1)' });
    expect(info?.restarts).toBeNull();
    expect(info?.startedAt).toBeNull();
  });

  it('maps a rejected task as an error and a pending one as a warning', () => {
    const rejected = parseStackPsLine(
      't3|shop-production_web.3|shop-web:1.4.2|worker-1|Shutdown|Rejected 5 seconds ago|"No such image: shop-web:1.4.2"',
      'shop-production',
    );
    expect(rejected).toMatchObject({ severity: 'error', status: 'Rejected 5 seconds ago', error: 'No such image: shop-web:1.4.2' });
    const pending = parseStackPsLine('t4|shop-production_web.4|shop-web:1.4.2||Running|Pending 4 seconds ago|', 'shop-production');
    expect(pending).toMatchObject({ severity: 'warning', ready: false, current: true, node: null, error: null });
  });

  it('extracts service and slot from accessory scopes, never claiming them for the app scope', () => {
    const line = 't5|shop-production-accessories_db.1|postgres:16|manager-1|Running|Running 1 hour ago|';
    expect(parseStackPsLine(line, 'shop-production-accessories')).toMatchObject({ service: 'db', label: 'db.1' });
    expect(parseStackPsLine(line, 'shop-production')).toBeNull();
  });

  it('takes the slot from the last segment and shortens a global task node id', () => {
    expect(parseStackPsLine('t6|shop-production_api.v2.3|img|worker-1|Running|Running 1 minute ago|', 'shop-production')).toMatchObject({
      service: 'api.v2',
      label: 'api.v2.3',
    });
    expect(
      parseStackPsLine('t7|shop-production_agent.k2h3j4k5l6m7n8b9v0c1x2z|img|worker-1|Running|Running 1 minute ago|', 'shop-production'),
    ).toMatchObject({ service: 'agent', label: 'agent.k2h3j4k5l6m7' });
  });

  it('maps a node hostname to its servers.yml key when known', () => {
    const map = new Map([['ip-10-0-0-2', 'worker-1']]);
    expect(parseStackPsLine('t8|shop-production_web.1|img|ip-10-0-0-2|Running|Running 1 minute ago|', 'shop-production', map)?.node).toBe(
      'worker-1',
    );
  });

  it('keeps pipes inside the error and rejects malformed rows', () => {
    expect(parseStackPsLine('t9|shop-production_web.1|img|n|Shutdown|Failed now|"a | b"', 'shop-production')?.error).toBe('a | b');
    expect(parseStackPsLine('garbage', 'shop-production')).toBeNull();
    expect(parseStackPsLine('t|shop-production_web|img|n|Running|Running|', 'shop-production')).toBeNull();
  });
});

describe('listSwarmInstances', () => {
  it('reads tasks with the desired-state and name filters, then filters the name exactly', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack ps /, {
      stdout:
        't1|shop-production_web.1|img|worker-1|Running|Running 1 minute ago|\n' +
        't2|shop-production_web-admin.1|img|worker-1|Running|Running 1 minute ago|\n',
    });
    const instances = await listSwarmInstances(ssh, manager, 'production', 'shop-production', { service: 'web' });
    expect(instances.map((i) => i.id)).toEqual(['t1']);
    expect(ssh.calls).toEqual([
      {
        kind: 'exec',
        node: 'manager-1',
        command:
          "docker stack ps 'shop-production' --no-trunc --filter 'desired-state=running' --filter 'name=shop-production_web' " +
          "--format '{{.ID}}|{{.Name}}|{{.Image}}|{{.Node}}|{{.DesiredState}}|{{.CurrentState}}|{{.Error}}'",
      },
    ]);
  });

  it('includes terminated tasks without the desired-state filter', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack ps /, { stdout: '' });
    await listSwarmInstances(ssh, manager, 'production', 'shop-production', { includeTerminated: true });
    expect(ssh.commands()[0]).not.toContain('desired-state');
  });

  it('reads an empty stack as no instances', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack ps /, { exitCode: 1, stderr: 'nothing found in stack: shop-production\n' });
    expect(await listSwarmInstances(ssh, manager, 'production', 'shop-production')).toEqual([]);
  });

  it('keeps docker order and filters rows of other scopes', () => {
    const rows = parseStackPsOutput(
      't1|shop-production_web.2|img|a|Running|Running|\nt2|other_web.1|img|a|Running|Running|\nt3|shop-production_web.1|img|a|Running|Running|\n',
      'shop-production',
    );
    expect(rows.map((r) => r.id)).toEqual(['t1', 't3']);
  });
});

// ---------------------------------------------------------------------------
// Query errors
// ---------------------------------------------------------------------------

describe('Swarm query errors', () => {
  const query = (reply: Reply): Promise<string | null> =>
    runSwarmQuery(new ScriptedSsh().on(/.*/, reply), manager, 'production', 'docker stack services x', 'docker stack services');

  it('maps a stopped daemon, a missing docker and a non-manager to OrchestratorUnavailableError', async () => {
    const daemon = await rejection(
      query({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }),
    );
    expect(daemon).toBeInstanceOf(OrchestratorUnavailableError);
    expect((daemon as OrchestratorUnavailableError).message).toBe('Docker is not running on manager-1');
    expect((daemon as OrchestratorUnavailableError).suggestion).toBe('Check Docker on manager-1 with `dockflow ssh production`.');

    const missing = await rejection(query({ exitCode: 127, stderr: 'sh: 1: docker: not found' }));
    expect((missing as Error).message).toBe('Docker is not installed on manager-1');

    const notManager = await rejection(query({ exitCode: 1, stderr: 'Error response from daemon: This node is not a swarm manager.' }));
    expect((notManager as Error).message).toBe('manager-1 is not a Swarm manager');

    const other = await rejection(query({ exitCode: 1, stderr: 'Error: something else\nmore' }));
    expect((other as Error).message).toBe('docker stack services failed on manager-1: Error: something else');
  });

  it('maps a lost connection to OrchestratorUnavailableError and an empty stack to null', async () => {
    const lost = await rejection(query({ reject: new Error('Not connected') }));
    expect(lost).toBeInstanceOf(OrchestratorUnavailableError);
    expect((lost as Error).message).toBe('manager-1 did not answer over SSH: Not connected');
    expect(await query({ stderr: 'Nothing found in stack: shop-production\n' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// docker stack services -> ServiceInfo
// ---------------------------------------------------------------------------

describe('parseStackServicesLine', () => {
  it('parses a replicated service with two ports and a range', () => {
    const info = parseStackServicesLine(
      'shop-production_web|replicated|shop-web:1.4.2|2/3|*:8080->80/tcp, *:30000-30002->30000-30002/tcp',
      'shop-production',
      'app',
    );
    expect(info).toEqual({
      name: 'web',
      nativeName: 'shop-production_web',
      kind: 'service',
      role: 'app',
      mode: 'replicated',
      image: 'shop-web:1.4.2',
      replicas: { running: 2, desired: 3 },
      ports: [
        { target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' },
        { target: 30000, published: 30000, protocol: 'tcp', mode: 'ingress' },
        { target: 30001, published: 30001, protocol: 'tcp', mode: 'ingress' },
        { target: 30002, published: 30002, protocol: 'tcp', mode: 'ingress' },
      ],
      state: 'converging',
    });
  });

  it('parses global, job and max-per-node replica counts', () => {
    expect(parseStackServicesLine('shop-production_agent|global|agent:2|3/3|', 'shop-production', 'app')).toMatchObject({
      mode: 'global',
      replicas: { running: 3, desired: 3 },
      state: 'running',
      ports: [],
    });
    expect(
      parseStackServicesLine('shop-production_migrate|replicated job|shop-migrate:1.4|0/1 (1/1 completed)|', 'shop-production', 'app'),
    ).toMatchObject({ mode: 'job', replicas: { running: 1, desired: 1 }, state: 'running' });
    expect(parseStackServicesLine('shop-production_web|replicated|img|1/2 (max 1 per node)|', 'shop-production', 'app')?.replicas).toEqual({
      running: 1,
      desired: 2,
    });
    expect(parseStackServicesLine('shop-production-accessories_db|replicated|postgres:16|0/0|', 'shop-production-accessories', 'accessory')).toMatchObject({
      name: 'db',
      role: 'accessory',
      state: 'stopped',
    });
  });

  it('round-trips docker port texts through formatPorts', () => {
    for (const text of [
      '*:8080->80/tcp',
      '*:8080->80/tcp, *:8443->443/tcp',
      '*:30000-30002->30000-30002/tcp',
      '*:53->53/udp, *:8080->80/tcp',
      '*:8080->80/tcp, *:30000-30002->30000-30002/tcp',
      '',
    ]) {
      expect(formatPorts(parseSwarmPorts(text))).toBe(text);
    }
    expect(parseSwarmPorts('5432/tcp')).toEqual([{ target: 5432, published: null, protocol: 'tcp', mode: 'cluster' }]);
  });

  it('decides a partial service from its running tasks', () => {
    expect(swarmServiceState({ running: 1, desired: 2 }, ['Running 1 minute ago', 'Failed 3 seconds ago'])).toBe('degraded');
    expect(swarmServiceState({ running: 1, desired: 2 }, ['Running 1 minute ago', 'Rejected 3 seconds ago'])).toBe('degraded');
    expect(swarmServiceState({ running: 0, desired: 1 }, ['Starting 1 second ago'])).toBe('converging');
  });
});

describe('listSwarmServices', () => {
  it('inspects the running tasks of partial services only', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services /, {
        stdout: 'shop-production_web|replicated|img|1/2|*:8080->80/tcp\nshop-production_worker|replicated|img|1/1|\n',
      })
      .on(/^docker service ps 'shop-production_web'/, { stdout: 'Running 5 minutes ago\nFailed 2 seconds ago\n' });
    const services = await listSwarmServices(ssh, manager, 'production', 'shop-production', 'app');
    expect(services.map((s) => [s.name, s.state])).toEqual([
      ['web', 'degraded'],
      ['worker', 'running'],
    ]);
    expect(ssh.commands()).toEqual([
      "docker stack services 'shop-production' --format '{{.Name}}|{{.Mode}}|{{.Image}}|{{.Replicas}}|{{.Ports}}'",
      "docker service ps 'shop-production_web' --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null",
    ]);
  });
});

// ---------------------------------------------------------------------------
// docker stats -> ContainerStats
// ---------------------------------------------------------------------------

const STATS_WEB =
  '{"BlockIO":"1.5MB / 0B","CPUPerc":"1.23%","Container":"abc","ID":"abc","MemPerc":"2.27%","MemUsage":"45.2MiB / 1.94GiB","Name":"shop-production_web.2.x2x4qabcdef","NetIO":"1.2kB / 648B","PIDs":"3"}';

describe('parseDockerStatsLine', () => {
  it('fills CPU, memory, Net I/O and Block I/O (U-SWARM-13)', () => {
    expect(parseDockerStatsLine(STATS_WEB, { scope: 'shop-production', role: 'app', node: 'worker-1' })).toEqual({
      service: 'web',
      role: 'app',
      instance: 'x2x4qabcdef',
      container: 'shop-production_web.2.x2x4qabcdef',
      node: 'worker-1',
      cpuMilli: 12.3,
      memoryBytes: Math.round(45.2 * 1024 ** 2),
      memoryLimitBytes: Math.round(1.94 * 1024 ** 3),
      netIO: '1.2kB / 648B',
      blockIO: '1.5MB / 0B',
    });
  });

  it('parses binary and decimal byte units', () => {
    expect(parseByteSize('512B')).toBe(512);
    expect(parseByteSize('1.5KiB')).toBe(1536);
    expect(parseByteSize('2MiB')).toBe(2 * 1024 ** 2);
    expect(parseByteSize('1GiB')).toBe(1024 ** 3);
    expect(parseByteSize('1.2kB')).toBe(1200);
    expect(parseByteSize('3GB')).toBe(3e9);
    expect(parseByteSize('--')).toBeNull();
  });

  it('parses service names with dots and ignores other stacks and bad rows', () => {
    const dotted = STATS_WEB.replace('shop-production_web.2.x2x4qabcdef', 'shop-production_api.v2.1.t9');
    expect(parseDockerStatsLine(dotted, { scope: 'shop-production', role: 'app', node: null })).toMatchObject({
      service: 'api.v2',
      instance: 't9',
    });
    const other = STATS_WEB.replace('shop-production_web', 'other_web');
    expect(parseDockerStatsLine(other, { scope: 'shop-production', role: 'app', node: null })).toBeNull();
    expect(parseDockerStatsLine('not json', { scope: 'shop-production', role: 'app', node: null })).toBeNull();
  });
});

describe('SwarmContainerBackend.stats', () => {
  it('reads every node with the empty-ps guard and sets role and node (U-SWARM-13)', async () => {
    const ssh = new ScriptedSsh().on(/docker stats/, { stdout: `${STATS_WEB}\n` }, 'manager-1').on(/docker stats/, { stdout: '' }, 'worker-1');
    const rows = await new SwarmContainerBackend(target, { ssh }).stats(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'app', node: 'manager-1', netIO: '1.2kB / 648B', blockIO: '1.5MB / 0B' });
    expect(ssh.calls.map((c) => c.node).sort()).toEqual(['manager-1', 'worker-1']);
    expect(ssh.commands()[0]).toBe(
      "ids=$(docker ps -q --filter 'label=com.docker.stack.namespace=shop-production'); " +
        `[ -z "$ids" ] || docker stats --no-stream --format '{{json .}}' $ids`,
    );
  });

  it('reads the accessories stack for the accessory role only', async () => {
    const accessoryRow = STATS_WEB.replace('shop-production_web', 'shop-production-accessories_db');
    const ssh = new ScriptedSsh().on(/docker stats/, { stdout: `${accessoryRow}\n${STATS_WEB}\n` });
    const rows = await new SwarmContainerBackend(target, { ssh }).stats(accessories);
    expect(rows.map((r) => [r.service, r.role])).toEqual([
      ['db', 'accessory'],
      ['db', 'accessory'],
    ]);
    expect(ssh.commands()[0]).toContain("'label=com.docker.stack.namespace=shop-production-accessories'");
  });

  it('keeps the rows of reachable nodes and fails only when every node failed', async () => {
    const partial = new ScriptedSsh()
      .on(/docker stats/, { stdout: `${STATS_WEB}\n` }, 'manager-1')
      .on(/docker stats/, { reject: new Error('Not connected') }, 'worker-1');
    expect(await new SwarmContainerBackend(target, { ssh: partial }).stats(app)).toHaveLength(1);

    const down = new ScriptedSsh().on(/docker stats/, { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' });
    expect(await rejection(new SwarmContainerBackend(target, { ssh: down }).stats(app))).toBeInstanceOf(OrchestratorUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

function streams(stdinText?: string) {
  const stdin = new PassThrough();
  if (stdinText !== undefined) stdin.end(stdinText);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return { io: { stdin, stdout, stderr }, stdout: collect(stdout), stderr: collect(stderr) };
}

describe('dockerExecCommand', () => {
  it('quotes every element', () => {
    expect(dockerExecCommand('c0ffee', ['sh', '-c', "echo 'hi' | wc -l"], { env: { A: 'x y' } })).toBe(
      `docker exec -e 'A=x y' 'c0ffee' 'sh' '-c' 'echo '\\''hi'\\'' | wc -l'`,
    );
  });
});

describe('SwarmContainerBackend.exec', () => {
  it('runs quoted argv and env on the container node, streams output and returns the exit code', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker exec /, { exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
    const { io, stdout, stderr } = streams();
    const code = await new SwarmContainerBackend(target, { ssh }).exec(
      app,
      { service: 'web' },
      { argv: ['sh', '-c', 'ls | wc -l'], env: { GREETING: "it's" }, workdir: '/app', user: 'www-data', tty: false, stdin: false, io },
    );
    expect(code).toBe(3);
    expect(stdout()).toBe('out\n');
    expect(stderr()).toBe('err\n');
    const exec = ssh.calls.find((c) => c.kind === 'channel');
    expect(exec?.node).toBe('worker-1');
    expect(exec?.command).toBe(
      `docker exec -w '/app' -u 'www-data' -e 'GREETING=it'\\''s' 'c0ffee' 'sh' '-c' 'ls | wc -l'`,
    );
  });

  it('adds -i and forwards stdin only when asked', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker exec /, { stdout: '' });
    const backend = new SwarmContainerBackend(target, { ssh });
    await backend.exec(app, { service: 'web' }, { argv: ['psql'], tty: false, stdin: true, io: streams('SELECT 1;\n').io });
    await backend.exec(app, { service: 'web' }, { argv: ['true'], tty: false, stdin: false, io: streams('ignored').io });
    const [withInput, withoutInput] = ssh.calls.filter((c) => c.kind === 'channel');
    expect(withInput.command).toBe("docker exec -i 'c0ffee' 'psql'");
    expect(withInput.stdin).toBe('SELECT 1;\n');
    expect(withoutInput.command).toBe("docker exec 'c0ffee' 'true'");
    expect(withoutInput.stdin).toBe('');
  });

  it('opens a TTY session through the interactive runner', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker exec -it /, { exitCode: 0 });
    await new SwarmContainerBackend(target, { ssh }).exec(app, { service: 'web' }, { argv: ['psql', '-U', 'shop'], tty: true, stdin: true });
    expect(ssh.calls.filter((c) => c.kind === 'interactive')).toEqual([
      { kind: 'interactive', node: 'worker-1', command: "docker exec -it 'c0ffee' 'psql' '-U' 'shop'" },
    ]);
  });

  it('uses the container of the chosen task', async () => {
    const ssh = new ScriptedSsh()
      .on(/task\.id=task-web-3/, { stdout: 'beef\n' }, 'worker-1')
      .on(/task\.id=task-web-3/, { stdout: '' })
      .on(/^docker exec /, {});
    await new SwarmContainerBackend(target, { ssh }).exec(
      app,
      { service: 'web', instance: 'task-web-3' },
      { argv: ['id'], tty: false, stdin: false, io: streams().io },
    );
    expect(ssh.commands('exec')).toContain("docker ps -a --filter 'label=com.docker.swarm.task.id=task-web-3' --format '{{.ID}}' | head -n1");
    expect(ssh.calls.find((c) => c.kind === 'channel')).toMatchObject({ node: 'worker-1', command: "docker exec 'beef' 'id'" });
  });

  it('refuses --container before any remote call (R-21)', async () => {
    const ssh = new ScriptedSsh();
    const error = await rejection(
      new SwarmContainerBackend(target, { ssh }).exec(accessories, { service: 'db', container: 'db' }, { argv: ['id'], tty: false, stdin: false }),
    );
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toBe(
      'dockflow accessories exec --container is not supported with orchestrator: swarm: a Swarm task runs one container',
    );
    expect(ssh.calls).toEqual([]);
  });

  it('reports a service without a running container and a lost connection', async () => {
    const missing = new ScriptedSsh().on(/^docker ps /, { stdout: '' });
    const notFound = await rejection(
      new SwarmContainerBackend(target, { ssh: missing }).exec(app, { service: 'web' }, { argv: ['id'], tty: false, stdin: false, io: streams().io }),
    );
    expect(notFound).toBeInstanceOf(CLIError);
    expect((notFound as CLIError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect((notFound as Error).message).toBe('Service web has no running container');

    const lost = scriptRunningWeb(new ScriptedSsh()).on(/^docker exec /, { reject: new Error('connection lost') });
    const error = await rejection(
      new SwarmContainerBackend(target, { ssh: lost }).exec(app, { service: 'web' }, { argv: ['id'], tty: false, stdin: false, io: streams().io }),
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe('Lost the connection to worker-1 while running a command in web');
  });
});

describe('SwarmContainerBackend shell, interactiveCommand and capture', () => {
  it('picks bash when the image has it, else sh', async () => {
    const withBash = scriptRunningWeb(new ScriptedSsh()).on(/which bash/, { stdout: '/usr/bin/bash\n' }).on(/^docker exec -it /, {});
    await new SwarmContainerBackend(target, { ssh: withBash }).shell(app, { service: 'web' }, 'auto');
    expect(withBash.commands('interactive')).toEqual(["docker exec -it 'c0ffee' '/bin/bash'"]);
    expect(withBash.commands('exec')).toContain("docker exec 'c0ffee' which bash 2>/dev/null || echo not_found");

    const withoutBash = scriptRunningWeb(new ScriptedSsh()).on(/which bash/, { stdout: 'not_found\n' }).on(/^docker exec -it /, {});
    await new SwarmContainerBackend(target, { ssh: withoutBash }).shell(app, { service: 'web' }, 'auto');
    expect(withoutBash.commands('interactive')).toEqual(["docker exec -it 'c0ffee' '/bin/sh'"]);
  });

  it('gives the web terminal the container node and command', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh());
    expect(await new SwarmContainerBackend(target, { ssh }).interactiveCommand(app, { service: 'web' }, '/bin/sh')).toEqual({
      connection: worker.connection,
      command: "docker exec -it 'c0ffee' '/bin/sh'",
    });
  });

  it('captures a buffered command', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker exec 'c0ffee' 'cat'/, { exitCode: 0, stdout: 'appendonly no\n' });
    expect(await new SwarmContainerBackend(target, { ssh }).capture(app, { service: 'web' }, ['cat', '/etc/redis.conf'])).toEqual({
      exitCode: 0,
      stdout: 'appendonly no\n',
      stderr: '',
    });
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe('SwarmContainerBackend.streamLogs', () => {
  const webLogs = (ssh: ScriptedSsh, stdout: string): ScriptedSsh => scriptRunningWeb(ssh).on(/^docker logs /, { stdout });

  it('reads each running task on its node with docker logs', async () => {
    const ssh = webLogs(new ScriptedSsh(), 'started\n\nlistening\n');
    const sink = collectingSink();
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions(), sink);
    expect(ssh.calls.find((c) => c.kind === 'channel')).toMatchObject({ node: 'worker-1', command: "docker logs --tail 100 'c0ffee' 2>&1" });
    expect(sink.lines).toEqual([
      { service: 'web', instance: 'web.2', timestamp: null, text: 'started' },
      { service: 'web', instance: 'web.2', timestamp: null, text: 'listening' },
    ]);
    expect(sink.warnings).toEqual([]);
  });

  it('passes --tail all, -f and --timestamps through', async () => {
    const ssh = webLogs(new ScriptedSsh(), '');
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ tail: 'all', follow: true, timestamps: true }), collectingSink());
    expect(ssh.commands('channel')).toEqual(["docker logs -f --tail all --timestamps 'c0ffee' 2>&1"]);
  });

  it('renders --since in docker grammar through the shared parser (U-SWARM-16)', async () => {
    const cases: [string, string][] = [
      ['2d', "--since '48h'"],
      ['30m', "--since '30m'"],
      ['1h30m', "--since '1h30m'"],
      ['2026-09-17', "--since '2026-09-17T00:00:00Z'"],
      ['2026-09-17T10:00:00+02:00', "--since '2026-09-17T08:00:00Z'"],
      ['1758103200', "--since '1758103200'"],
    ];
    for (const [since, flag] of cases) {
      const ssh = webLogs(new ScriptedSsh(), '');
      await new SwarmContainerBackend(target, { ssh, localOffset: 0 }).streamLogs(app, 'web', logOptions({ since }), collectingSink());
      expect(ssh.commands('channel')).toEqual([`docker logs --tail 100 ${flag} 'c0ffee' 2>&1`]);
    }
  });

  it('refuses a --since the shared parser rejects before any SSH call', async () => {
    const ssh = new ScriptedSsh();
    const error = await rejection(new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ since: '10' }), collectingSink()));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe(SINCE_ERROR_MESSAGE);
    expect(ssh.calls).toEqual([]);
  });

  it('splits the timestamp off docker logs lines only with --timestamps (U-SWARM-16)', async () => {
    const stamped = collectingSink();
    await new SwarmContainerBackend(target, { ssh: webLogs(new ScriptedSsh(), `${TIMESTAMP} GET /\n`) }).streamLogs(
      app,
      'web',
      logOptions({ timestamps: true }),
      stamped,
    );
    expect(stamped.lines).toEqual([{ service: 'web', instance: 'web.2', timestamp: TIMESTAMP, text: 'GET /' }]);

    const verbatim = collectingSink();
    await new SwarmContainerBackend(target, { ssh: webLogs(new ScriptedSsh(), `${TIMESTAMP} GET /\n`) }).streamLogs(
      app,
      'web',
      logOptions(),
      verbatim,
    );
    expect(verbatim.lines).toEqual([{ service: 'web', instance: 'web.2', timestamp: null, text: `${TIMESTAMP} GET /` }]);
  });

  it('strips the docker service logs context on the all-tasks path (U-SWARM-16)', async () => {
    const output =
      `web.2.x2x4q@worker-1    | ${TIMESTAMP} GET /\n` + `2026-09-17T10:00:01.5Z shop-production_web.1.abcd@manager-1    | POST /login\n`;
    const ssh = new ScriptedSsh().on(/^docker service logs /, { stdout: output });
    const sink = collectingSink();
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ includeTerminated: true, timestamps: true }), sink);
    expect(ssh.calls).toEqual([
      {
        kind: 'channel',
        node: 'manager-1',
        command: "docker service logs --tail 100 --timestamps 'shop-production_web' 2>&1",
        stdin: '',
      },
    ]);
    expect(sink.lines).toEqual([
      { service: 'web', instance: 'web.2.x2x4q', timestamp: TIMESTAMP, text: 'GET /' },
      { service: 'web', instance: 'web.1.abcd', timestamp: '2026-09-17T10:00:01.5Z', text: 'POST /login' },
    ]);

    const verbatim = collectingSink();
    const plain = new ScriptedSsh().on(/^docker service logs /, { stdout: 'web.2.x2x4q@worker-1    | GET /\n' });
    await new SwarmContainerBackend(target, { ssh: plain }).streamLogs(app, 'web', logOptions({ includeTerminated: true }), verbatim);
    expect(verbatim.lines).toEqual([{ service: 'web', instance: 'web', timestamp: null, text: 'web.2.x2x4q@worker-1    | GET /' }]);
  });

  it('follows every service of the stack on the all-tasks path without a service', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services /, { stdout: 'shop-production_web|replicated|img|1/1|\nshop-production_worker|replicated|img|1/1|\n' })
      .on(/^docker service logs /, { stdout: '' });
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, null, logOptions({ includeTerminated: true, follow: true }), collectingSink());
    expect(ssh.commands('channel').sort()).toEqual([
      "docker service logs -f --tail 100 'shop-production_web' 2>&1",
      "docker service logs -f --tail 100 'shop-production_worker' 2>&1",
    ]);
  });

  it('reads the chosen task, stopped containers included', async () => {
    const ssh = new ScriptedSsh()
      .on(/task\.id=task-old/, { stdout: 'dead\n' }, 'manager-1')
      .on(/task\.id=task-old/, { stdout: '' })
      .on(/^docker logs /, { stdout: 'bye\n' });
    const sink = collectingSink();
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ instance: 'task-old' }), sink);
    expect(ssh.commands('exec')[0]).toContain('docker ps -a --filter');
    expect(sink.lines).toEqual([{ service: 'web', instance: 'task-old', timestamp: null, text: 'bye' }]);
  });

  it('warns with the unchanged text when a task container is not found', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack ps /, { stdout: 'task-web-9abcdefghij|shop-production_web.1|img|worker-9|Running|Running 1 hour ago|\n' })
      .on(/task\.id=/, { stdout: '' });
    const sink = collectingSink();
    await new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions(), sink);
    expect(sink.warnings).toEqual(['Logs incomplete: container for task task-web-9ab (node worker-9) not found on any reachable node']);
    expect(sink.lines).toEqual([]);
  });

  it('reports a service without running tasks', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack ps /, { exitCode: 1, stderr: 'nothing found in stack: shop-production' });
    const error = await rejection(new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions(), collectingSink()));
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect((error as Error).message).toBe('Service web has no running instance');
    expect((error as CLIError).suggestion).toBe('Add `--all-tasks` to include terminated instances, or run `dockflow ps production`.');
  });

  it('refuses --container before any remote call (R-21)', async () => {
    const ssh = new ScriptedSsh();
    const error = await rejection(
      new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ container: 'web' }), collectingSink()),
    );
    expect((error as Error).message).toBe('dockflow logs --container is not supported with orchestrator: swarm: a Swarm task runs one container');
    expect(ssh.calls).toEqual([]);
  });

  it('turns a lost channel into a ConnectionError', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker logs /, { stdout: 'partial\n', reject: new Error('connection lost') });
    const sink = collectingSink();
    const error = await rejection(new SwarmContainerBackend(target, { ssh }).streamLogs(app, 'web', logOptions({ follow: true }), sink));
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe('Lost the connection to worker-1 while following logs');
  });
});

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

describe('SwarmContainerBackend copy', () => {
  it('streams docker cp out of the container node and ends on success', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker cp /, { stdout: 'TARDATA' });
    const archive = await new SwarmContainerBackend(target, { ssh }).copyOut(app, { service: 'web' }, '/app/logs');
    expect(await readAll(archive)).toBe('TARDATA');
    expect(ssh.calls.find((c) => c.kind === 'channel')).toMatchObject({ node: 'worker-1', command: "docker cp 'c0ffee:/app/logs' -" });
  });

  it('errors the stream after the data when the remote copy failed', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker cp /, {
      exitCode: 1,
      stderr: 'Error response from daemon: Could not find the file /app/missing in container c0ffee\n',
    });
    const archive = await new SwarmContainerBackend(target, { ssh }).copyOut(app, { service: 'web' }, '/app/missing');
    const error = await rejection(readAll(archive));
    expect(error).toBeInstanceOf(SwarmCopyError);
    expect((error as SwarmCopyError).reason).toBe('not-found');
    expect((error as Error).message).toBe('Path /app/missing does not exist in web');
  });

  it('builds copy errors with the injected factory', async () => {
    const reasons: CopyFailureReason[] = [];
    const pathError = (message: string, reason: CopyFailureReason): Error => {
      reasons.push(reason);
      return new Error(message);
    };
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker cp /, { exitCode: 1, stderr: 'Error: permission denied\n' });
    const archive = await new SwarmContainerBackend(target, { ssh, pathError }).copyOut(app, { service: 'web' }, '/root');
    expect(((await rejection(readAll(archive))) as Error).message).toBe('Copying /root out of web failed: Error: permission denied');
    expect(reasons).toEqual(['other']);
  });

  it('closes the channel when the reader stops early', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh());
    ssh.on(/^docker cp /, { stdout: 'TAR' });
    const archive = await new SwarmContainerBackend(target, { ssh }).copyOut(app, { service: 'web' }, '/app');
    archive.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ssh.closed).toEqual(["docker cp 'c0ffee:/app' -"]);
  });

  it('pipes the tar stream into docker cp on the container node', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker cp - /, {});
    const tar = new PassThrough();
    tar.end('TARDATA');
    await new SwarmContainerBackend(target, { ssh }).copyIn(app, { service: 'web' }, '/etc/app', tar);
    expect(ssh.calls.find((c) => c.kind === 'channel')).toMatchObject({
      node: 'worker-1',
      command: "docker cp - 'c0ffee:/etc/app'",
      stdin: 'TARDATA',
    });
  });

  it('reports a failed copy into the container', async () => {
    const ssh = scriptRunningWeb(new ScriptedSsh()).on(/^docker cp - /, {
      exitCode: 1,
      stderr: 'Error response from daemon: Could not find the file /etc/missing in container c0ffee\n',
    });
    const tar = new PassThrough();
    tar.end('TARDATA');
    const error = await rejection(new SwarmContainerBackend(target, { ssh }).copyIn(app, { service: 'web' }, '/etc/missing', tar));
    expect((error as SwarmCopyError).reason).toBe('not-found');
  });

  it('refuses --container for cp (R-21)', async () => {
    const error = await rejection(
      new SwarmContainerBackend(target, { ssh: new ScriptedSsh() }).copyOut(app, { service: 'web', container: 'web' }, '/app'),
    );
    expect((error as Error).message).toBe('dockflow cp --container is not supported with orchestrator: swarm: a Swarm task runs one container');
  });
});

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

const VOLUME_PGDATA =
  '{"Availability":"N/A","Driver":"local","Group":"N/A","Labels":"com.docker.stack.namespace=shop-production-accessories","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/shop-production-accessories_pgdata/_data","Name":"shop-production-accessories_pgdata","Scope":"local","Size":"N/A","Status":"N/A"}';

describe('SwarmVolumeBackend', () => {
  it('lists the volumes of the role stack on the control plane', async () => {
    const ssh = new ScriptedSsh().on(/^docker volume ls /, { stdout: `${VOLUME_PGDATA}\n` });
    const volumes = await new SwarmVolumeBackend(target, { ssh }).list({ project: 'shop', env: 'production', role: 'accessory' });
    expect(volumes).toEqual([
      {
        name: 'shop-production-accessories_pgdata',
        composeName: 'pgdata',
        role: 'accessory',
        phase: 'Unknown',
        capacity: null,
        storageClass: 'local',
        node: 'manager-1',
        reclaimPolicy: null,
        usedBy: [],
        hostPath: '/var/lib/docker/volumes/shop-production-accessories_pgdata/_data',
      },
    ]);
    expect(ssh.calls).toEqual([
      {
        kind: 'exec',
        node: 'manager-1',
        command: "docker volume ls --filter 'label=com.docker.stack.namespace=shop-production-accessories' --format '{{json .}}'",
      },
    ]);
  });

  it('lists both stacks when no role is given and nothing for a namespace override', async () => {
    const ssh = new ScriptedSsh().on(/^docker volume ls /, { stdout: '' });
    const backend = new SwarmVolumeBackend(target, { ssh });
    expect(await backend.list({ project: 'shop', env: 'production', role: null })).toEqual([]);
    expect(ssh.commands().map((c) => /namespace=([^']+)/.exec(c)?.[1])).toEqual(['shop-production', 'shop-production-accessories']);
    expect(await backend.list({ project: 'shop', env: 'production', role: null, namespace: 'dockflow-system' })).toEqual([]);
    expect(ssh.calls).toHaveLength(2);
  });

  it('refuses removal with the volumes capability text (R-05)', async () => {
    const ssh = new ScriptedSsh();
    const error = await rejection(new SwarmVolumeBackend(target, { ssh }).remove({ project: 'shop', env: 'production', role: 'accessory' }, ['pgdata']));
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toBe('dockflow volumes rm is not supported with orchestrator: swarm');
    expect((error as UnsupportedOperationError).suggestion).toBe(
      'List Swarm volumes on a node with `dockflow ssh <env>`, then `docker volume ls`.',
    );
    expect(ssh.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

describe('SwarmClusterBackend', () => {
  const probeWith = (ssh: ScriptedSsh) => new SwarmClusterBackend(target, { ssh }).probe(manager);

  it('probes with docker info then the leader flag', async () => {
    const leader = new ScriptedSsh().on(/^docker info /, { stdout: 'true\n' }).on(/^docker node inspect self /, { stdout: 'true\n' });
    expect(await probeWith(leader)).toEqual({ node: 'manager-1', status: 'leader' });
    expect(leader.commands()).toEqual([
      'docker info --format "{{.Swarm.ControlAvailable}}" 2>/dev/null || echo "error"',
      'docker node inspect self --format "{{.ManagerStatus.Leader}}" 2>/dev/null || echo "false"',
    ]);

    const follower = new ScriptedSsh().on(/^docker info /, { stdout: 'true\n' }).on(/^docker node inspect self /, { stdout: 'false\n' });
    expect(await probeWith(follower)).toEqual({ node: 'manager-1', status: 'ready' });
  });

  it('reports nodes that cannot take orchestrator commands', async () => {
    expect((await probeWith(new ScriptedSsh().on(/^docker info /, { stdout: 'false\n' }))).status).toBe('unready');
    expect((await probeWith(new ScriptedSsh().on(/^docker info /, { stdout: 'error\n' }))).status).toBe('unreachable');
    expect(await probeWith(new ScriptedSsh().on(/^docker info /, { reject: new Error('connect ECONNREFUSED') }))).toEqual({
      node: 'manager-1',
      status: 'unreachable',
      detail: 'connect ECONNREFUSED',
    });
  });

  it('lists nodes with docker node ls', async () => {
    const ssh = new ScriptedSsh().on(/^docker node ls /, {
      stdout:
        '{"Availability":"Active","EngineVersion":"27.3.1","Hostname":"manager-1","ID":"a","ManagerStatus":"Leader","Self":true,"Status":"Ready","TLSStatus":"Ready"}\n' +
        '{"Availability":"Drain","EngineVersion":"27.3.1","Hostname":"ip-10-0-0-9","ID":"b","ManagerStatus":"","Self":false,"Status":"Down","TLSStatus":"Ready"}\n',
    });
    expect(await new SwarmClusterBackend(target, { ssh }).nodes()).toEqual([
      {
        name: 'manager-1',
        server: 'manager-1',
        role: 'manager',
        ready: true,
        schedulable: true,
        version: '27.3.1',
        internalIp: null,
        pressure: [],
      },
      {
        name: 'ip-10-0-0-9',
        server: null,
        role: 'worker',
        ready: false,
        schedulable: false,
        version: '27.3.1',
        internalIp: null,
        pressure: [],
      },
    ]);
    expect(ssh.commands()).toEqual(["docker node ls --format '{{json .}}'"]);
    expect(parseNodeLsLine('not json', new Map())).toBeNull();
  });

  it('reads the server version and needs no preflight', async () => {
    const ssh = new ScriptedSsh().on(/^docker version /, { stdout: '27.3.1\n' });
    const backend = new SwarmClusterBackend(target, { ssh });
    expect(await backend.serverVersion()).toBe('27.3.1');
    await backend.preflight({ routes: true, volumes: true, helm: false });
    expect(ssh.calls).toHaveLength(1);
  });
});
