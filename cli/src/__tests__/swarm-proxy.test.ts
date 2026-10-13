import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { parse } from 'yaml';
import { parseListeners, parseServicePorts, SwarmProxyBackend } from '../services/orchestrator/swarm/swarm-proxy';
import { DeployError } from '../utils/errors';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';
import type { ProxyConfig } from '../utils/config';

interface StackService {
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
}

interface Stack {
  services: Record<string, StackService>;
  networks: Record<string, Record<string, unknown>>;
}

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
  it('gives Traefik the Docker API through a read-only proxy, never the socket itself', () => {
    for (const config of [base, { ...base, acme: false } as ProxyConfig]) {
      const stack = parse(SwarmProxyBackend.generateCompose(config)) as Stack;
      const traefik = stack.services.traefik;
      const proxy = stack.services['socket-proxy'];
      expect((traefik.volumes ?? []).some((v) => v.includes('docker.sock'))).toBe(false);
      expect(traefik.command).toContain('--providers.swarm.endpoint=tcp://socket-proxy:2375');
      expect(proxy.volumes).toEqual(['/var/run/docker.sock:/var/run/docker.sock:ro']);
      expect(proxy.environment).toEqual({ SERVICES: '1', TASKS: '1', NETWORKS: '1', NODES: '1', INFO: '1' });
      expect(proxy.networks).toEqual(['socket-proxy']);
      expect(traefik.networks).toEqual(['traefik-public', 'socket-proxy']);
      expect(stack.networks['socket-proxy']).toEqual({ driver: 'overlay', internal: true });
    }
  });

  it('trusts the X-Forwarded-* headers of the configured senders on every entrypoint', () => {
    const trusted = { ...base, trusted_ips: ['173.245.48.0/20', '2400:cb00::/32'] } as ProxyConfig;
    const compose = SwarmProxyBackend.generateCompose(trusted);
    expect(compose).toContain('"--entrypoints.web.forwardedHeaders.trustedIPs=173.245.48.0/20,2400:cb00::/32"');
    expect(compose).toContain('"--entrypoints.websecure.forwardedHeaders.trustedIPs=173.245.48.0/20,2400:cb00::/32"');
    expect(SwarmProxyBackend.generateCompose({ ...trusted, acme: false })).not.toContain('websecure.forwardedHeaders');
    expect(SwarmProxyBackend.generateCompose(base)).not.toContain('forwardedHeaders');
    expect(SwarmProxyBackend.configHash(trusted)).not.toBe(SwarmProxyBackend.configHash(base));
  });

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

const SS_HEADER = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process';
const conn = { host: 'manager', port: 22, user: 'deploy', privateKey: 'unused' };

interface Scripted {
  traefik?: { replicas: string; hash: string };
  /** `name|80/tcp/ingress ` lines, as `docker service inspect --format` prints them */
  services?: string;
  /** the node each service runs on, by service name */
  tasks?: Record<string, string>;
  managers?: string;
  ss?: string | null;
}

