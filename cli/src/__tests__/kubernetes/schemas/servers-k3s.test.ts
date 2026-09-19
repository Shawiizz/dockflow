import { afterEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  k3sTopologyIssues,
  ServerConfigSchema,
  ServerRoleSchema,
  ServersConfigSchema,
  type TopologyServer,
} from '../../../schemas/servers.schema';
import { M } from '../../../services/orchestrator/messages';
import type { ServerConfig, ServersConfig } from '../../../types/servers';
import { toResolvedServer } from '../../../utils/servers/resolver';

function issuesOf(schema: z.ZodType, input: unknown): { path: string; message: string }[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

const server = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ host: '10.0.0.10', tags: ['production'], ...extra });

describe('servers.yml private_host (DESIGN-CORE 7.2)', () => {
  it('accepts IPv4 and IPv6 addresses: the schema is shared with Swarm', () => {
    for (const address of ['10.0.0.12', '192.168.1.5', 'fd00::12', '2001:db8::1']) {
      expect(issuesOf(ServerConfigSchema, server({ private_host: address }))).toEqual([]);
      expect(ServerConfigSchema.parse(server({ private_host: address })).private_host).toBe(address);
    }
    expect(ServerConfigSchema.parse(server()).private_host).toBeUndefined();
  });

  it('refuses anything else with M.privateHostIp', () => {
    for (const value of ['db.internal', '10.0.0', '10.0.0.256', '', 12, '10.0.0.0/24']) {
      expect(issuesOf(ServerConfigSchema, server({ private_host: value }))).toEqual([
        { path: 'private_host', message: 'private_host must be an IPv4 or IPv6 address' },
      ]);
    }
  });

  it('reports the full servers.yml path', () => {
    const file = { servers: { srv_1: server({ private_host: 'db.internal' }) } };
    expect(issuesOf(ServersConfigSchema, file)).toEqual([{ path: 'servers.srv_1.private_host', message: M.privateHostIp }]);
  });
});

describe('servers.yml node_labels (DESIGN-CORE 7.2)', () => {
  it('accepts Kubernetes label keys and values', () => {
    const labels = { disk: 'ssd', 'example.com/tier': 'front', 'Tier_1.a': '', zone: 'eu-west-1a', 'a.b-c': 'A_b.c-9' };
    expect(issuesOf(ServerConfigSchema, server({ node_labels: labels }))).toEqual([]);
    expect(ServerConfigSchema.parse(server({ node_labels: labels })).node_labels).toEqual(labels);
    expect(ServerConfigSchema.parse(server()).node_labels).toBeUndefined();
  });

  it('refuses invalid keys with the key message at the key path', () => {
    for (const key of ['bad key', '-disk', 'disk-', 'Example.com/tier', 'example.com/', `${'a'.repeat(64)}`, 'a/b/c']) {
      expect(issuesOf(ServerConfigSchema, server({ node_labels: { [key]: 'x' } }))).toEqual([
        { path: `node_labels.${key}`, message: M.labelKey },
      ]);
    }
    const long = `${'a'.repeat(250)}.io/x`;
    expect(issuesOf(ServerConfigSchema, server({ node_labels: { [long]: 'x' } }))).toEqual([
      { path: `node_labels.${long}`, message: M.labelKeyTooLong },
    ]);
  });

  it('refuses the kubernetes.io, k8s.io and Dockflow prefixes', () => {
    for (const key of [
      'kubernetes.io/hostname',
      'node-role.kubernetes.io/worker',
      'k8s.io/zone',
      'topology.k8s.io/region',
      'dockflow.shawiizz.dev/role',
    ]) {
      expect(issuesOf(ServerConfigSchema, server({ node_labels: { [key]: 'x' } }))).toEqual([
        { path: `node_labels.${key}`, message: M.labelKeyReserved },
      ]);
    }
    // a prefix merely containing the words is not reserved
    expect(issuesOf(ServerConfigSchema, server({ node_labels: { 'mykubernetes.io/x': 'a', 'example.com/k8s.io': 'b' } }))).toEqual([]);
  });

  it('refuses invalid values', () => {
    for (const value of ['-ssd', 'ssd-', 'a b', 'a/b']) {
      expect(issuesOf(ServerConfigSchema, server({ node_labels: { disk: value } }))).toEqual([
        { path: 'node_labels.disk', message: M.labelValue },
      ]);
    }
    expect(issuesOf(ServerConfigSchema, server({ node_labels: { disk: 'a'.repeat(64) } }))).toEqual([
      { path: 'node_labels.disk', message: M.labelValueTooLong },
    ]);
    expect(issuesOf(ServerConfigSchema, server({ node_labels: { disk: 'a'.repeat(63) } }))).toEqual([]);
  });
});

