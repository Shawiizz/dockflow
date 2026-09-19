// Direct tests of the ports handler (design-01 5.4: PORT-*, EXP-01..03). Rows marked (T2) in
// design-01 are translator codes: here they assert that the normalizer keeps the entries and
// emits nothing, so the two catalogues stay disjoint (design-01 1.6).

import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import { PORTS_EXPANSION_MAX } from '../../../services/orchestrator/kubernetes/constants';
import type { PortSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { parseExposeEntry, parsePortShort, ports } from '../../../services/orchestrator/kubernetes/normalize/ports';
import { normalizeContext, parsedCompose, serviceDraft } from '../support/builders';

function run(body: string) {
  const compose = parsedCompose(body);
  const ctx = normalizeContext({ compose });
  const draft = serviceDraft('web', ctx);
  ports(draft, compose.services.web, ctx);
  return { draft, ctx, diagnostics: ctx.sink.list() };
}

function summary(diagnostics: Diagnostic[]): [string, string, string][] {
  return diagnostics.map((d) => [d.severity, d.code, d.path]);
}

/** target/published/protocol/mode/hostIp, the fields most rows look at */
function brief(specs: PortSpec[]): [number, number | null, string, string, string | null][] {
  return specs.map((p) => [p.target, p.published, p.protocol, p.mode, p.hostIp]);
}

function port(overrides: Partial<PortSpec>): PortSpec {
  return {
    target: 80,
    published: null,
    protocol: 'TCP',
    mode: 'ingress',
    hostIp: null,
    name: null,
    appProtocol: null,
    path: 'services.web.ports[0]',
    ...overrides,
  };
}

describe('short syntax (design-01 5.4)', () => {
  test('PORT-01 host:container publishes in ingress mode', () => {
    const { draft, diagnostics } = run('ports: ["8080:3000"]');
    expect(draft.ports).toEqual([port({ target: 3000, published: 8080 })]);
    expect(diagnostics).toEqual([]);
  });

  test('PORT-02 a container-only port is not published and the normalizer stays silent (T2 ports.no-published-port)', () => {
    const { draft, diagnostics } = run('ports: [3000]');
    expect(draft.ports).toEqual([port({ target: 3000 })]);
    expect(diagnostics).toEqual([]);
  });

  test('PORT-03 a container range expands, every entry keeping the path of its source', () => {
    const { draft } = run('ports: ["3000-3002"]');
    expect(brief(draft.ports)).toEqual([
      [3000, null, 'TCP', 'ingress', null],
      [3001, null, 'TCP', 'ingress', null],
      [3002, null, 'TCP', 'ingress', null],
    ]);
    expect(draft.ports.map((p) => p.path)).toEqual(['services.web.ports[0]', 'services.web.ports[0]', 'services.web.ports[0]']);
  });

  test('PORT-04 ranges of the same size pair up', () => {
    const { draft, diagnostics } = run('ports: ["9090-9091:8080-8081"]');
    expect(brief(draft.ports)).toEqual([
      [8080, 9090, 'TCP', 'ingress', null],
      [8081, 9091, 'TCP', 'ingress', null],
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('PORT-05 a host range onto one container port is refused', () => {
    const { draft, diagnostics } = run('ports: ["8000-9000:80"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.dynamic-range',
        path: 'services.web.ports[0]',
        message: '8000-9000:80 asks for any free host port in a range; Kubernetes needs a fixed port',
        hint: 'Publish one fixed port, for example `"8000:80"`.',
      },
    ]);
  });

  test('PORT-06 ranges of different sizes are refused', () => {
    const { draft, diagnostics } = run('ports: ["8000-8001:80-82"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.range-mismatch',
        path: 'services.web.ports[0]',
        message: '8000-8001:80-82 maps port ranges of different sizes',
        hint: 'Use ranges of the same length.',
      },
    ]);
  });

  test('PORT-07 the unspecified addresses mean every address', () => {
    for (const spec of ['0.0.0.0:8080:80', '[::]:8080:80', '[0:0:0:0:0:0:0:0]:8080:80']) {
      const { draft, diagnostics } = run(`ports: ["${spec}"]`);
      expect(brief(draft.ports)).toEqual([[80, 8080, 'TCP', 'ingress', null]]);
      expect(diagnostics).toEqual([]);
    }
  });

  test('PORT-08 a host IP: load-balanced (T2), hostport (loopback info), publish none (ignored)', () => {
    const loadBalanced = run('ports: ["127.0.0.1:5432:5432"]');
    expect(brief(loadBalanced.draft.ports)).toEqual([[5432, 5432, 'TCP', 'ingress', '127.0.0.1']]);
    expect(loadBalanced.diagnostics).toEqual([]);

    const explicit = run('ports: ["127.0.0.1:5432:5432"]\nx-dockflow: {publish: loadbalancer}');
    expect(explicit.diagnostics).toEqual([]);

    const hostport = run('ports: ["127.0.0.1:5432:5432"]\nx-dockflow: {publish: hostport}');
    expect(brief(hostport.draft.ports)).toEqual([[5432, 5432, 'TCP', 'ingress', '127.0.0.1']]);
    expect(hostport.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'ports.loopback-host-port',
        path: 'services.web.ports[0]',
        message: '127.0.0.1:5432:5432 binds the host port to 127.0.0.1, so only the node that runs the pod can reach it',
        hint: 'Remove the address to bind the port on every address of that node.',
      },
    ]);

    const none = run('ports: ["127.0.0.1:5432:5432"]\nx-dockflow: {publish: none}');
    expect(brief(none.draft.ports)).toEqual([[5432, 5432, 'TCP', 'ingress', '127.0.0.1']]);
    expect(none.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'ports.host-ip-ignored',
        path: 'services.web.ports[0]',
        message: 'the address 127.0.0.1 of 127.0.0.1:5432:5432 is ignored because `x-dockflow.publish` is `none`',
        hint: 'Remove the address.',
      },
    ]);
  });

  test('PORT-08 any 127.0.0.0/8 address is loopback; another address on a host port is silent', () => {
    expect(summary(run('ports: ["127.1.2.3:5432:5432"]\nx-dockflow: {publish: hostport}').diagnostics)).toEqual([
      ['info', 'ports.loopback-host-port', 'services.web.ports[0]'],
    ]);
    expect(run('ports: ["10.0.0.5:5432:5432"]\nx-dockflow: {publish: hostport}').diagnostics).toEqual([]);
  });

  test('an invalid x-dockflow.publish is load-balancer exposure here (extension.ts reports it)', () => {
    const { draft, diagnostics } = run('ports: ["127.0.0.1:5432:5432"]\nx-dockflow: {publish: public}');
    expect(draft.ports).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  test('PORT-09 IPv6 host addresses, bracketed or not', () => {
    const { draft, diagnostics } = run('ports: ["[::1]:6001:6001", "::1:6000:6000"]');
    expect(brief(draft.ports)).toEqual([
      [6000, 6000, 'TCP', 'ingress', '::1'],
      [6001, 6001, 'TCP', 'ingress', '::1'],
    ]);
    expect(diagnostics).toEqual([]);
    expect(brief(run('ports: ["[2001:DB8::5]:8080:80"]').draft.ports)).toEqual([[80, 8080, 'TCP', 'ingress', '2001:db8::5']]);
  });

  test('PORT-09 ::1 on a node-bound port is refused: the portmap plugin never forwards it', () => {
    const { diagnostics } = run('ports: ["[::1]:6001:6001"]\nx-dockflow: {publish: hostport}');
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.ipv6-loopback-host-port',
        path: 'services.web.ports[0]',
        message:
          '[::1]:6001:6001 binds a host port to ::1, which the CNI portmap plugin never forwards (there is no IPv6 equivalent of route_localnet)',
        hint: 'Use `127.0.0.1`, or keep the port inside the cluster with `x-dockflow.publish: none`.',
      },
    ]);
    expect(summary(run('ports: ["[0:0:0:0:0:0:0:1]:6001:6001"]\nx-dockflow: {publish: hostport}').diagnostics)).toEqual([
      ['error', 'ports.ipv6-loopback-host-port', 'services.web.ports[0]'],
    ]);
  });

  test('PORT-10 protocols in any case; SCTP is accepted by the normalizer whatever the exposure (T2)', () => {
    expect(brief(run('ports: ["6060:6060/UDP"]').draft.ports)).toEqual([[6060, 6060, 'UDP', 'ingress', null]]);
    const sctp = run('ports: ["9000:9000/sctp"]');
    expect(brief(sctp.draft.ports)).toEqual([[9000, 9000, 'SCTP', 'ingress', null]]);
    expect(sctp.diagnostics).toEqual([]);
    const hostport = run('ports: ["9000:9000/sctp"]\nx-dockflow: {publish: hostport}');
    expect(brief(hostport.draft.ports)).toEqual([[9000, 9000, 'SCTP', 'ingress', null]]);
    expect(hostport.diagnostics).toEqual([]);
  });

  test('PORT-11 unknown protocol and invalid IP address', () => {
    const { draft, diagnostics } = run('ports: ["53:53/icmp", "999.1.1.1:80:80"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.invalid',
        path: 'services.web.ports[0]',
        message: '53:53/icmp is not a valid port mapping: unknown protocol icmp',
        hint: 'Use `[ip:]host:container[/protocol]`, for example `"8080:80"`.',
      },
      {
        severity: 'error',
        code: 'ports.invalid',
        path: 'services.web.ports[1]',
        message: '999.1.1.1:80:80 is not a valid port mapping: invalid IP address 999.1.1.1',
        hint: 'Use `[ip:]host:container[/protocol]`, for example `"8080:80"`.',
      },
    ]);
  });

  test('PORT-19 more than PORTS_EXPANSION_MAX ports in one entry is refused', () => {
    const { draft, diagnostics } = run('ports: ["1-200:1-200"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.range-too-large',
        path: 'services.web.ports[0]',
        message: '1-200:1-200 expands to 200 ports; at most 100 are supported per entry',
        hint: 'Publish fewer ports, or use `network_mode: host`.',
      },
    ]);
  });

  test('PORT-19 eleven published ports: the normalizer keeps them all whatever the exposure (T2 ports.too-many-published)', () => {
    for (const body of ['ports: ["7000-7010:7000-7010"]', 'ports: ["7000-7010:7000-7010"]\nx-dockflow: {publish: hostport}']) {
      const { draft, diagnostics } = run(body);
      expect(draft.ports).toHaveLength(11);
      expect(draft.ports.map((p) => p.published)).toEqual(Array.from({ length: 11 }, (_, i) => 7000 + i));
      expect(diagnostics).toEqual([]);
    }
  });

  test('PORT-20 host port 0 asks for a random port: not published', () => {
    const { draft, diagnostics } = run('ports: ["0:80"]');
    expect(brief(draft.ports)).toEqual([[80, null, 'TCP', 'ingress', null]]);
    expect(diagnostics).toEqual([]);
  });

  test('PORT-21 invalid host port, container port 0 and a missing container port', () => {
    const { draft, diagnostics } = run('ports: ["x:80", "80:0", "80:"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['ports.invalid', 'services.web.ports[0]', 'x:80 is not a valid port mapping: invalid host port x'],
      ['ports.invalid', 'services.web.ports[1]', '80:0 is not a valid port mapping: invalid container port 0'],
      ['ports.invalid', 'services.web.ports[2]', '80: is not a valid port mapping: no container port'],
    ]);
  });

  test('PORT-22 model order is (target, protocol, published ?? -1)', () => {
    const { draft } = run('ports: ["9000:9000/udp", "80", "8080:80"]');
    expect(brief(draft.ports)).toEqual([
      [80, null, 'TCP', 'ingress', null],
      [80, 8080, 'TCP', 'ingress', null],
      [9000, 9000, 'UDP', 'ingress', null],
    ]);
    expect(draft.ports.map((p) => p.path)).toEqual(['services.web.ports[1]', 'services.web.ports[2]', 'services.web.ports[0]']);
  });

  test('PORT-23 ports next to network_mode: host are refused and dropped', () => {
    const { draft, diagnostics } = run('network_mode: host\nports: ["80:80"]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.with-host-network',
        path: 'services.web.ports',
        message: 'ports cannot be combined with network_mode: host: the container already listens on the node',
        hint: 'Remove `ports`.',
      },
    ]);
    expect(run('network_mode: host\nports: []').diagnostics).toEqual([]);
    expect(run('network_mode: bridge\nports: ["80:80"]').draft.ports).toHaveLength(1);
  });

  test('the written entries are kept for the injected-route trigger (design-01 7.5)', () => {
    expect(run('ports: ["8080:3000", {target: 80}]').draft.rawPorts).toEqual(['8080:3000', { target: 80 }]);
    expect(run('image: nginx:1.27').draft.rawPorts).toEqual([]);
  });
});

