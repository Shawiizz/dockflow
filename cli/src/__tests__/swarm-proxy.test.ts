import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'stream';
import type {
  ClusterNodeRef,
  HelmEventSink,
  OrchestratorTarget,
  StackDeployInput,
} from '../services/orchestrator/interfaces';
import { imageTag, SwarmProxyBackend, swarmProxyStatus } from '../services/orchestrator/swarm/swarm-proxy';
import type { SwarmChannel, SwarmExecResult, SwarmSsh } from '../services/orchestrator/swarm/swarm-utils';
import { DeployError } from '../utils/errors';

type ProxyConfig = NonNullable<StackDeployInput['proxy']>;

const base = { enabled: true, acme: true, email: 'ops@example.com' } as ProxyConfig;

describe('SwarmProxyBackend.configHash', () => {
  it('is stable for the same configuration', () => {
    expect(SwarmProxyBackend.configHash({ ...base })).toBe(SwarmProxyBackend.configHash({ ...base }));
  });

  it('changes when the generated stack would change', () => {
    const hash = SwarmProxyBackend.configHash(base);

    expect(SwarmProxyBackend.configHash({ ...base, email: 'other@example.com' })).not.toBe(hash);
    expect(SwarmProxyBackend.configHash({ ...base, acme: false })).not.toBe(hash);
    expect(SwarmProxyBackend.configHash({ ...base, dashboard: { enabled: true, domain: 'tr.example.com' } } as ProxyConfig)).not.toBe(hash);
  });
});

describe('SwarmProxyBackend.generateCompose', () => {
  it('labels the service with the hash it was deployed from, dashboard or not', () => {
    const hash = SwarmProxyBackend.configHash(base);
    const dashboard = { ...base, dashboard: { enabled: true, domain: 'tr.example.com' } } as ProxyConfig;

    expect(SwarmProxyBackend.generateCompose(base, hash)).toContain(`"dockflow.config-hash=${hash}"`);
    expect(SwarmProxyBackend.generateCompose(dashboard, 'abc')).toContain('"dockflow.config-hash=abc"');
    expect(SwarmProxyBackend.generateCompose(base)).not.toContain('dockflow.config-hash');
  });

  it('registers the ACME account with no contact when proxy.email is unset', () => {
    const { email: _email, ...noEmail } = base;
    const compose = SwarmProxyBackend.generateCompose(noEmail as ProxyConfig);
    expect(compose).not.toContain('acme.email');
    expect(compose).toContain('--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json');
  });
});

// ---------------------------------------------------------------------------
// plan / ensure / status over a scripted SSH stub
// ---------------------------------------------------------------------------

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  reject?: Error;
}

interface Call {
  kind: 'exec' | 'channel';
  command: string;
  stdin?: string;
}

/** First matching rule answers; an unscripted command fails the test. */
class ScriptedSsh implements SwarmSsh {
  readonly calls: Call[] = [];
  private readonly rules: { match: RegExp; reply: Reply }[] = [];

  on(match: RegExp, reply: Reply): this {
    this.rules.push({ match, reply });
    return this;
  }

  commands(): string[] {
    return this.calls.map((call) => call.command);
  }

