import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'stream';
import { loadFromString, type ParsedCompose } from '../services/compose';
import type {
  ClusterNodeRef,
  DeployReceipt,
  OrchestratorTarget,
  StackArtifact,
  StackDeployInput,
  StackRef,
  StackRole,
} from '../services/orchestrator/interfaces';
import {
  buildSwarmDiagnosticReport,
  SWARM_ARTIFACT_HEADER,
  SwarmStackBackend,
} from '../services/orchestrator/swarm/swarm-stack';
import type { SwarmClock } from '../services/orchestrator/swarm/swarm-stack-ops';
import type { SwarmChannel, SwarmExecResult, SwarmSsh } from '../services/orchestrator/swarm/swarm-utils';
import { DeployError, ErrorCode } from '../utils/errors';

// ---------------------------------------------------------------------------
// Scripted SSH stub and fake clock
// ---------------------------------------------------------------------------

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** a lost connection */
  reject?: Error;
}

interface Call {
  kind: 'exec' | 'channel';
  command: string;
  /** what the backend wrote to a channel's stdin */
  stdin?: string;
}

type Answer = Reply | ((command: string) => Reply);

/** First matching rule answers; an unscripted command fails the test. */
class ScriptedSsh implements SwarmSsh {
  readonly calls: Call[] = [];
  private readonly rules: { match: RegExp; answer: Answer }[] = [];

  on(match: RegExp, answer: Answer): this {
    this.rules.push({ match, answer });
    return this;
  }

  commands(kind?: Call['kind']): string[] {
    return this.calls.filter((call) => kind === undefined || call.kind === kind).map((call) => call.command);
  }

  private answer(kind: Call['kind'], command: string): { call: Call; reply: Reply } {
    const call: Call = { kind, command };
    this.calls.push(call);
    const rule = this.rules.find((r) => r.match.test(command));
    if (!rule) throw new Error(`unscripted ${kind}: ${command}`);
    return { call, reply: typeof rule.answer === 'function' ? rule.answer(command) : rule.answer };
  }

  async exec(_node: ClusterNodeRef, command: string): Promise<SwarmExecResult> {
    const { reply } = this.answer('exec', command);
    if (reply.reject) throw reply.reject;
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  }

  async interactive(_node: ClusterNodeRef, command: string): Promise<number> {
    throw new Error(`unexpected interactive session: ${command}`);
  }

  async channel(_node: ClusterNodeRef, command: string): Promise<SwarmChannel> {
    const { call, reply } = this.answer('channel', command);
    if (reply.reject) throw reply.reject;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Buffer[] = [];
    const done = new Promise<{ exitCode: number }>((resolve) => {
      stdin.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
      stdin.once('end', () => {
        call.stdin = Buffer.concat(received).toString('utf8');
        if (reply.stdout) stdout.write(reply.stdout);
        stdout.end();
        if (reply.stderr) stderr.write(reply.stderr);
        stderr.end();
        setImmediate(() => resolve({ exitCode: reply.exitCode ?? 0 }));
      });
    });
    return { stdin, stdout, stderr, done, close: () => {} };
  }
}