describe('long syntax (design-01 5.4)', () => {
  test('PORT-12 every field is mapped, with the loopback info on a host-mode port', () => {
    const body = `
      ports:
        - name: web
          target: "80"
          host_ip: 127.0.0.1
          published: "8080"
          protocol: TCP
          app_protocol: http
          mode: host
    `;
    const { draft, diagnostics } = run(body);
    expect(draft.ports).toEqual([
      port({ target: 80, published: 8080, protocol: 'TCP', mode: 'host', hostIp: '127.0.0.1', name: 'web', appProtocol: 'http' }),
    ]);
    expect(diagnostics).toEqual([
      {
        severity: 'info',
        code: 'ports.loopback-host-port',
        path: 'services.web.ports[0]',
        message: '127.0.0.1:8080:80/TCP binds the host port to 127.0.0.1, so only the node that runs the pod can reach it',
        hint: 'Remove the address to bind the port on every address of that node.',
      },
    ]);
  });

  test('PORT-12 host_ip ::1 on a host-mode port is refused; another address is silent', () => {
    const v6 = run('ports: [{target: 80, published: 8080, host_ip: "::1", mode: host}]');
    expect(v6.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      [
        'ports.ipv6-loopback-host-port',
        'services.web.ports[0]',
        '[::1]:8080:80 binds a host port to ::1, which the CNI portmap plugin never forwards (there is no IPv6 equivalent of route_localnet)',
      ],
    ]);
    const other = run('ports: [{target: 80, published: 8080, host_ip: 10.0.0.5, mode: host}]');
    expect(brief(other.draft.ports)).toEqual([[80, 8080, 'TCP', 'host', '10.0.0.5']]);
    expect(other.diagnostics).toEqual([]);
  });

  test('a host-mode port is node-bound whatever x-dockflow.publish says', () => {
    const { diagnostics } = run('ports: [{target: 80, published: 8080, host_ip: 127.0.0.1, mode: host}]\nx-dockflow: {publish: none}');
    expect(summary(diagnostics)).toEqual([['info', 'ports.loopback-host-port', 'services.web.ports[0]']]);
  });

  test('PORT-12 an invalid target is refused at its own path', () => {
    const { draft, diagnostics } = run('ports: [{target: 70000}, {target: http}]');
    expect(draft.ports).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.invalid-target',
        path: 'services.web.ports[0].target',
        message: 'target 70000 is not a port number',
        hint: 'Write a port between 1 and 65535.',
      },
      {
        severity: 'error',
        code: 'ports.invalid-target',
        path: 'services.web.ports[1].target',
        message: 'target http is not a port number',
        hint: 'Write a port between 1 and 65535.',
      },
    ]);
  });

  test('a long entry without target is refused', () => {
    expect(summary(run('ports: [{published: 8080}]').diagnostics)).toEqual([['error', 'values.empty', 'services.web.ports[0].target']]);
  });

  test('PORT-12 long protocol and host_ip are validated like the short form', () => {
    const { diagnostics } = run('ports: [{target: 53, protocol: icmp}, {target: 80, published: 8080, host_ip: 999.1.1.1}]');
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['ports.invalid', 'services.web.ports[0].protocol', '53/icmp is not a valid port mapping: unknown protocol icmp'],
      ['ports.invalid', 'services.web.ports[1].host_ip', '999.1.1.1:8080:80 is not a valid port mapping: invalid IP address 999.1.1.1'],
    ]);
    expect(brief(run('ports: [{target: 53, published: 53, protocol: udp, host_ip: "[::]"}]').draft.ports)).toEqual([
      [53, 53, 'UDP', 'ingress', null],
    ]);
  });

  test('PORT-12 an invalid app_protocol is dropped with a warning; a name is documentation only', () => {
    const { draft, diagnostics } = run('ports: [{target: 80, name: "Not A Port Name", app_protocol: "not valid"}]');
    expect(draft.ports).toEqual([port({ name: 'Not A Port Name', appProtocol: null })]);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'ports.invalid-app-protocol',
        path: 'services.web.ports[0].app_protocol',
        message: 'app_protocol not valid is not a valid Kubernetes appProtocol and is dropped',
      },
    ]);
    expect(run('ports: [{target: 443, app_protocol: kubernetes.io/h2c}]').draft.ports[0].appProtocol).toBe('kubernetes.io/h2c');
  });

  test('PORT-13 a long published port: number, decimal string, single-port range; a real range is refused', () => {
    const { draft } = run('ports: [{target: 80, published: 8080}, {target: 81, published: "8081"}, {target: 82, published: "8082-8082"}]');
    expect(draft.ports.map((p) => p.published)).toEqual([8080, 8081, 8082]);
    const range = run('ports: [{target: 80, published: "8083-9000"}]');
    expect(range.draft.ports).toEqual([]);
    expect(range.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.dynamic-range',
        path: 'services.web.ports[0].published',
        message: '8083-9000:80 asks for any free host port in a range; Kubernetes needs a fixed port',
        hint: 'Publish one fixed port, for example `"8083:80"`.',
      },
    ]);
    expect(summary(run('ports: [{target: 80, published: "80-70"}]').diagnostics)).toEqual([
      ['error', 'ports.invalid', 'services.web.ports[0].published'],
    ]);
    expect(run('ports: [{target: 80, published: 0}]').draft.ports[0].published).toBeNull();
  });

  test('PORT-14 host mode needs a published port; any other mode is refused', () => {
    const needsPublished = run('ports: [{target: 80, mode: host}]');
    expect(needsPublished.draft.ports).toEqual([]);
    expect(needsPublished.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.host-mode-needs-published',
        path: 'services.web.ports[0]',
        message: 'mode host requires published',
        hint: 'Set `published:` to the host port.',
      },
    ]);
    const global = run('ports: [{target: 80, mode: global}]');
    expect(global.draft.ports).toEqual([]);
    expect(global.diagnostics).toEqual([
      { severity: 'error', code: 'ports.invalid-mode', path: 'services.web.ports[0].mode', message: 'mode global must be ingress or host' },
    ]);
  });

  test('PORT-24 two node-bound entries on one target stay in the model: the check is the translator\'s (T2)', () => {
    const pairs = [
      '[{target: 80, published: 8080, host_ip: 10.0.0.4, mode: host}, {target: 80, published: 8080, host_ip: 10.0.0.5, mode: host}]',
      '[{target: 80, published: 8080, host_ip: 10.0.0.4, mode: host}, {target: 80, published: 8081, host_ip: 10.0.0.5, mode: host}]',
      '[{target: 80, published: 8080, host_ip: 10.0.0.4}, {target: 80, published: 8080, host_ip: 10.0.0.5}]',
    ];
    for (const pair of pairs) {
      const { draft, diagnostics } = run(`ports: ${pair}`);
      expect(draft.ports).toHaveLength(2);
      expect(diagnostics).toEqual([]);
    }
  });

  test('PORT-25 host ports with replicas are the translator\'s (T2)', () => {
    const { draft, diagnostics } = run('ports: [{target: 80, published: 80, mode: host}]\ndeploy: {replicas: 3}');
    expect(brief(draft.ports)).toEqual([[80, 80, 'TCP', 'host', null]]);
    expect(diagnostics).toEqual([]);
  });

  test('entries of other types and a ports value that is not a list', () => {
    expect(run('ports: [true, null, ["80"]]').diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['values.invalid-type', 'services.web.ports[0]', 'expected string or mapping, got boolean'],
      ['values.invalid-type', 'services.web.ports[1]', 'expected string or mapping, got null'],
      ['values.invalid-type', 'services.web.ports[2]', 'expected string or mapping, got list'],
    ]);
    expect(summary(run('ports: "8080:80"').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.ports']]);
    const empty = run('ports:');
    expect(empty.draft.ports).toEqual([]);
    expect(empty.diagnostics).toEqual([]);
  });
});