  private answer(kind: Call['kind'], command: string): { call: Call; reply: Reply } {
    const call: Call = { kind, command };
    this.calls.push(call);
    const rule = this.rules.find((r) => r.match.test(command));
    if (!rule) throw new Error(`unscripted ${kind}: ${command}`);
    return { call, reply: rule.reply };
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

const LIST = /^docker service ls --filter 'name=traefik_traefik' --format '\{\{\.Replicas\}\}\|\{\{\.Image\}\}'/;
const INSPECT = /^docker service inspect 'traefik_traefik' --format '\{\{index \.Spec\.Labels "dockflow\.config-hash"\}\}\|/;

const ACME_ARGS = JSON.stringify([
  '--providers.swarm=true',
  '--entrypoints.web.address=:80',
  '--entrypoints.websecure.address=:443',
  '--certificatesresolvers.letsencrypt.acme.email=ops@example.com',
]);

/** Traefik as `docker service ls` / `inspect` report it; replicas '' means not deployed. */
function running(ssh: ScriptedSsh, replicas: string, hash: string): ScriptedSsh {
  if (replicas === '') {
    return ssh.on(LIST, { stdout: '' }).on(INSPECT, { exitCode: 1, stderr: 'no such service' });
  }
  return ssh
    .on(LIST, { stdout: `${replicas}|traefik:v3.6@sha256:${'a'.repeat(64)}\n` })
    .on(INSPECT, { stdout: `${hash}|${ACME_ARGS}\n` });
}

function deployable(ssh: ScriptedSsh): ScriptedSsh {
  return ssh
    .on(/^docker network create /, {})
    .on(/^docker volume create /, {})
    .on(/^docker stack deploy /, {});
}

const silentEvents = (): HelmEventSink & { steps: string[] } => {
  const steps: string[] = [];
  return { steps, step: (text) => steps.push(text), warn: () => {} };
};

describe('SwarmProxyBackend.status', () => {
  it('reports a running Traefik with its version and entry points', async () => {
    const backend = new SwarmProxyBackend(target, { ssh: running(new ScriptedSsh(), '1/1', 'abc') });

    expect(await backend.status()).toEqual({
      installed: true,
      ready: true,
      version: 'v3.6',
      owner: null,
      entryPoints: ['web', 'websecure'],
      acme: true,
      acmeReclaimPolicy: null,
    });
  });

  it('reports a missing Traefik', async () => {
    const backend = new SwarmProxyBackend(target, { ssh: running(new ScriptedSsh(), '', '') });

    const status = await backend.status();

    expect(status.installed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.version).toBeNull();
  });

  it('says why a deployed Traefik is not ready', () => {
    const status = swarmProxyStatus({ replicas: '0/1', image: 'traefik:v3.6', configHash: 'abc', args: [] });

    expect(status.ready).toBe(false);
    expect(status.detail).toBe('Traefik runs 0/1 replicas');
  });

  it('reads image tags with and without a digest', () => {
    expect(imageTag('traefik:v3.6')).toBe('v3.6');
    expect(imageTag(`traefik:v3.6@sha256:${'b'.repeat(64)}`)).toBe('v3.6');
    expect(imageTag('registry.example.com:5000/traefik')).toBeNull();
  });
});

describe('SwarmProxyBackend.plan', () => {
  it('plans an install when Traefik is absent', async () => {
    const ssh = running(new ScriptedSsh(), '', '');
    const plan = await new SwarmProxyBackend(target, { ssh }).plan(base, 'production');

    expect(plan.action).toBe('install');
    expect(plan.blockers).toEqual([]);
    // read-only
    expect(ssh.commands().every((c) => c.startsWith('docker service ls') || c.startsWith('docker service inspect'))).toBe(true);
  });

  it('plans nothing when the running stack has the same configuration hash', async () => {
    const ssh = running(new ScriptedSsh(), '1/1', SwarmProxyBackend.configHash(base));

    const plan = await new SwarmProxyBackend(target, { ssh }).plan(base, 'production');

    expect(plan.action).toBe('unchanged');
  });

  it('plans an upgrade when the configuration changed or Traefik is not running', async () => {
    const changed = await new SwarmProxyBackend(target, { ssh: running(new ScriptedSsh(), '1/1', 'old') }).plan(
      base,
      'production',
    );
    const down = await new SwarmProxyBackend(target, {
      ssh: running(new ScriptedSsh(), '0/1', SwarmProxyBackend.configHash(base)),
    }).plan(base, 'production');

    expect([changed.action, changed.reason]).toEqual(['upgrade', 'the proxy configuration changed']);
    expect([down.action, down.reason]).toEqual(['upgrade', 'Traefik runs 0/1 replicas']);
  });
});

describe('SwarmProxyBackend.ensure', () => {
  it('changes nothing when Traefik already runs this configuration', async () => {
    const ssh = running(new ScriptedSsh(), '1/1', SwarmProxyBackend.configHash(base));

    const result = await new SwarmProxyBackend(target, { ssh }).ensure(base, 'production');

    expect(result).toEqual({ changed: false, action: 'unchanged', version: 'v3.6' });
    expect(ssh.calls.every((c) => c.kind === 'exec' && !/create|deploy/.test(c.command))).toBe(true);
  });

  it('deploys the generated stack over stdin, labelled with its hash', async () => {
    const ssh = deployable(running(new ScriptedSsh(), '', ''));
    const events = silentEvents();

    const result = await new SwarmProxyBackend(target, { ssh }).ensure(base, 'production', events);

    expect(result).toEqual({ changed: true, action: 'install', version: 'v3.6' });
    expect(events.steps).toEqual(['Deploying Traefik reverse proxy...']);
    expect(ssh.commands()).toContain("docker network create --driver overlay --attachable 'traefik-public' 2>/dev/null || true");
    expect(ssh.commands()).toContain("docker volume create 'traefik-certs' 2>/dev/null || true");
    const deploy = ssh.calls.find((c) => c.kind === 'channel');
    expect(deploy?.command).toBe("docker stack deploy --prune --resolve-image changed -c - 'traefik'");
    expect(deploy?.stdin).toBe(SwarmProxyBackend.generateCompose(base, SwarmProxyBackend.configHash(base)));
  });

  it('creates no certificate volume without ACME', async () => {
    const httpOnly = { ...base, acme: false } as ProxyConfig;
    const ssh = deployable(running(new ScriptedSsh(), '1/1', 'old'));

    const result = await new SwarmProxyBackend(target, { ssh }).ensure(httpOnly, 'production', silentEvents());

    expect(result.action).toBe('upgrade');
    expect(ssh.commands().some((c) => c.startsWith('docker volume create'))).toBe(false);
  });

  it('raises a failed deploy as a DeployError', async () => {
    const ssh = running(new ScriptedSsh(), '', '')
      .on(/^docker stack deploy /, { exitCode: 1, stderr: 'port 80 is already in use\n' })
      .on(/^docker (network|volume) create /, {});

    const failure = new SwarmProxyBackend(target, { ssh }).ensure(base, 'production', silentEvents());

    await expect(failure).rejects.toBeInstanceOf(DeployError);
    await expect(failure).rejects.toThrow('Traefik deployment failed: port 80 is already in use');
  });
});