class FakeClock implements SwarmClock {
  readonly sleeps: number[] = [];
  constructor(private t = Date.parse('2026-09-19T12:00:00Z')) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const manager: ClusterNodeRef = {
  name: 'manager-1',
  role: 'manager',
  host: '10.0.0.1',
  privateHost: '10.0.0.1',
  connection: { host: '10.0.0.1', port: 22, user: 'deploy', privateKey: 'unused' },
};

const target: OrchestratorTarget = {
  kind: 'swarm',
  project: 'shop',
  env: 'production',
  stackName: 'shop-production',
  controlPlane: manager,
  managers: [manager],
  workers: [],
  probes: [],
};

const appRef: StackRef = { project: 'shop', env: 'production', role: 'app' };
const accessoryRef: StackRef = { project: 'shop', env: 'production', role: 'accessory' };

const APP_COMPOSE = [
  'services:',
  '  web:',
  '    image: web:1',
  '    build:',
  '      context: .',
  '    networks: [front, back]',
  '    volumes: ["data:/data"]',
  '  worker:',
  '    image: worker:1',
  'networks:',
  '  front:',
  '    external: true',
  '    name: shop front',
  '  back:',
  '    external: true',
  'volumes:',
  '  data:',
  '    external: true',
  "    name: shop's data",
  '',
].join('\n');

const ACCESSORIES_COMPOSE = 'services:\n  db:\n    image: postgres:16\n    deploy:\n      replicas: 1\n';

function input(role: StackRole, compose: ParsedCompose, overrides: Partial<StackDeployInput> = {}): StackDeployInput {
  return {
    ref: role === 'app' ? appRef : accessoryRef,
    version: '1.4.2',
    compose,
    proxy: undefined,
    services: null,
    previousVersion: '1.4.1',
    force: false,
    images: { built: [], mode: 'none', pullSecretName: null },
    helm: [],
    helmDeclared: ['search'],
    sibling: { services: [], volumes: [], middlewares: [] },
    serverNames: ['manager-1'],
    files: () => ({ ok: false, reason: 'missing' }),
    rebindVolumes: false,
    traefikOnCluster: false,
    ...overrides,
  };
}

const appInput = (overrides: Partial<StackDeployInput> = {}): StackDeployInput =>
  input('app', loadFromString(APP_COMPOSE), overrides);
const accessoryInput = (overrides: Partial<StackDeployInput> = {}): StackDeployInput =>
  input('accessory', loadFromString(ACCESSORIES_COMPOSE), overrides);

/** Answers every command a successful `docker stack deploy` issues. */
function deployable(ssh: ScriptedSsh): ScriptedSsh {
  return ssh
    .on(/^docker network create /, {})
    .on(/^docker volume create /, {})
    .on(/^docker stack services '[^']+' --format '\{\{\.Name\}\}' 2>\/dev\/null \|\| true$/, { stdout: '' })
    .on(/^docker stack deploy /, {})
    .on(/^docker stack ls --format '\{\{\.Name\}\}' \| grep -xF /, (command) => ({
      stdout: `${/grep -xF '([^']+)'/.exec(command)?.[1] ?? ''}\n`,
    }))
    .on(/^docker compose -f - pull/, {});
}

function setup(ssh = new ScriptedSsh()): { ssh: ScriptedSsh; clock: FakeClock; backend: SwarmStackBackend } {
  const clock = new FakeClock();
  return { ssh, clock, backend: new SwarmStackBackend(target, { ssh, clock }) };
}

async function deployed(backend: SwarmStackBackend, deployInput: StackDeployInput): Promise<DeployReceipt> {
  const result = await backend.deploy(deployInput);
  if (!result.success) throw result.error;
  return result.data;
}

const HASH_FILE = '/var/lib/dockflow/accessories/shop-production/.hash';

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

describe('SwarmStackBackend.deploy (application)', () => {
  it('creates external networks and volumes by their name:, shell-quoted (U-SWARM-07)', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));

    await deployed(backend, appInput());

    const created = ssh.commands('exec').filter((c) => / (network|volume) create /.test(c));
    expect(created.sort()).toEqual(
      [
        "docker network create --driver overlay --attachable 'back' 2>/dev/null || true",
        "docker network create --driver overlay --attachable 'shop front' 2>/dev/null || true",
        "docker volume create 'shop'\\''s data' 2>/dev/null || true",
      ].sort(),
    );
  });

  it('pipes the rendered artifact to docker stack deploy with prune and registry auth', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));
    const deployInput = appInput();
    const artifact = backend.render(deployInput);

    await deployed(backend, deployInput);

    const deploy = ssh.calls.find((c) => c.kind === 'channel');
    expect(deploy?.command).toBe("docker stack deploy --prune --with-registry-auth -c - 'shop-production'");
    expect(deploy?.stdin).toBe(artifact.content);
    expect(deploy?.stdin?.startsWith(`${SWARM_ARTIFACT_HEADER}\n`)).toBe(true);
  });

  it('returns a receipt with no workload changes and the digest of the whole stack', async () => {
    const { backend, clock } = setup(deployable(new ScriptedSsh()));
    const deployInput = appInput();

    const receipt = await deployed(backend, deployInput);

    expect(receipt).toEqual({
      ref: appRef,
      version: '1.4.2',
      startedAt: new Date(clock.now()),
      services: null,
      skipped: false,
      artifactDigest: backend.render(deployInput).digest,
      changes: [],
      helm: [],
      helmChanges: [],
      helmDeclared: ['search'],
      previousVersion: '1.4.1',
    });
  });

  it('reports the apply as started right before docker stack deploy is issued', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));
    const progress: string[] = [];

    await deployed(
      backend,
      appInput({
        onApplyProgress: (p) => {
          progress.push(`${p.kind} after ${ssh.commands('channel').length} deploy(s)`);
        },
      }),
    );

    expect(progress).toEqual(['started after 0 deploy(s)']);
  });

  it('deploys only the targeted services without pruning under --only', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));

    const receipt = await deployed(backend, appInput({ services: ['worker'] }));

    const deploy = ssh.calls.find((c) => c.kind === 'channel');
    expect(deploy?.command).toBe("docker stack deploy --with-registry-auth -c - 'shop-production'");
    const sent = loadFromString(deploy?.stdin ?? '');
    expect(Object.keys(sent.services)).toEqual(['worker']);
    expect(deploy?.stdin?.startsWith(`${SWARM_ARTIFACT_HEADER}\n`)).toBe(true);
    expect(receipt.services).toEqual(['worker']);
    // the release still stores every service
    expect(receipt.artifactDigest).toBe(backend.render(appInput()).digest);
  });

  it('removes a stack whose services are stuck before deploying it again', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services 'shop-production' --format '\{\{\.Name\}\}' 2>\/dev\/null \|\| true$/, {
        stdout: 'shop-production_web\n',
      })
      .on(/^docker service inspect 'shop-production_web' --format '\{\{json \.UpdateStatus\}\}'/, {
        stdout: '{"State":"rollback_paused"}',
      })
      .on(/^docker stack rm 'shop-production'$/, {})
      .on(/^docker stack ls --format '\{\{\.Name\}\}' \| grep -xF 'shop-production'/, () => ({
        // gone once removed, back once deployed
        stdout: ssh.commands('channel').length > 0 ? 'shop-production\n' : '',
      }));
    deployable(ssh);
    const { backend, clock } = setup(ssh);

    await deployed(backend, appInput());

    const rm = ssh.commands().indexOf("docker stack rm 'shop-production'");
    const deploy = ssh.commands().findIndex((c) => c.startsWith('docker stack deploy'));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(deploy);
    expect(clock.sleeps).toContain(3000);
  });

  it('turns a failed docker stack deploy into a DeployError result', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack deploy /, { exitCode: 1, stderr: 'network front not found\n' });
    const { backend } = setup(deployable(ssh));

    const result = await backend.deploy(appInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(DeployError);
    expect(result.error.message).toBe('docker stack deploy failed (exit 1): network front not found');
    expect(result.error.code).toBe(ErrorCode.DEPLOY_FAILED);
  });

  it('keeps the class of transport failures as a DeployError result', async () => {
    const ssh = new ScriptedSsh().on(/./, { reject: new Error('connection reset') });
    const { backend } = setup(ssh);

    const result = await backend.deploy(appInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(DeployError);
    expect(result.error.code).toBe(ErrorCode.ORCHESTRATOR_UNAVAILABLE);
    expect(result.error.message).toContain('manager-1 did not answer over SSH: connection reset');
  });
});