describe('duplicates (design-01 1.6, K36)', () => {
  test('PORT-15 one host port published twice: the second entry in model order is reported and dropped', () => {
    const { draft, diagnostics } = run('ports: ["8080:81", "8080:80"]');
    expect(brief(draft.ports)).toEqual([[80, 8080, 'TCP', 'ingress', null]]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.duplicate',
        path: 'services.web.ports[0]',
        message: 'host port 8080/tcp is published twice',
        hint: 'Remove one of the entries.',
      },
    ]);
  });

  test('PORT-15 an exact repeat is a duplicate; another protocol, address or target alone is not', () => {
    const repeat = run('ports: ["8080:80", "8080:80"]');
    expect(repeat.draft.ports).toHaveLength(1);
    expect(summary(repeat.diagnostics)).toEqual([['error', 'ports.duplicate', 'services.web.ports[1]']]);

    const distinct = run('ports: ["8080:80", "8080:80/udp", "10.0.0.5:8080:80", "8081:80", "80", "80"]');
    expect(distinct.diagnostics).toEqual([]);
    expect(distinct.draft.ports).toHaveLength(6);
  });

  test('a long and a short entry on one (published, protocol, host IP) collide too', () => {
    const { draft, diagnostics } = run('ports: ["8080:80", {target: 81, published: 8080, mode: host}]');
    expect(brief(draft.ports)).toEqual([[80, 8080, 'TCP', 'ingress', null]]);
    expect(summary(diagnostics)).toEqual([['error', 'ports.duplicate', 'services.web.ports[1]']]);
  });

  test('PORT-16..18 reserved host ports are the translator\'s (T2)', () => {
    const { draft, diagnostics } = run('ports: ["80:80", "443:443", "22:22", "6443:6443"]');
    expect(draft.ports.map((p) => p.published)).toEqual([22, 80, 443, 6443]);
    expect(diagnostics).toEqual([]);
  });
});