describe('SwarmProxyBackend.ensureRunning: ports', () => {
  let commands: string[];
  let deployed: boolean;
  let restore: Array<{ mockRestore: () => void }> = [];

  function script(options: Scripted): void {
    for (const spy of restore) spy.mockRestore();
    commands = [];
    deployed = false;
    const answer = (command: string): { stdout: string; stderr: string; exitCode: number } => {
      commands.push(command);
      const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
      if (command.startsWith('docker service ls --filter')) return ok(options.traefik?.replicas ?? '');
      if (command.startsWith('docker service inspect')) return ok(options.traefik?.hash ?? '');
      if (command.startsWith('docker service ls -q')) return ok(options.services ?? '');
      if (command.startsWith('docker node ls')) return ok(options.managers ?? 'manager-1\n');
      if (command.startsWith('docker service ps')) {
        const name = Object.keys(options.tasks ?? {}).find((service) => command.includes(`'${service}'`));
        return ok(name ? `${options.tasks?.[name]}\n` : '');
      }
      if (command === 'ss -ltnp 2>/dev/null') {
        return options.ss === null ? { stdout: '', stderr: '', exitCode: 127 } : ok(options.ss ?? `${SS_HEADER}\n`);
      }
      return ok('');
    };
    restore = [
      spyOn(ssh, 'sshExec').mockImplementation(async (_conn, command) => answer(command)),
      spyOn(output, 'printDim').mockImplementation(() => {}),
      spyOn(output, 'printSuccess').mockImplementation(() => {}),
      spyOn(ssh, 'sshExecChannel').mockImplementation((async () => {
        deployed = true;
        return { stream: { end: () => {} }, done: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) };
      }) as never),
    ];
  }

  async function ensure(config: ProxyConfig = base): Promise<unknown> {
    return new SwarmProxyBackend(conn).ensureRunning(config).then(
      () => undefined,
      (error) => error,
    );
  }

  afterEach(() => {
    for (const spy of restore) spy.mockRestore();
    restore = [];
  });

  it('deploys on a clean manager', async () => {
    script({});

    expect(await ensure()).toBeUndefined();
    expect(deployed).toBe(true);
  });

  it('refuses when another Swarm service publishes port 80, naming it, and deploys nothing', async () => {
    script({ services: 'shop_web|80/tcp/ingress \n' });

    const failure = (await ensure()) as DeployError;

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.message).toContain('port 80 is already published by the Swarm service "shop_web"');
    expect(deployed).toBe(false);
    expect(commands.some((command) => command.startsWith('docker network create'))).toBe(false);
  });

  it('names every holder of 80 and 443', async () => {
    script({ services: 'shop_web|80/tcp/ingress \nshop_tls|443/tcp/ingress \n' });

    const failure = (await ensure()) as DeployError;

    expect(failure.message).toContain('port 80 is already published by the Swarm service "shop_web"');
    expect(failure.message).toContain('port 443 is already published by the Swarm service "shop_tls"');
  });

  it('does not look at 443 when Traefik does not publish it', async () => {
    script({ services: 'shop_tls|443/tcp/ingress \n' });

    expect(await ensure({ ...base, acme: false })).toBeUndefined();
  });

  it('ignores a service that publishes other ports or UDP', async () => {
    script({ services: 'shop_api|8080/tcp/ingress \nshop_dns|80/udp/ingress \nshop_db|\n' });

    expect(await ensure()).toBeUndefined();
  });

  it("lets Traefik's own service keep its ports on an update", async () => {
    script({ traefik: { replicas: '1/1', hash: 'old' }, services: 'traefik_traefik|80/tcp/host 443/tcp/host \n' });

    expect(await ensure()).toBeUndefined();
    expect(deployed).toBe(true);
  });

  it('still refuses an update when another service took a port', async () => {
    script({ traefik: { replicas: '1/1', hash: 'old' }, services: 'traefik_traefik|80/tcp/host \nshop_web|443/tcp/ingress \n' });

    expect(((await ensure()) as DeployError).message).toContain('port 443 is already published by the Swarm service "shop_web"');
  });

  it('counts a host-mode port only when a task of the service runs on a manager', async () => {
    script({ services: 'edge|80/tcp/host \n', tasks: { edge: 'worker-1' }, managers: 'manager-1\n' });
    expect(await ensure()).toBeUndefined();

    script({ services: 'edge|80/tcp/host \n', tasks: { edge: 'manager-1' }, managers: 'manager-1\n' });
    expect(((await ensure()) as DeployError).message).toContain('"edge" (host mode, on a manager)');
  });

  it('skips the whole check when Traefik already runs with the same configuration', async () => {
    script({ traefik: { replicas: '1/1', hash: SwarmProxyBackend.configHash(base) }, services: 'shop_web|80/tcp/ingress \n' });

    expect(await ensure()).toBeUndefined();
    expect(deployed).toBe(false);
    expect(commands.some((command) => command.startsWith('docker service ls -q'))).toBe(false);
  });

  it('names the process another program runs on the manager', async () => {
    script({
      ss: `${SS_HEADER}\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))\nLISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=812,fd=7))\n`,
    });

    const failure = (await ensure()) as DeployError;

    expect(failure.message).toBe('Cannot deploy Traefik: port 80 is already in use on the manager by "nginx"');
    expect(deployed).toBe(false);
  });

  it('says so when the process cannot be named', async () => {
    script({ ss: `${SS_HEADER}\nLISTEN 0 4096 *:443 *:*\n` });

    expect(((await ensure()) as DeployError).message).toContain('port 443 is already in use on the manager by a process Dockflow cannot name');
  });

  it('does not report a listener on another port', async () => {
    script({ ss: `${SS_HEADER}\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\n` });

    expect(await ensure()).toBeUndefined();
  });

  it('names the Swarm service rather than the listener that carries its port', async () => {
    script({ services: 'shop_web|80/tcp/ingress \n', ss: `${SS_HEADER}\nLISTEN 0 4096 *:80 *:* users:(("dockerd",pid=900,fd=30))\n` });

    const failure = (await ensure()) as DeployError;

    expect(failure.message).toContain('Swarm service "shop_web"');
    expect(failure.message).not.toContain('dockerd');
  });

  it('does not look for listeners while Traefik exists: it is the one holding the ports', async () => {
    script({ traefik: { replicas: '1/1', hash: 'old' }, ss: `${SS_HEADER}\nLISTEN 0 4096 *:80 *:*\n` });

    expect(await ensure()).toBeUndefined();
    expect(commands).not.toContain('ss -ltnp 2>/dev/null');
  });

  it('goes on without ss', async () => {
    script({ ss: null });

    expect(await ensure()).toBeUndefined();
    expect(deployed).toBe(true);
  });
});

describe('port output parsers', () => {
  it('reads what docker service inspect prints', () => {
    expect(parseServicePorts('web|80/tcp/ingress 443/tcp/host \ndb|\n')).toEqual([
      {
        name: 'web',
        ports: [
          { port: 80, protocol: 'tcp', mode: 'ingress' },
          { port: 443, protocol: 'tcp', mode: 'host' },
        ],
      },
      { name: 'db', ports: [] },
    ]);
  });

  it('reads what ss prints, with or without the process', () => {
    const output = `${SS_HEADER}\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))\nLISTEN 0 4096 [::]:443 [::]:*\n`;

    expect(parseListeners(output)).toEqual([
      { port: 80, process: 'nginx' },
      { port: 443, process: undefined },
    ]);
  });
});