describe('SwarmStackBackend.deploy (accessories)', () => {
  it('skips truthfully when the recorded hash equals the artifact digest, with no remote change', async () => {
    const { ssh, backend } = setup();
    const deployInput = accessoryInput();
    const digest = backend.render(deployInput).digest;
    ssh.on(/^cat '\/var\/lib\/dockflow\/accessories\/shop-production\/\.hash'/, { stdout: `${digest}\n` });

    const receipt = await deployed(backend, deployInput);

    expect(receipt.skipped).toBe(true);
    expect(receipt.ref).toEqual(accessoryRef);
    expect(receipt.artifactDigest).toBe(digest);
    expect(ssh.commands()).toEqual([`cat '${HASH_FILE}' 2>/dev/null || echo ""`]);
  });

  it('deploys when the hash differs, and records it only in finalize', async () => {
    const ssh = new ScriptedSsh()
      .on(/^cat '\/var\/lib\/dockflow\/accessories\/shop-production\/\.hash'/, { stdout: 'outdated\n' })
      .on(/^mkdir -p /, {});
    const { backend } = setup(deployable(ssh));
    const deployInput = accessoryInput();
    const artifact = backend.render(deployInput);

    const receipt = await deployed(backend, deployInput);

    expect(receipt.skipped).toBe(false);
    const channels = ssh.calls.filter((c) => c.kind === 'channel');
    expect(channels.map((c) => c.command)).toEqual([
      'docker compose -f - pull 2>/dev/null || true',
      "docker stack deploy --prune --with-registry-auth -c - 'shop-production-accessories'",
    ]);
    expect(channels[1].stdin).toBe(artifact.content);
    expect(ssh.commands().some((c) => c.startsWith('mkdir -p'))).toBe(false);

    await backend.finalize(receipt);

    expect(ssh.commands().at(-1)).toBe(
      `mkdir -p '/var/lib/dockflow/accessories/shop-production' && printf '%s\\n' '${artifact.digest}' > '${HASH_FILE}'`,
    );
  });

  it('deploys with force even when the hash matches', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));

    const receipt = await deployed(backend, accessoryInput({ force: true }));

    expect(receipt.skipped).toBe(false);
    expect(ssh.commands().some((c) => c.startsWith('cat '))).toBe(false);
    expect(ssh.commands('channel')).toContain(
      "docker stack deploy --prune --with-registry-auth -c - 'shop-production-accessories'",
    );
  });
});

// ---------------------------------------------------------------------------
// apply and finalize (rollbacks)
// ---------------------------------------------------------------------------

function storedArtifact(backend: SwarmStackBackend): StackArtifact {
  const { diagnostics: _diagnostics, ...stored } = backend.render(appInput());
  return { ...stored, diagnostics: [] };
}