describe('ResolvedServer private_host and node_labels (DESIGN-CORE 6.6 item 6, 7.2)', () => {
  // an environment name no CI secret of the test process uses
  const ENV = 'resolverprobe';
  const HOST_OVERRIDE = 'RESOLVERPROBE_SRV_1_HOST';
  afterEach(() => {
    delete process.env[HOST_OVERRIDE];
  });

  const resolve = (entry: Partial<ServerConfig>) => {
    const serverConfig: ServerConfig = { tags: [ENV], ...entry };
    const config: ServersConfig = { servers: { srv_1: serverConfig } };
    return toResolvedServer(config, ENV, 'srv_1', serverConfig);
  };

  it('privateHost falls back to host; declaredPrivateHost keeps what servers.yml wrote', () => {
    const declared = resolve({ host: '203.0.113.10', private_host: '10.0.0.10' });
    expect([declared?.privateHost, declared?.declaredPrivateHost]).toEqual(['10.0.0.10', '10.0.0.10']);

    const absent = resolve({ host: '203.0.113.10' });
    expect([absent?.privateHost, absent?.declaredPrivateHost]).toEqual(['203.0.113.10', null]);
  });

  it('a private_host written equal to host stays declared (design-05 2.2 reads private_host first)', () => {
    const server = resolve({ host: '203.0.113.10', private_host: '203.0.113.10' });
    expect([server?.privateHost, server?.declaredPrivateHost]).toEqual(['203.0.113.10', '203.0.113.10']);
  });

  it('the fallback follows the CI host override, the declared value does not', () => {
    process.env[HOST_OVERRIDE] = '198.51.100.7';
    const absent = resolve({ host: '203.0.113.10' });
    expect([absent?.host, absent?.privateHost, absent?.declaredPrivateHost]).toEqual(['198.51.100.7', '198.51.100.7', null]);
    const declared = resolve({ host: '203.0.113.10', private_host: '10.0.0.10' });
    expect([declared?.host, declared?.privateHost, declared?.declaredPrivateHost]).toEqual([
      '198.51.100.7',
      '10.0.0.10',
      '10.0.0.10',
    ]);
  });

  it('copies node_labels ({} when absent) and returns null without any host', () => {
    const labels = { disk: 'ssd' };
    const labelled = resolve({ host: '10.0.0.10', node_labels: labels });
    expect(labelled?.nodeLabels).toEqual(labels);
    expect(labelled?.nodeLabels).not.toBe(labels);
    expect(resolve({ host: '10.0.0.10' })?.nodeLabels).toEqual({});
    expect(resolve({})).toBeNull();
  });
});

describe('servers.yml role descriptions', () => {
  it('name both orchestrators', () => {
    expect(ServerRoleSchema.description).toBe('Role in the cluster: manager (Swarm manager / k3s server) or worker (Swarm worker / k3s agent)');
    expect(ServerConfigSchema.shape.role.description).toContain('manager (Swarm manager / k3s server)');
    expect(ServerConfigSchema.shape.role.description).toContain('worker (Swarm worker / k3s agent)');
  });
});

