// Direct tests of the network handlers (design-01 5.11 NET-*, 6.1 TNET-*). `network.host-network`
// and `network.dns-secondary` are translator codes (T2): the rows that name them assert here that
// the normalizer builds the model and emits nothing (design-01 1.6).

import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { NormalizeInputOverrides } from '../support/builders';
import { normalizeContext, parsedCompose, serviceDraft } from '../support/builders';
import { normalizeTopLevelNetworks, serviceNetwork } from '../../../services/orchestrator/kubernetes/normalize/network';

/** Normalizes the top-level networks, then the networking keys of service `service`. */
function run(source: string, service = 'web', overrides: NormalizeInputOverrides = {}) {
  const compose = parsedCompose(source);
  const ctx = normalizeContext({ ...overrides, compose });
  const table = normalizeTopLevelNetworks(compose.raw.networks, ctx);
  const draft = serviceDraft(service, ctx);
  serviceNetwork(draft, compose.services[service], table, ctx);
  return { draft, table, diagnostics: ctx.sink.list() };
}

function summary(diagnostics: Diagnostic[]): [string, string, string][] {
  return diagnostics.map((d) => [d.severity, d.code, d.path]);
}

const FLAT_INFO: Diagnostic = {
  severity: 'info',
  code: 'network.flat',
  path: 'networks',
  message: 'Kubernetes has one flat pod network: network membership does not isolate services',
};