describe('SwarmStackBackend.apply', () => {
  it('redeploys a stored release with prune and returns an apply receipt', async () => {
    const { ssh, backend, clock } = setup(deployable(new ScriptedSsh()));
    const artifact = storedArtifact(backend);

    const result = await backend.apply(appRef, '1.4.1', artifact, { prune: true, services: null });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      ref: appRef,
      version: '1.4.1',
      startedAt: new Date(clock.now()),
      services: null,
      skipped: false,
      artifactDigest: artifact.digest,
      changes: [],
      helm: [],
      helmChanges: [],
      helmDeclared: [],
      previousVersion: null,
    });
    const deploy = ssh.calls.find((c) => c.kind === 'channel');
    expect(deploy?.command).toBe("docker stack deploy --prune --with-registry-auth -c - 'shop-production'");
    expect(deploy?.stdin).toBe(artifact.content);
  });

  it('applies a release written before the header existed as it is', async () => {
    const { ssh, backend } = setup(deployable(new ScriptedSsh()));
    const content = 'services:\n  web:\n    image: web:0.9\n';

    await backend.apply(
      appRef,
      '0.9.0',
      { format: 'swarm-compose/1', role: 'app', content, helm: [], diagnostics: [], digest: 'x' },
      { prune: true, services: null },
    );

    expect(ssh.calls.find((c) => c.kind === 'channel')?.stdin).toBe(content);
  });

  it('refuses an artifact produced for another orchestrator before any remote call', async () => {
    const { ssh, backend } = setup();

    const result = await backend.apply(
      appRef,
      '1.4.1',
      { format: 'k8s-manifests/1', role: 'app', content: '', helm: [], diagnostics: [], digest: 'x' },
      { prune: true, services: null },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect(result.error.message).toBe(
      'Release 1.4.1 was produced for k8s-manifests/1 and cannot be applied with orchestrator: swarm',
    );
    expect(ssh.calls).toEqual([]);
  });
});