describe('k3sTopologyIssues (DESIGN-CORE 7.2, design-05 2.1)', () => {
  const managers = (n: number, env = 'production'): Record<string, TopologyServer> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`server_${i + 1}`, { role: 'manager', host: `10.0.0.${i + 1}`, tags: [env] }]));

  it('accepts 1, 3 and 5 managers', () => {
    for (const n of [1, 3, 5]) expect(k3sTopologyIssues(managers(n), 'production')).toEqual([]);
  });

  it('U-SETUP-PLAN-03: refuses every even manager count with M.managerCount', () => {
    for (const n of [2, 4, 6]) {
      expect(k3sTopologyIssues(managers(n), 'production')).toEqual([
        { severity: 'error', code: 'servers.manager-count', path: 'servers', message: M.managerCount('production', n) },
      ]);
    }
    expect(k3sTopologyIssues(managers(2), 'production')[0].message).toBe(
      'servers: tag "production" has 2 managers; an embedded-etcd cluster needs an odd number, so declare 1 or 3',
    );
  });

  it('counts managers of the environment only; role defaults to manager, workers do not count', () => {
    const servers: Record<string, TopologyServer> = {
      ...managers(1),
      implicit: { host: '10.0.0.20', tags: ['production'] },
      worker_1: { role: 'worker', host: '10.0.0.21', tags: ['production'] },
      staging_1: { role: 'manager', host: '10.0.1.1', tags: ['staging'] },
    };
    expect(k3sTopologyIssues(servers, 'production').map((i) => i.message)).toEqual([M.managerCount('production', 2)]);
    expect(k3sTopologyIssues(servers, 'staging')).toEqual([]);
    expect(k3sTopologyIssues(servers, 'unknown')).toEqual([]);
  });

  it('U-SETUP-PLAN-04: two keys that map to one node name are refused with M.duplicateNode', () => {
    const servers: Record<string, TopologyServer> = {
      web_1: { role: 'manager', host: '10.0.0.1', tags: ['production'] },
      'web-1': { role: 'worker', host: '10.0.0.2', tags: ['production'] },
    };
    expect(k3sTopologyIssues(servers, 'production')).toEqual([
      { severity: 'error', code: 'servers.duplicate-node', path: 'servers.web-1', message: M.duplicateNode('web_1', 'web-1', 'web-1') },
    ]);
    expect(k3sTopologyIssues(servers, 'production')[0].message).toBe('servers: "web_1" and "web-1" both become node name "web-1"; rename one');
    const workers: Record<string, TopologyServer> = {
      ...managers(1),
      worker_1: { role: 'worker', host: '10.0.0.8', tags: ['production'] },
      'worker-1': { role: 'worker', host: '10.0.0.9', tags: ['production'] },
    };
    expect(k3sTopologyIssues(workers, 'production').map((i) => i.message)).toEqual([
      'servers: "worker_1" and "worker-1" both become node name "worker-1"; rename one',
    ]);
  });

  it('names every later key that collides with the first owner', () => {
    const servers: Record<string, TopologyServer> = {
      a_b: { role: 'manager', host: '10.0.0.1', tags: ['production'] },
      'a-b': { role: 'worker', host: '10.0.0.2', tags: ['production'] },
      'a_b-': { role: 'worker', host: '10.0.0.3', tags: ['production'] },
      'A-b': { role: 'worker', host: '10.0.0.4', tags: ['production'] },
      a__b: { role: 'worker', host: '10.0.0.5', tags: ['production'] },
      'a-_b': { role: 'worker', host: '10.0.0.6', tags: ['production'] },
    };
    expect(k3sTopologyIssues(servers, 'production').map((i) => [i.path, i.message])).toEqual([
      ['servers.a-b', M.duplicateNode('a_b', 'a-b', 'a-b')],
      ['servers.A-b', M.duplicateNode('a_b', 'A-b', 'a-b')],
      ['servers.a-_b', M.duplicateNode('a__b', 'a-_b', 'a--b')],
    ]);
  });

  it('servers of different environments form different clusters', () => {
    const servers: Record<string, TopologyServer> = {
      web_1: { role: 'manager', host: '10.0.0.1', tags: ['production'] },
      'web-1': { role: 'manager', host: '10.0.1.1', tags: ['staging'] },
    };
    expect(k3sTopologyIssues(servers, 'production')).toEqual([]);
    expect(k3sTopologyIssues(servers, 'staging')).toEqual([]);
  });

  it('refuses an IPv6 private_host with M.privateHostIpv6K3s', () => {
    const servers: Record<string, TopologyServer> = {
      ...managers(1),
      srv_2: { role: 'worker', host: '203.0.113.7', private_host: 'fd00::12', tags: ['production'] },
    };
    expect(k3sTopologyIssues(servers, 'production')).toEqual([
      {
        severity: 'error',
        code: 'servers.ipv6-cluster-address',
        path: 'servers.srv_2.private_host',
        message: 'servers.srv_2.private_host: IPv6 cluster addresses are not supported by Dockflow k3s setup yet',
        hint: "Use the node's IPv4 address.",
      },
    ]);
  });

  it('refuses an IPv6 host without private_host, accepts it behind an IPv4 private_host', () => {
    const bare: Record<string, TopologyServer> = { srv_1: { role: 'manager', host: '2001:db8::1', tags: ['production'] } };
    expect(k3sTopologyIssues(bare, 'production')).toEqual([
      {
        severity: 'error',
        code: 'servers.ipv6-cluster-address',
        path: 'servers.srv_1.host',
        message: M.privateHostIpv6K3s('srv_1'),
        hint: M.privateHostIpv6K3sSuggestion,
      },
    ]);
    const behind: Record<string, TopologyServer> = {
      srv_1: { role: 'manager', host: '2001:db8::1', private_host: '10.0.0.1', tags: ['production'] },
    };
    expect(k3sTopologyIssues(behind, 'production')).toEqual([]);
  });

  it('host names and missing hosts are left to setup, which resolves them on the node', () => {
    const servers: Record<string, TopologyServer> = {
      srv_1: { role: 'manager', host: 'srv-1.example.com', tags: ['production'] },
      srv_2: { role: 'worker', tags: ['production'] },
    };
    expect(k3sTopologyIssues(servers, 'production')).toEqual([]);
  });

  it('reports every rule at once, in servers.yml order', () => {
    const servers: Record<string, TopologyServer> = {
      web_1: { role: 'manager', host: '10.0.0.1', tags: ['production'] },
      'web-1': { role: 'manager', host: '10.0.0.2', private_host: 'fd00::2', tags: ['production'] },
    };
    expect(k3sTopologyIssues(servers, 'production').map((i) => i.code)).toEqual([
      'servers.manager-count',
      'servers.duplicate-node',
      'servers.ipv6-cluster-address',
    ]);
  });

  it('takes the parsed servers.yml as is', () => {
    const file = ServersConfigSchema.parse({
      servers: {
        main_1: { host: '10.0.0.1', tags: ['production'], node_labels: { disk: 'ssd' } },
        main_2: { host: '10.0.0.2', private_host: '10.1.0.2', tags: ['production'] },
      },
    });
    expect(k3sTopologyIssues(file.servers, 'production').map((i) => i.message)).toEqual([M.managerCount('production', 2)]);
  });
});