describe('expose (design-01 5.4)', () => {
  test('EXP-01 ports, numbers, ranges and protocols, sorted by (target, protocol)', () => {
    const { draft, diagnostics } = run('expose: ["3000", 3001, "8080-8081/tcp", "53/udp"]');
    expect(draft.expose).toEqual([
      { target: 53, protocol: 'UDP', path: 'services.web.expose[3]' },
      { target: 3000, protocol: 'TCP', path: 'services.web.expose[0]' },
      { target: 3001, protocol: 'TCP', path: 'services.web.expose[1]' },
      { target: 8080, protocol: 'TCP', path: 'services.web.expose[2]' },
      { target: 8081, protocol: 'TCP', path: 'services.web.expose[2]' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('EXP-02 entries already in ports, and repeated entries, are merged', () => {
    expect(run('ports: ["8080:3000"]\nexpose: ["3000"]').draft.expose).toEqual([]);
    expect(run('ports: ["8080:3000"]\nexpose: ["3000/udp", "3000/UDP", "4000", "4000/tcp"]').draft.expose).toEqual([
      { target: 3000, protocol: 'UDP', path: 'services.web.expose[0]' },
      { target: 4000, protocol: 'TCP', path: 'services.web.expose[2]' },
    ]);
  });

  test('EXP-03 an entry that is not a port, and a range of more than 100 ports', () => {
    const { draft, diagnostics } = run('expose: ["http", "1-500"]');
    expect(draft.expose).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'expose.invalid',
        path: 'services.web.expose[0]',
        message: 'http is not a port or port range',
        hint: 'Write `port[/protocol]` or `start-end[/protocol]`.',
      },
      {
        severity: 'error',
        code: 'ports.range-too-large',
        path: 'services.web.expose[1]',
        message: '1-500 expands to 500 ports; at most 100 are supported per entry',
        hint: 'Publish fewer ports, or use `network_mode: host`.',
      },
    ]);
  });

  test('expose keeps its entries next to network_mode: host', () => {
    const { draft, diagnostics } = run('network_mode: host\nexpose: ["9100"]');
    expect(draft.expose).toEqual([{ target: 9100, protocol: 'TCP', path: 'services.web.expose[0]' }]);
    expect(diagnostics).toEqual([]);
  });

  test('expose values of other types', () => {
    expect(summary(run('expose: [{port: 80}]').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.expose[0]']]);
    expect(summary(run('expose: "80"').diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.expose']]);
    expect(summary(run('expose: ["0", "80/icmp", "9-8"]').diagnostics)).toEqual([
      ['error', 'expose.invalid', 'services.web.expose[0]'],
      ['error', 'expose.invalid', 'services.web.expose[1]'],
      ['error', 'expose.invalid', 'services.web.expose[2]'],
    ]);
  });
});

describe('parsers', () => {
  test('parsePortShort follows nat.ParsePortSpec splitting', () => {
    expect(parsePortShort(3000)).toEqual([{ target: 3000, published: null, protocol: 'TCP', hostIp: null }]);
    expect(parsePortShort('10.0.0.5::80/sctp')).toEqual([{ target: 80, published: null, protocol: 'SCTP', hostIp: '10.0.0.5' }]);
    expect(parsePortShort('2001:db8::1:8080:80')).toEqual([{ target: 80, published: 8080, protocol: 'TCP', hostIp: '2001:db8::1' }]);
    expect(parsePortShort('80/')).toEqual({ error: 'invalid', detail: 'no protocol after /' });
    expect(parsePortShort('65536')).toEqual({ error: 'invalid', detail: 'invalid container port 65536' });
    expect(parsePortShort('-1')).toEqual({ error: 'invalid', detail: 'invalid container port -1' });
    expect(parsePortShort('8081-8080:80-81')).toEqual({ error: 'invalid', detail: 'invalid host port 8081-8080' });
    expect(parsePortShort('8000-9000:80/udp')).toEqual({ error: 'dynamic-range', example: '"8000:80/udp"' });
  });

  test('PORTS_EXPANSION_MAX is inclusive', () => {
    const atLimit = parsePortShort(`1-${PORTS_EXPANSION_MAX}`);
    expect(Array.isArray(atLimit) && atLimit.length).toBe(PORTS_EXPANSION_MAX);
    expect(parsePortShort(`1-${PORTS_EXPANSION_MAX + 1}`)).toEqual({ error: 'range-too-large', count: PORTS_EXPANSION_MAX + 1 });
    expect(parseExposeEntry(`1-${PORTS_EXPANSION_MAX + 1}`)).toEqual({ ok: false, error: 'range-too-large', count: PORTS_EXPANSION_MAX + 1 });
  });

  test('parseExposeEntry', () => {
    expect(parseExposeEntry('53/UDP')).toEqual({ ok: true, ports: [{ target: 53, protocol: 'UDP' }] });
    expect(parseExposeEntry(8080)).toEqual({ ok: true, ports: [{ target: 8080, protocol: 'TCP' }] });
    for (const bad of ['', 'http', '0', '80/icmp', '80-', '8080:80']) expect(parseExposeEntry(bad)).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped', () => {
    const compose = parsedCompose('ports: ["bad"]\nexpose: ["3000"]');
    const ctx = normalizeContext({ compose });
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    ports(draft, compose.services.web, ctx);
    expect(draft.ports).toEqual([]);
    expect(draft.expose).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('errors leave the documented defaults and every problem is reported in one pass', () => {
    const { draft, diagnostics } = run('ports: ["8080:80", "x:1", "8000-9000:80", {target: 0}]\nexpose: ["http", "9000"]');
    expect(brief(draft.ports)).toEqual([[80, 8080, 'TCP', 'ingress', null]]);
    expect(draft.expose).toEqual([{ target: 9000, protocol: 'TCP', path: 'services.web.expose[1]' }]);
    expect(diagnostics.map((d) => d.code)).toEqual(['expose.invalid', 'ports.invalid', 'ports.dynamic-range', 'ports.invalid-target']);
  });
});