describe('SwarmStackBackend.finalize (U-SWARM-10)', () => {
  it('is a no-op for an application receipt of apply(): no remote call, never throws', async () => {
    const ssh = deployable(new ScriptedSsh());
    const { backend } = setup(ssh);
    const applied = await backend.apply(appRef, '1.4.1', storedArtifact(backend), { prune: true, services: null });
    if (!applied.success) throw applied.error;
    const before = ssh.calls.length;
    // any remote call from now on would fail
    ssh.on(/./, { reject: new Error('no remote call expected') });

    await expect(backend.finalize(applied.data)).resolves.toBeUndefined();

    expect(ssh.calls.length).toBe(before);
  });

  it('is a no-op for an application deploy receipt', async () => {
    const ssh = deployable(new ScriptedSsh());
    const { backend } = setup(ssh);
    const receipt = await deployed(backend, appInput());
    const before = ssh.calls.length;

    await backend.finalize(receipt);

    expect(ssh.calls.length).toBe(before);
  });

  it('never throws when the accessories hash cannot be written', async () => {
    const ssh = deployable(new ScriptedSsh()).on(/^mkdir -p /, { exitCode: 1, stderr: 'Permission denied' });
    const { backend } = setup(ssh);
    const receipt = await deployed(backend, accessoryInput({ force: true }));

    await expect(backend.finalize(receipt)).resolves.toBeUndefined();
    // written once: a second finalize of the same receipt does nothing
    await backend.finalize(receipt);
    expect(ssh.commands().filter((c) => c.startsWith('mkdir -p'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// waitConvergence, checkHealth, revert
// ---------------------------------------------------------------------------

const REPLICAS = /^docker stack services 'shop-production' --format '\{\{\.Name\}\}\t\{\{\.Replicas\}\}'/;
const UPDATE_STATES = /^for svc in /;

function receiptOf(ref: StackRef, services: string[] | null = null, startedAt = new Date(0)): DeployReceipt {
  return {
    ref,
    version: '1.4.2',
    startedAt,
    services,
    skipped: false,
    artifactDigest: 'x',
    changes: [],
    helm: [],
    helmChanges: [],
    helmDeclared: [],
    previousVersion: '1.4.1',
  };
}

describe('SwarmStackBackend.waitConvergence', () => {
  it('converges once every replica runs and no update is in progress', async () => {
    const ssh = new ScriptedSsh()
      .on(REPLICAS, { stdout: 'shop-production_web\t2/2\nshop-production_worker\t1/1\n' })
      .on(UPDATE_STATES, { stdout: 'shop-production_web\tcompleted\nshop-production_worker\t\n' });
    const { backend } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(appRef), { timeoutS: 60, intervalS: 5 });

    expect(result).toEqual({ status: 'converged', failures: [] });
    const states = ssh.commands().find((c) => UPDATE_STATES.test(c));
    expect(states).toContain("for svc in 'shop-production_web' 'shop-production_worker'; do");
  });

  it('maps a Swarm rollback to reverted, naming the compose service', async () => {
    const ssh = new ScriptedSsh()
      .on(REPLICAS, { stdout: 'shop-production_web\t1/2\n' })
      .on(UPDATE_STATES, { stdout: 'shop-production_web\trollback_started\n' })
      .on(/--filter 'desired-state=shutdown'/, { stdout: 'shop-production_web.2|task: non-zero exit (1)\n' });
    const { backend } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(appRef), { timeoutS: 60, intervalS: 5 });

    expect(result.status).toBe('reverted');
    expect(result.message).toBe(
      'Swarm auto-rolled back services: shop-production_web\n\nFailed tasks:\n  shop-production_web.2: task: non-zero exit (1)',
    );
    expect(result.suggestion).toBe('The new version failed Swarm health checks. Check service logs for details.');
    expect(result.failures).toEqual([
      { service: 'web', reason: 'TaskFailed', message: 'Swarm rolled back shop-production_web' },
    ]);
  });

  it('maps a paused update to failed', async () => {
    const ssh = new ScriptedSsh()
      .on(REPLICAS, { stdout: 'shop-production_web\t0/1\n' })
      .on(UPDATE_STATES, { stdout: 'shop-production_web\tpaused\n' })
      .on(/--filter 'desired-state=shutdown'/, { stdout: '' });
    const { backend } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(appRef), { timeoutS: 60, intervalS: 5 });

    expect(result.status).toBe('failed');
    expect(result.message).toBe('Services stuck in paused: shop-production_web');
    expect(result.suggestion).toBe('Try `dockflow deploy --force` to force a fresh deployment.');
    expect(result.failures.map((f) => [f.service, f.reason])).toEqual([['web', 'Paused']]);
  });

  it('maps an exhausted deadline to timeout, polling at the requested interval', async () => {
    const ssh = new ScriptedSsh()
      .on(REPLICAS, { stdout: 'shop-production_web\t0/1\nshop-production_worker\t1/1\n' })
      .on(UPDATE_STATES, { stdout: '' });
    const { backend, clock } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(appRef), { timeoutS: 20, intervalS: 5 });

    expect(result.status).toBe('timeout');
    expect(result.message).toBe(
      'deployment convergence timeout after 20s. Non-converged services: shop-production_web 0/1',
    );
    expect(result.failures).toEqual([{ service: 'web', reason: 'Timeout', message: 'shop-production_web 0/1' }]);
    expect(clock.sleeps).toEqual([5000, 5000, 5000, 5000]);
  });

  it('waits only for the --only services of the receipt', async () => {
    const ssh = new ScriptedSsh()
      .on(REPLICAS, { stdout: 'shop-production_web\t0/1\nshop-production_worker\t1/1\n' })
      .on(UPDATE_STATES, { stdout: '' });
    const { backend } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(appRef, ['worker']), { timeoutS: 60, intervalS: 5 });

    expect(result.status).toBe('converged');
  });

  it('never throws: a lost connection is a failed convergence', async () => {
    const { backend } = setup(new ScriptedSsh().on(/./, { reject: new Error('connection reset') }));

    const result = await backend.waitConvergence(receiptOf(appRef), { timeoutS: 60, intervalS: 5 });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('connection reset');
  });

  it('waits on the accessories stack for an accessory receipt', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services 'shop-production-accessories' --format/, { stdout: 'shop-production-accessories_db\t1/1\n' })
      .on(UPDATE_STATES, { stdout: '' });
    const { backend } = setup(ssh);

    const result = await backend.waitConvergence(receiptOf(accessoryRef), { timeoutS: 60, intervalS: 5 });

    expect(result.status).toBe('converged');
  });
});