describe('service networks (design-01 5.11)', () => {
  test('NET-01 no networks: default only, nothing reported', () => {
    const { draft, diagnostics } = run('image: nginx:1.27');
    expect(draft.network.networks).toEqual(['default']);
    expect(diagnostics).toEqual([]);
  });

  test('NET-01 a declared membership list is sorted and the flat-network info is given once', () => {
    const { draft, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
          networks: [default, backend, backend]
      networks:
        backend:
    `);
    expect(draft.network.networks).toEqual(['backend', 'default']);
    expect(diagnostics).toEqual([FLAT_INFO]);
  });

  test('NET-02 an undeclared network is refused', () => {
    const { draft, diagnostics } = run('networks: [ghost]');
    expect(draft.network.networks).toEqual([]);
    expect(diagnostics).toEqual([
      FLAT_INFO,
      {
        severity: 'error',
        code: 'network.undeclared',
        path: 'services.web.networks[0]',
        message: 'network ghost is not declared under top-level networks',
        hint: 'Declare it, or remove it from the service.',
      },
    ]);
  });

  test('NET-03 traefik-public is not needed', () => {
    const { draft, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
          networks: [traefik-public]
      networks:
        traefik-public:
          external: true
    `);
    expect(draft.network.networks).toEqual(['traefik-public']);
    expect(diagnostics).toContainEqual({
      severity: 'info',
      code: 'network.traefik-public',
      path: 'services.web.networks[0]',
      message: 'traefik-public is not needed on Kubernetes: Traefik reaches services directly',
    });
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  test('NET-04 aliases are sanitized like service names; the service name itself is dropped', () => {
    const { draft, diagnostics } = run(
      `
      services:
        api:
          image: api:1
          networks:
            backend:
              aliases: [db_primary, api, cache, cache]
      networks:
        backend:
    `,
      'api',
    );
    expect(draft.network.networks).toEqual(['backend']);
    expect(draft.network.aliases).toEqual(['cache', 'db-primary']);
    expect(diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'warning',
        code: 'names.sanitized',
        path: 'services.api.networks.backend.aliases[0]',
        message: 'alias db_primary is deployed as Service db-primary; clients using db_primary will not resolve it',
        hint: 'Rename the alias to `db-primary` (lowercase letters, digits and `-`).',
      },
    ]);
  });

  test('NET-05 static addresses are refused; other attachment options are ignored with a warning', () => {
    const doc = (attachment: string) => `
      services:
        web:
          image: nginx:1.27
          networks:
            backend: ${attachment}
      networks:
        backend:
    `;
    const staticIp = run(doc('{ipv4_address: 10.0.0.2, ipv6_address: "fd00::2"}'));
    expect(staticIp.diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'error',
        code: 'network.static-ip-unsupported',
        path: 'services.web.networks.backend.ipv4_address',
        message: 'static IP addresses are not supported: pod addresses are assigned by the cluster',
        hint: 'Reach the service by its name `web`.',
      },
      {
        severity: 'error',
        code: 'network.static-ip-unsupported',
        path: 'services.web.networks.backend.ipv6_address',
        message: 'static IP addresses are not supported: pod addresses are assigned by the cluster',
        hint: 'Reach the service by its name `web`.',
      },
    ]);
    const priority = run(doc('{priority: 10}'));
    expect(priority.diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'warning',
        code: 'network.attachment-option-ignored',
        path: 'services.web.networks.backend.priority',
        message: 'networks.backend.priority is ignored on Kubernetes',
      },
    ]);
    const all = run(doc('{link_local_ips: [169.254.0.5], mac_address: "02:42:ac:11:00:02", driver_opts: {a: b}, gw_priority: 1, interface_name: eth1}'));
    expect(summary(all.diagnostics.filter((d) => d.code !== 'network.flat'))).toEqual([
      ['warning', 'network.attachment-option-ignored', 'services.web.networks.backend.driver_opts'],
      ['warning', 'network.attachment-option-ignored', 'services.web.networks.backend.gw_priority'],
      ['warning', 'network.attachment-option-ignored', 'services.web.networks.backend.interface_name'],
      ['warning', 'network.attachment-option-ignored', 'services.web.networks.backend.link_local_ips'],
      ['warning', 'network.attachment-option-ignored', 'services.web.networks.backend.mac_address'],
    ]);
  });

  test('NET-05 service-level mac_address is ignored with a warning', () => {
    expect(run('mac_address: "02:42:ac:11:00:02"').diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'network.attachment-option-ignored',
        path: 'services.web.mac_address',
        message: 'mac_address is ignored on Kubernetes',
      },
    ]);
  });

  test('a network map with null attachments, and memberships of other types', () => {
    const { draft } = run(`
      services:
        web:
          image: nginx:1.27
          networks:
            backend:
            default: {}
      networks:
        backend:
    `);
    expect(draft.network.networks).toEqual(['backend', 'default']);
    expect(summary(run('networks: "backend"').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.networks']]);
    expect(summary(run('networks: [1]').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.networks[0]']]);
    const empty = run('networks: []');
    expect(empty.draft.network.networks).toEqual(['default']);
    expect(empty.diagnostics).toEqual([]);
  });
});

describe('network_mode (design-01 5.11 NET-06)', () => {
  test('host sets hostNetwork and leaves the warning to the translator (T2)', () => {
    const { draft, diagnostics } = run('network_mode: host');
    expect(draft.network.hostNetwork).toBe(true);
    expect(draft.network.networks).toEqual(['default']);
    expect(diagnostics).toEqual([]);
  });

  test('bridge is silent', () => {
    const { draft, diagnostics } = run('network_mode: bridge');
    expect(draft.network.hostNetwork).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  test('none and shared namespaces are refused', () => {
    expect(run('network_mode: none').diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.mode-none-unsupported',
        path: 'services.web.network_mode',
        message: 'network_mode: none is not supported',
        hint: 'Remove `network_mode`.',
      },
    ]);
    expect(run('network_mode: "service:db"').diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.shared-namespace-unsupported',
        path: 'services.web.network_mode',
        message: 'network_mode service:db is not supported: services run in separate pods',
        hint: 'Remove `network_mode` and reach `db` by its service name.',
      },
    ]);
    expect(summary(run('network_mode: "container:abc"').diagnostics)).toEqual([
      ['error', 'network.shared-namespace-unsupported', 'services.web.network_mode'],
    ]);
  });

  test('network_mode with networks is refused', () => {
    const { draft, diagnostics } = run('network_mode: host\nnetworks: [default]');
    expect(draft.network.hostNetwork).toBe(true);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([
      {
        severity: 'error',
        code: 'network.mode-with-networks',
        path: 'services.web.network_mode',
        message: 'network_mode and networks cannot be combined',
      },
    ]);
    expect(run('network_mode: host\nnetworks: []').diagnostics).toEqual([]);
  });

  test('any other value names the one network the container joins, which must be declared', () => {
    const declared = run(`
      services:
        web:
          image: nginx:1.27
          network_mode: backend
      networks:
        backend:
    `);
    expect(declared.draft.network.networks).toEqual(['backend']);
    expect(declared.diagnostics).toEqual([FLAT_INFO]);
    expect(summary(run('network_mode: ghost').diagnostics)).toEqual([['error', 'network.undeclared', 'services.web.network_mode']]);
    expect(summary(run('network_mode: 3').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.network_mode']]);
  });
});

describe('links (design-01 5.11 NET-07)', () => {
  const doc = (links: string) => `
    services:
      web:
        image: nginx:1.27
        links: ${links}
      db:
        image: postgres:16
  `;

  test('a link alias becomes an alias; a bare link or a link to the own name adds nothing', () => {
    const { draft, diagnostics } = run(doc('["db:database", "db", "db:db"]'));
    expect(draft.network.aliases).toEqual(['database']);
    expect(diagnostics).toEqual([]);
  });

  test('link aliases are sanitized like network aliases and merged with them', () => {
    const { draft, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
          networks:
            default:
              aliases: [database]
          links: ["db:data_base", "db:database"]
        db:
          image: postgres:16
    `);
    expect(draft.network.aliases).toEqual(['data-base', 'database']);
    expect(summary(diagnostics.filter((d) => d.code !== 'network.flat'))).toEqual([['warning', 'names.sanitized', 'services.web.links[0]']]);
  });

  test('a link to a service of the other role is accepted', () => {
    const { draft, diagnostics } = run('links: ["cache:redis-cache"]', 'web', {
      sibling: { services: [{ key: 'cache', name: 'cache', aliases: [], published: [] }] },
    });
    expect(draft.network.aliases).toEqual(['redis-cache']);
    expect(diagnostics).toEqual([]);
  });

  test('a link to an unknown service is refused', () => {
    expect(run(doc('[ghost]')).diagnostics).toEqual([
      { severity: 'error', code: 'network.unknown-link', path: 'services.web.links[0]', message: 'link target ghost is not a service' },
    ]);
  });

  test('external_links are ignored with a warning', () => {
    expect(run('external_links: [x]').diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'network.external-links-ignored',
        path: 'services.web.external_links',
        message: 'external_links is ignored: use the name of the target service directly',
      },
    ]);
    expect(run('external_links: []').diagnostics).toEqual([]);
  });
});

describe('hostname and domainname (design-01 5.11 NET-08)', () => {
  test('a DNS label becomes the pod host name', () => {
    const { draft, diagnostics } = run('hostname: api');
    expect(draft.process.hostname).toBe('api');
    expect(diagnostics).toEqual([]);
  });

  test('a name with dots, uppercase or over 63 characters is refused', () => {
    const message = (v: string) =>
      `hostname ${v} must be a single DNS label on Kubernetes (lowercase letters, digits and '-', at most 63 characters)`;
    for (const value of ['api.example.internal', 'Api', 'a'.repeat(64)]) {
      const { draft, diagnostics } = run(`hostname: ${value}`);
      expect(draft.process.hostname).toBeNull();
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'network.invalid-hostname',
          path: 'services.web.hostname',
          message: message(value),
          hint: 'Use a short host name without dots.',
        },
      ]);
    }
  });

  test('a Swarm template placeholder is refused', () => {
    const { draft, diagnostics } = run('hostname: "{{.Node.Hostname}}"');
    expect(draft.process.hostname).toBeNull();
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.swarm-template',
        path: 'services.web.hostname',
        message: 'hostname contains a Swarm template placeholder, which Kubernetes does not expand',
        hint: 'Remove the placeholder.',
      },
    ]);
  });

  test('domainname is ignored with a warning', () => {
    expect(run('domainname: x').diagnostics).toEqual([
      { severity: 'warning', code: 'network.domainname-ignored', path: 'services.web.domainname', message: 'domainname is ignored' },
    ]);
  });
});

describe('dns, dns_search, dns_opt (design-01 5.11 NET-09)', () => {
  test('a nameserver is kept; the secondary-resolver warning is the translator\'s (T2)', () => {
    const { draft, diagnostics } = run('dns: 1.1.1.1');
    expect(draft.network.dns).toEqual(['1.1.1.1']);
    expect(diagnostics).toEqual([]);
  });

  test('more nameservers than 3 - clusterDnsNameservers are refused, never truncated', () => {
    const { draft, diagnostics } = run('dns: [1.1.1.1, 8.8.8.8, 9.9.9.9]');
    expect(draft.network.dns).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.too-many-dns',
        path: 'services.web.dns',
        message: 'at most 2 nameservers can be added next to the cluster DNS (Kubernetes allows 3 in total)',
        hint: 'Keep the 2 most important servers, or resolve the other names through the cluster DNS.',
      },
    ]);
    expect(run('dns: [1.1.1.1, 8.8.8.8]').draft.network.dns).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  test('the limit follows the distribution trait', () => {
    const three = run('dns: [1.1.1.1, 8.8.8.8, 9.9.9.9]', 'web', { traits: { clusterDnsNameservers: 0 } });
    expect(three.draft.network.dns).toEqual(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
    expect(three.diagnostics).toEqual([]);
    const none = run('dns: 1.1.1.1', 'web', { traits: { clusterDnsNameservers: 3 } });
    expect(none.diagnostics.map((d) => d.message)).toEqual([
      'at most 0 nameservers can be added next to the cluster DNS (Kubernetes allows 3 in total)',
    ]);
  });

  test('a nameserver that is not an IP address is refused', () => {
    const { draft, diagnostics } = run('dns: nope');
    expect(draft.network.dns).toEqual([]);
    expect(diagnostics).toEqual([{ severity: 'error', code: 'network.invalid-dns', path: 'services.web.dns', message: 'nope is not an IP address' }]);
    expect(summary(run('dns: ["2001:4860:4860::8888", resolver]').diagnostics)).toEqual([
      ['error', 'network.invalid-dns', 'services.web.dns[1]'],
    ]);
  });

  test('search domains: kept in order, invalid ones refused', () => {
    expect(run('dns_search: [example.internal, corp.example.com.]').draft.network.dnsSearch).toEqual([
      'example.internal',
      'corp.example.com.',
    ]);
    expect(run('dns_search: example.internal').draft.network.dnsSearch).toEqual(['example.internal']);
    const { draft, diagnostics } = run('dns_search: [example.internal, "bad_domain"]');
    expect(draft.network.dnsSearch).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.invalid-dns-search',
        path: 'services.web.dns_search[1]',
        message: 'bad_domain is not a valid DNS search domain',
        hint: 'Write a lowercase domain name, for example `example.internal`.',
      },
    ]);
  });

  test('more than 32 search domains or 2048 characters are refused', () => {
    const many = Array.from({ length: 33 }, (_, i) => `d${i}.example.internal`);
    const tooMany = run(`dns_search: [${many.join(', ')}]`);
    expect(tooMany.draft.network.dnsSearch).toEqual([]);
    expect(summary(tooMany.diagnostics)).toEqual([['error', 'network.too-many-dns-search', 'services.web.dns_search']]);
    expect(run(`dns_search: [${many.slice(0, 32).join(', ')}]`).diagnostics).toEqual([]);

    const long = Array.from({ length: 9 }, (_, i) => `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(50)}${i}.example`);
    const tooLong = run(`dns_search: [${long.join(', ')}]`);
    expect(tooLong.diagnostics.map((d) => [d.code, d.message])).toEqual([
      [
        'network.too-many-dns-search',
        `9 search domains of ${long.join(' ').length} characters exceed the Kubernetes limits of 32 domains and 2048 characters`,
      ],
    ]);
  });

  test('dns options are kept as written', () => {
    const { draft, diagnostics } = run('dns_opt: ["ndots:2", use-vc]');
    expect(draft.network.dnsOptions).toEqual(['ndots:2', 'use-vc']);
    expect(diagnostics).toEqual([]);
    expect(summary(run('dns_opt: ["", ":2", edns0]').diagnostics)).toEqual([
      ['error', 'values.empty', 'services.web.dns_opt[0]'],
      ['error', 'values.empty', 'services.web.dns_opt[1]'],
    ]);
    expect(summary(run('dns_opt: ndots:2').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.dns_opt']]);
  });
});

describe('extra_hosts (design-01 5.11 NET-10)', () => {
  test('list form: host=ip or host:ip, bracketed IPv6, sorted by (ip, hostname)', () => {
    const { draft, diagnostics } = run('extra_hosts: ["somehost=162.242.195.82", "myhostv6:::1", "v6=[::1]", "Mixed.Case=10.0.0.9"]');
    expect(draft.network.extraHosts).toEqual([
      { hostname: 'mixed.case', ip: '10.0.0.9' },
      { hostname: 'somehost', ip: '162.242.195.82' },
      { hostname: 'myhostv6', ip: '::1' },
      { hostname: 'v6', ip: '::1' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('map form with one or several addresses; repeated pairs are merged', () => {
    const { draft, diagnostics } = run('extra_hosts: {db: ["10.0.0.1", "10.0.0.2"], cache: 10.0.0.1}\n');
    expect(draft.network.extraHosts).toEqual([
      { hostname: 'cache', ip: '10.0.0.1' },
      { hostname: 'db', ip: '10.0.0.1' },
      { hostname: 'db', ip: '10.0.0.2' },
    ]);
    expect(diagnostics).toEqual([]);
    expect(run('extra_hosts: ["db=10.0.0.1", "db:10.0.0.1"]').draft.network.extraHosts).toEqual([{ hostname: 'db', ip: '10.0.0.1' }]);
  });

  test('host-gateway is refused', () => {
    const { draft, diagnostics } = run('extra_hosts: ["gw=host-gateway"]');
    expect(draft.network.extraHosts).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.host-gateway-unsupported',
        path: 'services.web.extra_hosts[0]',
        message: 'host-gateway has no fixed address on Kubernetes',
        hint: 'Write the node address, for example `{{ servers.<name>.private_host }}`, when the service runs on that node.',
      },
    ]);
    expect(summary(run('extra_hosts: {gw: host-gateway}').diagnostics)).toEqual([
      ['error', 'network.host-gateway-unsupported', 'services.web.extra_hosts.gw'],
    ]);
  });

  test('an invalid host name or address is refused', () => {
    const { draft, diagnostics } = run('extra_hosts: ["bad_host=1.2.3.4", "db=not-an-ip", "noseparator", "db.internal=10.0.0.5"]');
    expect(draft.network.extraHosts).toEqual([{ hostname: 'db.internal', ip: '10.0.0.5' }]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'network.invalid-extra-host',
        path: 'services.web.extra_hosts[0]',
        message: 'bad_host=1.2.3.4 is not a valid host entry',
        hint: 'Write `host=ip`, for example `db.internal=10.0.0.5`.',
      },
      {
        severity: 'error',
        code: 'network.invalid-extra-host',
        path: 'services.web.extra_hosts[1]',
        message: 'db=not-an-ip is not a valid host entry',
        hint: 'Write `host=ip`, for example `db.internal=10.0.0.5`.',
      },
      {
        severity: 'error',
        code: 'network.invalid-extra-host',
        path: 'services.web.extra_hosts[2]',
        message: 'noseparator is not a valid host entry',
        hint: 'Write `host=ip`, for example `db.internal=10.0.0.5`.',
      },
    ]);
  });
});

describe('top-level networks (design-01 6.1)', () => {
  test('TNET-01 an entry with defaults gives only the flat-network info', () => {
    const { table, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
      networks:
        default:
    `);
    expect([...table.values()]).toEqual([{ key: 'default', external: false, name: 'default', path: 'networks.default' }]);
    expect(diagnostics).toEqual([FLAT_INFO]);
  });

  test('TNET-02 external networks: the accessories network is not needed, any other cannot cross stacks', () => {
    const { table, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
      networks:
        acc:
          external: true
          name: shop-production-accessories_default
        shared:
          external: true
        x:
          external:
            name: y
        local:
          external: false
    `);
    expect(table.get('acc')).toEqual({ key: 'acc', external: true, name: 'shop-production-accessories_default', path: 'networks.acc' });
    expect(table.get('x')).toMatchObject({ external: true, name: 'y' });
    expect(table.get('local')).toMatchObject({ external: false, name: 'local' });
    expect(diagnostics).toEqual([
      FLAT_INFO,
      {
        severity: 'info',
        code: 'networks.not-needed',
        path: 'networks.acc',
        message:
          'shop-production-accessories_default is not needed on Kubernetes: services and accessories share the namespace dockflow-shop-production and resolve each other by name',
      },
      {
        severity: 'warning',
        code: 'networks.external-cross-stack',
        path: 'networks.shared',
        message: 'external network shared cannot connect stacks on Kubernetes: other Dockflow stacks run in other namespaces',
        hint: 'Reach a service of another stack with `<service>.<namespace>.svc.cluster.local`.',
      },
      {
        severity: 'warning',
        code: 'networks.external-cross-stack',
        path: 'networks.x',
        message: 'external network y cannot connect stacks on Kubernetes: other Dockflow stacks run in other namespaces',
        hint: 'Reach a service of another stack with `<service>.<namespace>.svc.cluster.local`.',
      },
    ]);
  });

  test('TNET-02 an external traefik-public is not needed either', () => {
    const { diagnostics } = run('services:\n  web:\n    image: nginx:1.27\nnetworks:\n  traefik-public:\n    external: "true"');
    expect(summary(diagnostics)).toEqual([
      ['info', 'network.flat', 'networks'],
      ['info', 'networks.not-needed', 'networks.traefik-public'],
    ]);
  });

  test('TNET-03 driver, ipam and a local name are ignored with an info', () => {
    const { table, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
      networks:
        back:
          driver: overlay
          ipam:
            config:
              - subnet: 10.1.0.0/24
        named:
          name: custom
          attachable: true
          enable_ipv4: true
          driver_opts: {a: b}
          labels: {team: web}
    `);
    expect(table.get('named')).toMatchObject({ external: false, name: 'custom' });
    expect(diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'info',
        code: 'networks.option-ignored',
        path: 'networks.back.driver',
        message: 'driver is ignored: the pod network is managed by the cluster',
      },
      {
        severity: 'info',
        code: 'networks.option-ignored',
        path: 'networks.back.ipam',
        message: 'ipam is ignored: the pod network is managed by the cluster',
      },
      ...['attachable', 'driver_opts', 'enable_ipv4', 'labels', 'name'].map((option): Diagnostic => ({
        severity: 'info',
        code: 'networks.option-ignored',
        path: `networks.named.${option}`,
        message: `${option} is ignored: the pod network is managed by the cluster`,
      })),
    ]);
  });

  test('TNET-04 internal and enable_ipv6 are not honoured', () => {
    const { diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
      networks:
        a:
          internal: true
        b:
          enable_ipv6: true
        c:
          internal: false
          enable_ipv6: false
    `);
    expect(diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'warning',
        code: 'networks.internal-not-enforced',
        path: 'networks.a.internal',
        message: 'internal: true is not enforced: pods can reach the internet and every other pod',
        hint: 'Remove `internal: true`, or restrict the traffic outside Dockflow: network policies are not generated in this Dockflow version.',
      },
      {
        severity: 'warning',
        code: 'networks.ipv6-ignored',
        path: 'networks.b.enable_ipv6',
        message: 'enable_ipv6 is ignored: the pod network is managed by the cluster',
      },
    ]);
  });

  test('invalid keys, entry types, booleans and extension fields', () => {
    const { table, diagnostics } = run(`
      services:
        web:
          image: nginx:1.27
          networks: ["bad net"]
      networks:
        "bad net":
        list: [a]
        flags:
          external: yes
          internal: maybe
          x-note: kept for humans
    `);
    expect(table.has('bad net')).toBe(true);
    expect(table.get('flags')).toMatchObject({ external: true, name: 'flags' });
    expect(diagnostics.filter((d) => d.code !== 'network.flat')).toEqual([
      {
        severity: 'warning',
        code: 'networks.external-cross-stack',
        path: 'networks.flags',
        message: 'external network flags cannot connect stacks on Kubernetes: other Dockflow stacks run in other namespaces',
        hint: 'Reach a service of another stack with `<service>.<namespace>.svc.cluster.local`.',
      },
      {
        severity: 'warning',
        code: 'values.yaml11-boolean',
        path: 'networks.flags.external',
        message: 'yes is read as true; YAML 1.2 only knows true and false',
        hint: 'Write `true`.',
      },
      {
        severity: 'error',
        code: 'values.invalid-boolean',
        path: 'networks.flags.internal',
        message: 'expected true or false, got maybe',
        hint: 'Write `true` or `false`.',
      },
      {
        severity: 'info',
        code: 'extension.ignored',
        path: 'networks.flags.x-note',
        message: 'x-note is an extension field and is ignored',
      },
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'networks.list',
        message: 'expected mapping, got list',
        hint: 'See the Compose specification for the accepted forms.',
      },
      {
        severity: 'error',
        code: 'names.invalid-key',
        path: 'networks["bad net"]',
        message: 'bad net is not a valid network name',
        hint: 'Use letters, digits, `.`, `_` and `-` only.',
      },
    ]);
  });

  test('no top-level networks, or a value that is not a mapping', () => {
    const ctx = normalizeContext();
    expect(normalizeTopLevelNetworks(undefined, ctx).size).toBe(0);
    expect(normalizeTopLevelNetworks(null, ctx).size).toBe(0);
    expect(ctx.sink.list()).toEqual([]);
    expect(normalizeTopLevelNetworks(['backend'], ctx).size).toBe(0);
    expect(summary(ctx.sink.list())).toEqual([['error', 'values.invalid-type', 'networks']]);
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped', () => {
    const compose = parsedCompose('networks: [ghost]\nhostname: api\ndns: nope');
    const ctx = normalizeContext({ compose });
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    serviceNetwork(draft, compose.services.web, new Map(), ctx);
    expect(draft.network.networks).toEqual(['default']);
    expect(draft.process.hostname).toBeNull();
    expect(ctx.sink.list()).toEqual([]);
  });

  test('every problem is reported in one pass and the documented defaults stay', () => {
    const { draft, diagnostics } = run('networks: [ghost]\nhostname: A.B\ndns: nope\nextra_hosts: ["x=host-gateway"]\nlinks: [ghost]');
    expect(draft.network).toEqual({
      networks: [],
      aliases: [],
      endpointMode: 'vip',
      hostNetwork: false,
      dns: [],
      dnsSearch: [],
      dnsOptions: [],
      extraHosts: [],
    });
    expect(draft.process.hostname).toBeNull();
    expect(summary(diagnostics.filter((d) => d.severity === 'error')).map(([, code]) => code)).toEqual([
      'network.invalid-dns',
      'network.host-gateway-unsupported',
      'network.invalid-hostname',
      'network.unknown-link',
      'network.undeclared',
    ]);
  });
});