describe('SwarmStackBackend.checkHealth', () => {
  const LIST = /^docker stack services 'shop-production' --format '\{\{\.Name\}\}' 2>\/dev\/null \|\| echo ""$/;
  const INSPECT = /^docker service inspect 'shop-production_web' --format '\{\{if \.UpdateStatus\}\}/;
  const TASKS = /^docker service ps 'shop-production_web' --filter 'desired-state=running'/;
  const options = { timeoutS: 30, intervalS: 5, stabilityS: 10 };

  it('is healthy when every running task is Running', async () => {
    const ssh = new ScriptedSsh()
      .on(LIST, { stdout: 'shop-production_web\n' })
      .on(INSPECT, { stdout: '' })
      .on(TASKS, { stdout: 'Running 2 minutes ago\nRunning 2 minutes ago\n' });
    const { backend } = setup(ssh);

    expect(await backend.checkHealth(receiptOf(appRef), options)).toEqual({
      healthy: true,
      rolledBack: false,
      failures: [],
    });
  });

  it('reports a rollback completed after the deploy started', async () => {
    const ssh = new ScriptedSsh()
      .on(LIST, { stdout: 'shop-production_web\n' })
      .on(INSPECT, { stdout: 'rollback_completed|2026-09-19T12:00:30Z' });
    const { backend } = setup(ssh);

    const result = await backend.checkHealth(receiptOf(appRef, null, new Date('2026-09-19T12:00:00Z')), options);

    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.message).toBe('Swarm auto-rolled back: shop-production_web');
    expect(result.failures.map((f) => f.service)).toEqual(['web']);
  });

  it('ignores a rollback left by an earlier deploy', async () => {
    const ssh = new ScriptedSsh()
      .on(LIST, { stdout: 'shop-production_web\n' })
      .on(INSPECT, { stdout: 'rollback_completed|2026-09-18T08:00:00Z' })
      .on(TASKS, { stdout: 'Running 1 day ago\n' });
    const { backend } = setup(ssh);

    const result = await backend.checkHealth(receiptOf(appRef, null, new Date('2026-09-19T12:00:00Z')), options);

    expect(result.healthy).toBe(true);
  });

  it('times out with the services that never became healthy', async () => {
    const ssh = new ScriptedSsh()
      .on(LIST, { stdout: 'shop-production_web\n' })
      .on(INSPECT, { stdout: '' })
      .on(TASKS, { stdout: 'Starting 3 seconds ago\n' });
    const { backend } = setup(ssh);

    const result = await backend.checkHealth(receiptOf(appRef), options);

    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.message).toBe('Health check timeout after 30s. Unhealthy services: shop-production_web');
    expect(result.failures.map((f) => [f.service, f.reason])).toEqual([['web', 'Timeout']]);
  });
});

describe('SwarmStackBackend.revert', () => {
  it('leaves reverts to Swarm', async () => {
    const { ssh, backend } = setup();

    expect(await backend.revert(receiptOf(appRef))).toEqual({ status: 'native', services: [] });
    expect(ssh.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('SwarmStackBackend queries', () => {
  it('exists when docker stack ls lists the role scope', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack ls --format '\{\{\.Name\}\}'$/, {
      stdout: 'shop-production\nother-production-accessories\n',
    });
    const { backend } = setup(ssh);

    expect(await backend.exists(appRef)).toBe(true);
    expect(await backend.exists(accessoryRef)).toBe(false);
  });

  it('lists services and instances through the shared parsers', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services 'shop-production' --format '\{\{\.Name\}\}\|/, {
        stdout: 'shop-production_web|replicated|web:1|2/2|*:8080->80/tcp\n',
      })
      .on(/^docker stack ps 'shop-production' --no-trunc --filter 'desired-state=running' --filter 'name=shop-production_web'/, {
        stdout: 'task1|shop-production_web.1|web:1|10.0.0.1|Running|Running 2 minutes ago|\n',
      });
    const { backend } = setup(ssh);

    const services = await backend.getServices(appRef);
    const instances = await backend.listInstances(appRef, { service: 'web' });

    expect(services.map((s) => [s.name, s.nativeName, s.replicas, s.state])).toEqual([
      ['web', 'shop-production_web', { running: 2, desired: 2 }, 'running'],
    ]);
    // the node hostname maps to its servers.yml key
    expect(instances.map((i) => [i.id, i.label, i.node, i.restarts])).toEqual([['task1', 'web.1', 'manager-1', null]]);
  });

  it('diagnoses with the sections and texts of dockflow diagnose', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack ls --format '\{\{\.Name\}\}'$/, { stdout: 'shop-production\n' })
      .on(/^docker stack services 'shop-production' --format '\{\{\.Name\}\}\|/, {
        stdout: 'shop-production_web|replicated|web:1|0/2|\nshop-production_worker|replicated|worker:1|1/1|\n',
      })
      .on(/^docker stack ps 'shop-production' --no-trunc --format /, {
        stdout: [
          't1|shop-production_web.1|web:1|node-1|Shutdown|Failed 2 minutes ago|"task: non-zero exit (1)"',
          't2|shop-production_web.2|web:1||Running|Pending 1 minute ago|',
          't3|shop-production_worker.1|worker:1|node-1|Running|Running 5 minutes ago|',
          '',
        ].join('\n'),
      })
      .on(/^docker events /, { stdout: '' })
      .on(/^df -h \//, { stdout: '42%\n' })
      .on(/^free -m/, { stdout: '85' });
    const { backend } = setup(ssh);

    const report = await backend.diagnose(appRef, { verbose: true });

    expect(report.sections.map((s) => s.title)).toEqual([
      'Stack Status',
      'Services',
      'Task Errors',
      'Pending Tasks',
      'Recent Docker Events',
      'System Resources',
    ]);
    expect(report.sections[1].lines).toEqual([
      { text: 'web: 0/2 replicas', level: 'error' },
      { text: 'worker: 1/1 replicas', level: 'ok' },
    ]);
    expect(report.sections[2].lines).toEqual([
      { text: 'shop-production_web.1', level: 'error' },
      { text: '  State: Failed 2 minutes ago', level: 'plain' },
      { text: '  Error: task: non-zero exit (1)', level: 'plain' },
      { text: '', level: 'plain' },
    ]);
    expect(report.sections[3].lines).toEqual([{ text: 'shop-production_web.2: Pending 1 minute ago', level: 'pending' }]);
    expect(report.sections[4].lines).toEqual([{ text: 'No recent container deaths', level: 'plain' }]);
    expect(report.sections[5].lines).toEqual([
      { text: 'Disk usage: 42%', level: 'plain' },
      { text: 'Memory usage: 85%', level: 'warning' },
    ]);
    expect(report.issues).toEqual([
      {
        severity: 'error',
        category: 'Replicas',
        message: "Service 'web' has 0/2 replicas",
        suggestion: 'Check task errors below',
      },
      {
        severity: 'error',
        category: 'Task',
        message: 'shop-production_web.1: task: non-zero exit (1)',
        suggestion: 'Check Docker logs for more details: docker service logs <service_name>',
      },
      {
        severity: 'warning',
        category: 'Scheduling',
        message: 'Some tasks are pending',
        suggestion: 'May indicate resource constraints or scheduling issues',
      },
    ]);
  });

  it('stops the report at a missing stack', () => {
    const report = buildSwarmDiagnosticReport({
      env: 'production',
      role: 'app',
      exists: false,
      services: [],
      tasks: [],
      disk: null,
      memoryPercent: null,
    });

    expect(report).toEqual({
      sections: [{ title: 'Stack Status', lines: [{ text: 'Stack does not exist', level: 'error' }] }],
      issues: [
        {
          severity: 'error',
          category: 'Stack',
          message: 'Stack not found',
          suggestion: "Run 'dockflow deploy production' to deploy the stack",
        },
      ],
    });
  });

  it('flags a nearly full disk as an error issue', () => {
    const report = buildSwarmDiagnosticReport({
      env: 'production',
      role: 'app',
      exists: true,
      services: [],
      tasks: [],
      disk: { text: '93%', percent: 93 },
      memoryPercent: 95,
    });

    expect(report.sections.at(-1)?.lines).toEqual([
      { text: 'Disk usage: 93%', level: 'warning' },
      { text: 'Memory usage: 95%', level: 'error' },
    ]);
    expect(report.issues.map((i) => [i.severity, i.message])).toEqual([
      ['error', 'Disk at 93%'],
      ['warning', 'Memory at 95%'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe('SwarmStackBackend mutations', () => {
  const wait = { wait: true, timeoutS: 300 };
  const noWait = { wait: false, timeoutS: 300 };

  it('scales, restarts and rolls back with --detach only when not waiting', async () => {
    const ssh = new ScriptedSsh().on(/^docker service /, {});
    const { backend } = setup(ssh);

    await backend.scale(appRef, 'web', 3, wait);
    await backend.scale(appRef, 'web', 0, noWait);
    await backend.restart(appRef, 'web', wait);
    await backend.restart(appRef, 'web', noWait);
    const rolledBack = await backend.rollbackService(appRef, 'web', wait);
    await backend.rollbackService(appRef, 'web', noWait);

    expect(ssh.commands()).toEqual([
      "docker service scale 'shop-production_web=3'",
      "docker service scale --detach 'shop-production_web=0'",
      "docker service update --force 'shop-production_web'",
      "docker service update --force --detach 'shop-production_web'",
      "docker service rollback 'shop-production_web'",
      "docker service rollback --detach 'shop-production_web'",
    ]);
    expect(rolledBack).toEqual({ toVersion: null });
  });

  it('raises the docker error of a failed mutation as a DeployError', async () => {
    const ssh = new ScriptedSsh().on(/^docker service scale /, {
      exitCode: 1,
      stderr: 'service shop-production_web not found\n',
    });
    const { backend } = setup(ssh);

    const failure = backend.scale(appRef, 'web', 2, wait);

    await expect(failure).rejects.toBeInstanceOf(DeployError);
    await expect(failure).rejects.toThrow('service shop-production_web not found');
  });

  it('restarts every service of the role in one chained command', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services 'shop-production-accessories' --format /, {
        stdout: 'shop-production-accessories_db|replicated|postgres:16|1/1|\nshop-production-accessories_cache|replicated|redis:7|1/1|\n',
      })
      .on(/^docker service update /, {});
    const { backend } = setup(ssh);

    await backend.restart(accessoryRef, null, wait);

    expect(ssh.commands().at(-1)).toBe(
      "docker service update --force 'shop-production-accessories_db' && docker service update --force 'shop-production-accessories_cache'",
    );
  });

  it('refuses to restart a role without services', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack services /, { stderr: 'Nothing found in stack: shop-production\n' });
    const { backend } = setup(ssh);

    const failure = backend.restart(appRef, null, wait);

    await expect(failure).rejects.toThrow('No services found');
    await expect(failure).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
  });

  it('stops each service at 0 replicas and collects the failures into one error', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack services 'shop-production-accessories' --format /, {
        stdout: 'shop-production-accessories_db|replicated|postgres:16|1/1|\nshop-production-accessories_cache|replicated|redis:7|1/1|\n',
      })
      .on(/_db=0/, {})
      .on(/_cache=0/, { exitCode: 1, stderr: 'update out of sequence\n' });
    const { backend } = setup(ssh);

    const failure = backend.stop(accessoryRef, null, wait);

    await expect(failure).rejects.toThrow('Some services failed to stop: cache: update out of sequence');
    expect(ssh.commands().filter((c) => c.startsWith('docker service scale'))).toEqual([
      "docker service scale 'shop-production-accessories_db=0'",
      "docker service scale 'shop-production-accessories_cache=0'",
    ]);
  });

  it('stops only the named services', async () => {
    const ssh = new ScriptedSsh().on(/^docker service scale /, {});
    const { backend } = setup(ssh);

    await backend.stop(accessoryRef, ['db'], noWait);

    expect(ssh.commands()).toEqual(["docker service scale --detach 'shop-production-accessories_db=0'"]);
  });

  it('removes the application stack and waits for it, keeping volumes', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack rm 'shop-production'$/, {})
      .on(/^docker stack ls --format '\{\{\.Name\}\}' \| grep -xF 'shop-production'/, { stdout: '' });
    const { backend, clock } = setup(ssh);

    await backend.remove(appRef, { volumes: 'retain' });

    expect(ssh.commands()).toEqual([
      "docker stack rm 'shop-production'",
      `docker stack ls --format '{{.Name}}' | grep -xF 'shop-production' || echo ""`,
    ]);
    expect(clock.sleeps).toEqual([2000]);
  });

  it('removes the accessories with their volumes and forgets their hash (S-9)', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack rm 'shop-production-accessories'$/, {})
      .on(/^docker stack ps 'shop-production-accessories' 2>&1/, { stdout: '0\n' })
      .on(/^docker volume ls /, { stdout: 'shop-production-accessories_db-data\n' })
      .on(/^docker volume rm /, {})
      .on(/^rm -rf /, {});
    const { backend } = setup(ssh);

    await backend.remove(accessoryRef, { volumes: 'delete' });

    // the hash goes as soon as the services are gone, so a failed volume removal cannot leave it behind
    expect(ssh.commands()).toEqual([
      "docker stack rm 'shop-production-accessories'",
      `docker stack ps 'shop-production-accessories' 2>&1 | grep -v "Nothing found" | wc -l`,
      "rm -rf '/var/lib/dockflow/accessories/shop-production'",
      "docker volume ls --filter 'label=com.docker.stack.namespace=shop-production-accessories' --format '{{.Name}}'",
      "docker volume rm 'shop-production-accessories_db-data'",
    ]);
  });

  it('an interrupt after the services went keeps the volumes and still forgets the hash', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack rm 'shop-production-accessories'$/, {})
      .on(/^docker stack ps 'shop-production-accessories' 2>&1/, { stdout: '0\n' })
      .on(/^rm -rf /, {});
    const { backend } = setup(ssh);
    const interrupt = new AbortController();
    interrupt.abort();

    await expect(backend.remove(accessoryRef, { volumes: 'delete', signal: interrupt.signal })).rejects.toMatchObject({
      code: ErrorCode.INTERRUPTED,
      message: 'Removal interrupted before any volume was deleted',
    });
    expect(ssh.commands()).toEqual([
      "docker stack rm 'shop-production-accessories'",
      `docker stack ps 'shop-production-accessories' 2>&1 | grep -v "Nothing found" | wc -l`,
      "rm -rf '/var/lib/dockflow/accessories/shop-production'",
    ]);
  });

  it('keeps accessory volumes by default, still forgetting the hash', async () => {
    const ssh = new ScriptedSsh()
      .on(/^docker stack rm /, {})
      .on(/^docker stack ps /, { stdout: '1\n' })
      .on(/^rm -rf /, {});
    const { backend } = setup(ssh);

    await backend.remove(accessoryRef, { volumes: 'retain' });

    expect(ssh.commands().some((c) => c.startsWith('docker volume'))).toBe(false);
    expect(ssh.commands().at(-1)).toBe("rm -rf '/var/lib/dockflow/accessories/shop-production'");
  });

  it('fails the accessories removal when docker stack rm fails, keeping the hash', async () => {
    const ssh = new ScriptedSsh().on(/^docker stack rm /, { exitCode: 1, stderr: 'permission denied\n' });
    const { backend } = setup(ssh);

    await expect(backend.remove(accessoryRef, { volumes: 'retain' })).rejects.toThrow('permission denied');
    expect(ssh.commands()).toEqual(["docker stack rm 'shop-production-accessories'"]);
  });
});
