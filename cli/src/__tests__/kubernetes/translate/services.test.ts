import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import { ANNOTATIONS, LABELS, MAX_LOAD_BALANCER_PORTS } from '../../../services/orchestrator/kubernetes/constants';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { serviceObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type {
  CanonicalService,
  ExposeSpec,
  PortSpec,
  ProxyIntent,
  RouteSpec,
  StackRole,
} from '../../../services/orchestrator/kubernetes/model/types';
import type { Service } from '../../../services/orchestrator/kubernetes/resources/core';
import { siblingPublishedReservations, type TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import { isTranslatorCode } from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import {
  buildServices,
  checkPublishedPorts,
  HEADLESS_PLACEHOLDER_PORT_NAME,
} from '../../../services/orchestrator/kubernetes/translate/services';
import {
  canonicalService,
  canonicalStack,
  identity,
  proxyIntent,
  type ServiceOverrides,
  type TranslateOptionsOverrides,
  translateContext,
} from '../support/builders';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

const NAMESPACE = identity().namespace;
const SELECTOR = { [LABELS.stack]: NAMESPACE, [LABELS.service]: 'web' };

type PortInput = Partial<PortSpec> & Pick<PortSpec, 'target'>;

/** PortSpecs of `service` in the order given (callers keep the model order), path `ports[i]`. */
function ports(specs: PortInput[], service = 'web'): PortSpec[] {
  return specs.map((spec, index) => ({
    published: null,
    protocol: 'TCP',
    mode: 'ingress',
    hostIp: null,
    name: null,
    appProtocol: null,
    path: `services.${service}.ports[${index}]`,
    ...spec,
  }));
}

/** `"H:C"` entries, TCP, ingress mode. */
function published(pairs: [number, number][], service = 'web'): PortSpec[] {
  return ports(
    pairs.map(([host, target]) => ({ target, published: host })),
    service,
  );
}

function expose(targets: number[], service = 'web'): ExposeSpec[] {
  return targets.map((target, index) => ({ target, protocol: 'TCP', path: `services.${service}.expose[${index}]` }));
}

function route(port: number, router = 'api', service = 'web'): RouteSpec {
  return {
    router,
    rule: 'Host(`api.example.com`)',
    entryPoints: ['websecure'],
    tls: { certResolver: 'letsencrypt' },
    middlewares: [],
    priority: null,
    port,
    origin: 'labels',
    path: `services.${service}.labels["traefik.http.routers.${router}.rule"]`,
  };
}

function service(overrides: ServiceOverrides = {}): CanonicalService {
  return canonicalService(overrides);
}

interface TranslateOverrides extends TranslateOptionsOverrides {
  role?: StackRole;
  proxy?: ProxyIntent | null;
}

interface Translation {
  ctx: TranslateContext;
  objects: Service[];
  diagnostics: Diagnostic[];
  names: string[];
  get(name: string): Service;
}

/** The order translate/index.ts runs: the render-wide checks, then the Services of each service. */
function translate(services: CanonicalService[], overrides: TranslateOverrides = {}): Translation {
  const { role, proxy, ...options } = overrides;
  const stack = canonicalStack({ services, role, proxy });
  const ctx = translateContext(stack, options);
  checkPublishedPorts(ctx);
  const objects = stack.services.flatMap((svc) => buildServices(svc, ctx));
  return {
    ctx,
    objects,
    diagnostics: ctx.sink.list(),
    names: objects.map((o) => o.metadata.name),
    get(name) {
      const found = objects.find((o) => o.metadata.name === name);
      if (found === undefined) throw new Error(`no Service ${name} in ${objects.map((o) => o.metadata.name).join(', ')}`);
      return found;
    },
  };
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}`);
}

/**
 * Structural and semantic validation. S03 matches Service selectors against the workloads of the
 * artifact, which workloads.ts builds; the selectors are asserted directly here instead.
 */
function expectValid(objects: readonly Service[], loadBalancerNodePorts = false): void {
  const issues = failures(validateArtifact(objects, { namespace: NAMESPACE, skipRules: ['S03'], traits: { loadBalancerNodePorts } }));
  expect(formatIssues(issues)).toBe('');
}

describe('shape of the main Service (design-02 6.1, 6.2)', () => {
  test('declared ports with endpoint_mode vip: ClusterIP, targetPort omitted, the selector labels', () => {
    const t = translate([service({ expose: expose([3000]) })]);
    expect(t.objects).toEqual([
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'web',
          namespace: NAMESPACE,
          labels: serviceObjectLabels(identity(), 'app', 'web'),
          annotations: { [ANNOTATIONS.composeService]: 'web' },
        },
        spec: { ports: [{ name: 'tcp-3000', port: 3000, protocol: 'TCP' }], selector: SELECTOR },
      },
    ]);
    expect(t.diagnostics).toEqual([]);
    expectValid(t.objects);
  });

  test('a container-only port gives the ClusterIP Service only and warns that Swarm published it', () => {
    const t = translate([service({ ports: ports([{ target: 3000 }]) })]);
    expect(t.names).toEqual(['web']);
    expect(t.get('web').spec).toEqual({ ports: [{ name: 'tcp-3000', port: 3000, protocol: 'TCP' }], selector: SELECTOR });
    expect(t.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'ports.no-published-port',
        path: 'services.web.ports[0]',
        message: 'Port 3000 of service web has no published port; Swarm published a random node port, Kubernetes exposes it inside the cluster only',
        hint: 'Write `"3000:3000"` to publish it on the nodes, or use `expose`.',
      },
    ]);
    expectValid(t.objects);
  });

  test('declared ports with endpoint_mode dnsrr: headless with the ports, and the -lb Service stays', () => {
    const t = translate([service({ ports: published([[8080, 80]]), network: { endpointMode: 'dnsrr' } })]);
    expect(t.names).toEqual(['web', 'web-lb']);
    expect(t.get('web').spec).toEqual({ clusterIP: 'None', ports: [{ name: 'tcp-80', port: 80, protocol: 'TCP' }], selector: SELECTOR });
    expect(t.get('web-lb').spec.type).toBe('LoadBalancer');
    expectValid(t.objects);
  });

  test('no declared port but a route port: headless with the route port, which is reported as added', () => {
    const t = translate([service({ routes: [route(3000)] })]);
    expect(t.get('web').spec).toEqual({ clusterIP: 'None', ports: [{ name: 'tcp-3000', port: 3000, protocol: 'TCP' }], selector: SELECTOR });
    expect(t.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'routing.port-added',
        path: 'services.web.labels["traefik.http.routers.api.rule"]',
        message: 'Port 3000 of service web is added to its Service for router api',
      },
    ]);
    expectValid(t.objects);
  });

  test('no port at all while headlessServiceNeedsPort: headless with the 9/TCP placeholder port (C9)', () => {
    const t = translate([service()], { traits: { headlessServiceNeedsPort: true } });
    expect(t.objects).toHaveLength(1);
    expect(t.get('web').spec).toEqual({
      clusterIP: 'None',
      ports: [{ name: HEADLESS_PLACEHOLDER_PORT_NAME, port: 9, protocol: 'TCP' }],
      selector: SELECTOR,
    });
    expect(HEADLESS_PLACEHOLDER_PORT_NAME).toBe('placeholder');
    expect(t.diagnostics).toEqual([]);
    expectValid(t.objects);
  });

  test('no port at all with the trait off: headless without a ports key', () => {
    const t = translate([service()], { traits: { headlessServiceNeedsPort: false } });
    expect(t.get('web').spec).toEqual({ clusterIP: 'None', selector: SELECTOR });
    expect('ports' in t.get('web').spec).toBe(false);
    expectValid(t.objects);
  });

  test('the placeholder follows the trait: another port and protocol are used as given', () => {
    const t = translate([service()], { traits: { headlessServiceNeedsPort: true, headlessPlaceholderPort: { port: 7, protocol: 'UDP' } } });
    expect(t.get('web').spec.ports).toEqual([{ name: 'placeholder', port: 7, protocol: 'UDP' }]);
  });

  test('every workload kind gets its main Service, Jobs and DaemonSets included', () => {
    for (const mode of ['replicated-job', 'global'] as const) {
      const t = translate([service({ mode, expose: expose([8080]) })]);
      expect(t.names).toEqual(['web']);
      expect(t.get('web').spec.selector).toEqual(SELECTOR);
    }
  });

  test('names, labels and messages: the Kubernetes name for objects, the compose key for users', () => {
    const svc = service({ composeName: 'web_app', ports: ports([{ target: 3000 }], 'web_app') });
    const t = translate([svc]);
    const main = t.get('web-app');
    expect(main.metadata.annotations).toEqual({ [ANNOTATIONS.composeService]: 'web_app' });
    expect(main.metadata.labels?.[LABELS.service]).toBe('web-app');
    expect(main.spec.selector).toEqual({ [LABELS.stack]: NAMESPACE, [LABELS.service]: 'web-app' });
    expect(t.diagnostics[0]?.message).toStartWith('Port 3000 of service web_app ');
  });

  test('role accessory: the labels carry the role, never a release annotation', () => {
    const t = translate([service({ role: 'accessory', ports: published([[5432, 5432]]) })], { role: 'accessory' });
    for (const object of t.objects) {
      expect(object.metadata.labels?.[LABELS.role]).toBe('accessory');
      expect(object.metadata.annotations).toEqual({ [ANNOTATIONS.composeService]: 'web' });
    }
    expectValid(t.objects);
  });
});

describe('load balancer Service <svc>-lb (design-02 6.3)', () => {
  test('"8080:80": ClusterIP on the container port, LoadBalancer on the published port with a numeric targetPort', () => {
    const t = translate([service({ ports: published([[8080, 80]]) })]);
    expect(t.names).toEqual(['web', 'web-lb']);
    expect(t.get('web').spec).toEqual({ ports: [{ name: 'tcp-80', port: 80, protocol: 'TCP' }], selector: SELECTOR });
    expect(t.get('web-lb')).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'web-lb',
        namespace: NAMESPACE,
        labels: serviceObjectLabels(identity(), 'app', 'web'),
        annotations: { [ANNOTATIONS.composeService]: 'web' },
      },
      spec: {
        type: 'LoadBalancer',
        allocateLoadBalancerNodePorts: false,
        ports: [{ name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 }],
        selector: SELECTOR,
      },
    });
    expect(t.diagnostics).toEqual([]);
    expectValid(t.objects);
  });

  test('lb_source_ranges become loadBalancerSourceRanges', () => {
    const t = translate([
      service({ ports: published([[8080, 80]]), extension: { loadBalancerSourceRanges: ['10.0.0.0/8', '2001:db8::/32'] } }),
    ]);
    expect(t.get('web-lb').spec.loadBalancerSourceRanges).toEqual(['10.0.0.0/8', '2001:db8::/32']);
    expect(t.get('web').spec.loadBalancerSourceRanges).toBeUndefined();
    expectValid(t.objects);
  });

  test('a load balancer that needs node ports: allocateLoadBalancerNodePorts is omitted', () => {
    const t = translate([service({ ports: published([[8080, 80]]) })], { traits: { loadBalancerNodePorts: true } });
    expect('allocateLoadBalancerNodePorts' in t.get('web-lb').spec).toBe(false);
    expectValid(t.objects, true);
  });

  test('exposure modes: hostport and mode host bind the node port in the pod, none exposes nothing', () => {
    const hostport = translate([service({ ports: published([[8080, 80]]), extension: { publish: 'hostport' } })]);
    expect(hostport.names).toEqual(['web']);
    expect(hostport.diagnostics).toEqual([]);

    const host = translate([service({ ports: ports([{ target: 80, published: 8080, mode: 'host', hostIp: '10.0.0.1' }]) })]);
    expect(host.names).toEqual(['web']);
    expect(host.diagnostics).toEqual([]);

    const none = translate([service({ ports: published([[8080, 80]]), extension: { publish: 'none' } })]);
    expect(none.names).toEqual(['web']);
    expect(none.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'ports.publish-none',
        path: 'services.web.x-dockflow.publish',
        message: 'Published ports of service web are not exposed on the nodes',
      },
    ]);
    for (const t of [hostport, host, none]) {
      expect(t.get('web').spec.ports).toEqual([{ name: 'tcp-80', port: 80, protocol: 'TCP' }]);
      expectValid(t.objects);
    }
  });

  test('an explicit publish: loadbalancer behaves as the default', () => {
    const t = translate([service({ ports: published([[8080, 80]]), extension: { publish: 'loadbalancer' } })]);
    expect(t.names).toEqual(['web', 'web-lb']);
  });

  test('host network: no -lb Service, the ClusterIP Service still selects the pod', () => {
    const t = translate([service({ expose: expose([9100]), network: { hostNetwork: true } })]);
    expect(t.names).toEqual(['web']);
    expect(t.get('web').spec).toEqual({ ports: [{ name: 'tcp-9100', port: 9100, protocol: 'TCP' }], selector: SELECTOR });
    expect(t.diagnostics).toEqual([]);
  });

  test('a host IP is refused for load-balancer exposure only (K35)', () => {
    const lb = translate([service({ ports: ports([{ target: 5432, published: 5432, hostIp: '127.0.0.1' }]) })]);
    expect(lb.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.host-ip-unsupported',
        path: 'services.web.ports[0]',
        message: 'services.web.ports[0] binds 127.0.0.1, which a load balancer publishing on every node cannot honour',
        hint: 'Remove the address to publish on every node, use `expose` for in-cluster access only, or set `x-dockflow.publish: hostport` to bind it on the node running the pod.',
      },
    ]);
    for (const publish of ['hostport', 'none'] as const) {
      const t = translate([service({ ports: ports([{ target: 5432, published: 5432, hostIp: '127.0.0.1' }]), extension: { publish } })]);
      expect(codes(t.diagnostics).filter((c) => c.includes('host-ip-unsupported'))).toEqual([]);
    }
    const hostMode = translate([service({ ports: ports([{ target: 5432, published: 5432, hostIp: '127.0.0.1', mode: 'host' }]) })]);
    expect(hostMode.diagnostics).toEqual([]);
  });

  test('0.0.0.0 and :: are no host IP', () => {
    for (const hostIp of ['0.0.0.0', '::']) {
      const t = translate([service({ ports: ports([{ target: 80, published: 8080, hostIp }]) })]);
      expect(t.diagnostics).toEqual([]);
      expect(t.get('web-lb').spec.ports).toEqual([{ name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 }]);
    }
  });

  test('one published port onto two container ports: the second is a published-port conflict', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080 },
          { target: 81, published: 8080, hostIp: '10.0.0.5' },
        ]),
      }),
    ]);
    expect(codes(t.diagnostics)).toEqual([
      'error ports.host-ip-unsupported services.web.ports[1]',
      'error ports.published-conflict services.web.ports[1]',
    ]);
    expect(t.diagnostics[1]?.message).toBe('services.web.ports[1] publishes 8080/tcp, already published by services.web.ports[0]');
    expect(t.get('web-lb').spec.ports).toEqual([{ name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 }]);
  });

  test('one published port onto one container port twice (two host IPs): one -lb port, no conflict', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, hostIp: '10.0.0.5' },
          { target: 80, published: 8080, hostIp: '10.0.0.6' },
        ]),
      }),
    ]);
    expect(codes(t.diagnostics)).toEqual([
      'error ports.host-ip-unsupported services.web.ports[0]',
      'error ports.host-ip-unsupported services.web.ports[1]',
    ]);
    expect(t.get('web-lb').spec.ports).toHaveLength(1);
  });

  test('two published ports onto one container port: two -lb ports with unique names, one ClusterIP port', () => {
    const t = translate([service({ ports: published([[8080, 80], [8081, 80]]) })]);
    expect(t.diagnostics).toEqual([]);
    expect(t.get('web').spec.ports).toEqual([{ name: 'tcp-80', port: 80, protocol: 'TCP' }]);
    expect(t.get('web-lb').spec.ports).toEqual([
      { name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 },
      { name: 'tcp-80-8081', port: 8081, protocol: 'TCP', targetPort: 80 },
    ]);
    expectValid(t.objects);
  });

  test('a repeat never takes a name another port requested: it falls back to a counter', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080 },
          { target: 80, published: 8081 },
          { target: 81, published: 9081, name: 'tcp-80-8081' },
        ]),
      }),
    ]);
    expect(t.diagnostics).toEqual([]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['tcp-80', 'tcp-80-8081']);
    expect(t.get('web-lb').spec.ports).toEqual([
      { name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 },
      { name: 'tcp-80-2', port: 8081, protocol: 'TCP', targetPort: 80 },
      { name: 'tcp-80-8081', port: 9081, protocol: 'TCP', targetPort: 81 },
    ]);
    expectValid(t.objects);
  });

  test('changing the published port never renames the -lb port (K30)', () => {
    const before = translate([service({ ports: published([[8080, 80]]) })]).get('web-lb');
    const after = translate([service({ ports: published([[9090, 80]]) })]).get('web-lb');
    expect(before.spec.ports?.map((p) => p.name)).toEqual(['tcp-80']);
    expect(after.spec.ports).toEqual([{ name: 'tcp-80', port: 9090, protocol: 'TCP', targetPort: 80 }]);
  });

  test('-lb ports are sorted by (published port, protocol)', () => {
    const t = translate([service({ ports: published([[9090, 80], [8080, 81]]) })]);
    expect(t.get('web-lb').spec.ports).toEqual([
      { name: 'tcp-81', port: 8080, protocol: 'TCP', targetPort: 81 },
      { name: 'tcp-80', port: 9090, protocol: 'TCP', targetPort: 80 },
    ]);
    expect(t.get('web').spec.ports?.map((p) => p.port)).toEqual([80, 81]);
  });

  test('TCP and UDP on one port are two entries of both Services', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 53, published: 53, protocol: 'TCP' },
          { target: 53, published: 53, protocol: 'UDP' },
        ]),
      }),
    ]);
    expect(t.get('web').spec.ports).toEqual([
      { name: 'tcp-53', port: 53, protocol: 'TCP' },
      { name: 'udp-53', port: 53, protocol: 'UDP' },
    ]);
    expect(t.get('web-lb').spec.ports).toEqual([
      { name: 'tcp-53', port: 53, protocol: 'TCP', targetPort: 53 },
      { name: 'udp-53', port: 53, protocol: 'UDP', targetPort: 53 },
    ]);
    expectValid(t.objects);
  });

  test('a range expands to one port per entry in each Service', () => {
    const t = translate([service({ ports: published([[9000, 9000], [9001, 9001]]) })]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['tcp-9000', 'tcp-9001']);
    expect(t.get('web-lb').spec.ports?.map((p) => [p.name, p.port, p.targetPort])).toEqual([
      ['tcp-9000', 9000, 9000],
      ['tcp-9001', 9001, 9001],
    ]);
  });

  test('app_protocol reaches both Services', () => {
    const t = translate([service({ ports: ports([{ target: 80, published: 8080, appProtocol: 'http' }]) })]);
    expect(t.get('web').spec.ports).toEqual([{ name: 'tcp-80', port: 80, protocol: 'TCP', appProtocol: 'http' }]);
    expect(t.get('web-lb').spec.ports).toEqual([{ name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80, appProtocol: 'http' }]);
    expectValid(t.objects);
  });
});

describe('MAX_LOAD_BALANCER_PORTS and SCTP (K72)', () => {
  const range = (count: number): [number, number][] => Array.from({ length: count }, (_, i): [number, number] => [7000 + i, 7000 + i]);

  test(`${MAX_LOAD_BALANCER_PORTS} published ports are accepted`, () => {
    expect(MAX_LOAD_BALANCER_PORTS).toBe(10);
    const t = translate([service({ ports: published(range(10)) })]);
    expect(t.diagnostics).toEqual([]);
    expect(t.get('web-lb').spec.ports).toHaveLength(10);
    expectValid(t.objects);
  });

  test('11 published ports are refused through the load balancer and accepted with hostport', () => {
    const t = translate([service({ ports: published(range(11)) })]);
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.too-many-published',
        path: 'services.web.ports',
        message:
          'Service web publishes 11 ports through its load balancer; ServiceLB runs one container per port on every node, so at most 10 are accepted',
        hint: 'Publish fewer ports, or set `x-dockflow.publish: hostport`.',
      },
    ]);
    const hostport = translate([service({ ports: published(range(11)), extension: { publish: 'hostport' } })]);
    expect(hostport.diagnostics).toEqual([]);
  });

  test('SCTP is refused for load-balancer exposure and left out of the -lb Service', () => {
    const t = translate([service({ ports: ports([{ target: 9000, published: 9000, protocol: 'SCTP' }]) })]);
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.sctp-loadbalancer',
        path: 'services.web.ports[0]',
        message: 'services.web.ports[0] publishes 9000/sctp through the load balancer, which forwards only TCP and UDP',
        hint: 'Set `x-dockflow.publish: hostport` to bind the port on the node running the pod, or use `expose` for in-cluster access only.',
      },
    ]);
    expect(t.names).toEqual(['web']);
    expect(t.get('web').spec.ports).toEqual([{ name: 'sctp-9000', port: 9000, protocol: 'SCTP' }]);
  });

  test('SCTP is accepted with hostport, in mode host and on expose', () => {
    const hostport = translate([
      service({ ports: ports([{ target: 9000, published: 9000, protocol: 'SCTP' }]), extension: { publish: 'hostport' } }),
    ]);
    const host = translate([service({ ports: ports([{ target: 9000, published: 9000, protocol: 'SCTP', mode: 'host' }]) })]);
    const exposed = translate([service({ expose: [{ target: 9000, protocol: 'SCTP', path: 'services.web.expose[0]' }] })]);
    for (const t of [hostport, host, exposed]) {
      expect(t.diagnostics).toEqual([]);
      expect(t.names).toEqual(['web']);
      expect(t.get('web').spec.ports).toEqual([{ name: 'sctp-9000', port: 9000, protocol: 'SCTP' }]);
      expectValid(t.objects);
    }
  });
});

describe('aliases and the governing Service (design-02 6.4, 6.5)', () => {
  test('an alias Service is the main Service under another name, labelled with the service', () => {
    const t = translate([service({ ports: published([[8080, 80]]), network: { aliases: ['database', 'web'] } })]);
    expect(t.names).toEqual(['web', 'database', 'web-lb']);
    const main = t.get('web');
    const alias = t.get('database');
    expect(alias).toEqual({ ...main, metadata: { ...main.metadata, name: 'database' } });
    expect(alias.metadata.labels?.[LABELS.service]).toBe('web');
    expect(alias.spec.ports).not.toBe(main.spec.ports);
    expectValid(t.objects);
  });

  test('aliases of a port-less service are headless with the placeholder too', () => {
    const t = translate([service({ network: { aliases: ['cache'] } })]);
    expect(t.get('cache').spec).toEqual(t.get('web').spec);
    expect(t.get('cache').spec.clusterIP).toBe('None');
  });

  test('a StatefulSet gets <svc>-hl, headless with the service ports, whatever the main shape', () => {
    const t = translate([service({ extension: { kind: 'statefulset' }, ports: published([[5432, 5432]]) })]);
    expect(t.names).toEqual(['web', 'web-lb', 'web-hl']);
    expect(t.get('web').spec.clusterIP).toBeUndefined();
    expect(t.get('web-hl')).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'web-hl',
        namespace: NAMESPACE,
        labels: serviceObjectLabels(identity(), 'app', 'web'),
        annotations: { [ANNOTATIONS.composeService]: 'web' },
      },
      spec: { clusterIP: 'None', ports: [{ name: 'tcp-5432', port: 5432, protocol: 'TCP' }], selector: SELECTOR },
    });
    expectValid(t.objects);
  });

  test('a port-less StatefulSet: <svc>-hl carries the placeholder, or no port with the trait off', () => {
    const on = translate([service({ extension: { kind: 'statefulset' } })], { traits: { headlessServiceNeedsPort: true } });
    expect(on.get('web-hl').spec.ports).toEqual([{ name: 'placeholder', port: 9, protocol: 'TCP' }]);
    const off = translate([service({ extension: { kind: 'statefulset' } })], { traits: { headlessServiceNeedsPort: false } });
    expect(off.get('web-hl').spec).toEqual({ clusterIP: 'None', selector: SELECTOR });
    expectValid(on.objects);
  });

  test('no -hl Service for the other kinds', () => {
    for (const overrides of [{}, { mode: 'global' as const }, { mode: 'replicated-job' as const }]) {
      expect(translate([service({ ...overrides, expose: expose([80]) })]).names).toEqual(['web']);
    }
  });
});

describe('port names (design-02 6.7, DESIGN-CORE 5.4)', () => {
  test('a requested name is used on the ClusterIP and -lb Services', () => {
    const t = translate([service({ ports: ports([{ target: 80, published: 8080, name: 'http' }]) })]);
    expect(t.get('web').spec.ports?.[0]?.name).toBe('http');
    expect(t.get('web-lb').spec.ports?.[0]?.name).toBe('http');
    expectValid(t.objects);
  });

  test('the first entry in model order keeps a requested name, later ones fall back', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, name: 'api' },
          { target: 81, published: 8081, name: 'api' },
        ]),
      }),
    ]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['api', 'tcp-81']);
    expect(t.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['api', 'tcp-81']);
    expect(t.diagnostics).toEqual([]);
  });

  test('a named range: the first expanded port keeps the name', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 8000, published: 8000, name: 'api' },
          { target: 8001, published: 8001, name: 'api' },
          { target: 8002, published: 8002, name: 'api' },
        ]),
      }),
    ]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['api', 'tcp-8001', 'tcp-8002']);
    expect(t.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['api', 'tcp-8001', 'tcp-8002']);
  });

  test('two names or app_protocol values on one container port: the first is used, with a warning', () => {
    const names = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, name: 'web' },
          { target: 80, published: 8081, name: 'http' },
        ]),
      }),
    ]);
    expect(names.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'ports.name-conflict',
        path: 'services.web.ports[1]',
        message: 'Port 80/tcp of service web has two different names or app_protocol values; the first is used',
      },
    ]);
    expect(names.get('web').spec.ports?.map((p) => p.name)).toEqual(['web']);
    expect(names.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['web', 'http']);

    const protocols = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, appProtocol: 'http' },
          { target: 80, published: 8081, appProtocol: 'https' },
        ]),
      }),
    ]);
    expect(codes(protocols.diagnostics)).toEqual(['warning ports.name-conflict services.web.ports[1]']);
    expect(protocols.get('web').spec.ports?.[0]?.appProtocol).toBe('http');
    expect(protocols.get('web-lb').spec.ports?.map((p) => p.appProtocol)).toEqual(['http', 'https']);
  });

  test('a name on one entry and none on the other is no conflict; the name is taken', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080 },
          { target: 80, published: 8081, name: 'http' },
        ]),
      }),
    ]);
    expect(t.diagnostics).toEqual([]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['http']);
    expect(t.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['tcp-80', 'http']);
  });

  test('an invalid requested name falls back to <protocol>-<port> without a diagnostic', () => {
    const t = translate([service({ ports: ports([{ target: 80, published: 8080, name: '1234' }]) })]);
    expect(t.get('web').spec.ports?.[0]?.name).toBe('tcp-80');
    expect(t.diagnostics).toEqual([]);
  });

  test("a requested name of another port's generated form is not taken, so names stay unique", () => {
    const t = translate([service({ expose: expose([80]), ports: ports([{ target: 81, published: 8081, name: 'tcp-80' }]) })]);
    expect(t.get('web').spec.ports?.map((p) => p.name)).toEqual(['tcp-80', 'tcp-81']);
    expect(t.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['tcp-81']);
    expectValid(t.objects);

    const later = translate([service({ expose: expose([81]), ports: ports([{ target: 80, published: 8080, name: 'tcp-81' }]) })]);
    expect(later.get('web').spec.ports?.map((p) => p.name)).toEqual(['tcp-80', 'tcp-81']);
    expect(later.get('web-lb').spec.ports?.map((p) => p.name)).toEqual(['tcp-80']);

    const own = translate([service({ ports: ports([{ target: 80, published: 8080, name: 'tcp-80' }]) })]);
    expect(own.get('web').spec.ports?.[0]?.name).toBe('tcp-80');
  });

  test('protocol is emitted on every Service port (K30)', () => {
    const t = translate([
      service({
        extension: { kind: 'statefulset' },
        ports: ports([{ target: 80, published: 8080 }, { target: 81 }]),
        expose: expose([82]),
        routes: [route(83)],
        network: { aliases: ['alias'] },
      }),
    ]);
    const all = t.objects.flatMap((o) => o.spec.ports ?? []);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) expect(p.protocol).toBe('TCP');
    expectValid(t.objects);
  });
});

describe('route ports (routing.port-added)', () => {
  test('a label route on a port the service does not declare adds it as TCP', () => {
    const t = translate([service({ ports: published([[8080, 80]]), routes: [route(80, 'site'), route(9000, 'admin')] })]);
    expect(t.get('web').spec.ports).toEqual([
      { name: 'tcp-80', port: 80, protocol: 'TCP' },
      { name: 'tcp-9000', port: 9000, protocol: 'TCP' },
    ]);
    expect(t.get('web-lb').spec.ports?.map((p) => p.port)).toEqual([8080]);
    expect(codes(t.diagnostics)).toEqual(['info routing.port-added services.web.labels["traefik.http.routers.admin.rule"]']);
  });

  test('a route on a UDP-only port still needs the TCP port', () => {
    const t = translate([service({ ports: ports([{ target: 53, published: 53, protocol: 'UDP' }]), routes: [route(53)] })]);
    expect(t.get('web').spec.ports?.map((p) => `${p.name} ${p.port}/${p.protocol}`)).toEqual(['tcp-53 53/TCP', 'udp-53 53/UDP']);
    expect(codes(t.diagnostics)).toEqual(['info routing.port-added services.web.labels["traefik.http.routers.api.rule"]']);
  });
});

describe('reserved host ports (design-02 6.6, DESIGN-CORE 6.3, C2)', () => {
  const traitPorts = k3sDistribution.traits.reservedHostPorts;

  test('the distribution list includes 22/TCP for SSH', () => {
    expect(traitPorts).toContainEqual({ port: 22, protocol: 'TCP', reason: 'SSH' });
  });

  for (const reserved of traitPorts) {
    test(`${reserved.port}/${reserved.protocol} is reserved by the distribution (${reserved.reason})`, () => {
      const t = translate([service({ ports: ports([{ target: 80, published: reserved.port, protocol: reserved.protocol }]) })], {
        extraReservedHostPorts: [],
      });
      expect(t.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'ports.reserved-host-port',
          path: 'services.web.ports[0]',
          message: `services.web.ports[0] publishes ${reserved.port}/${reserved.protocol.toLowerCase()}, which is reserved on the nodes (${reserved.reason})`,
          hint: `Publish another port; ${reserved.reason} uses this one on every node.`,
        },
      ]);
    });
  }

  test('the host port is compared, never the container port', () => {
    expect(codes(translate([service({ ports: published([[22, 80]]) })]).diagnostics)).toEqual([
      'error ports.reserved-host-port services.web.ports[0]',
    ]);
    expect(translate([service({ ports: published([[8080, 22]]) })]).diagnostics).toEqual([]);
    expect(translate([service({ expose: expose([22]) })]).diagnostics).toEqual([]);
  });

  test('a non-default SSH port of servers.yml is reserved through extraReservedHostPorts', () => {
    const options = { extraReservedHostPorts: [{ port: 32230, protocol: 'TCP' as const, reason: 'SSH port of server_1' }] };
    const t = translate([service({ ports: published([[32230, 80]]) })], options);
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.reserved-host-port',
        path: 'services.web.ports[0]',
        message: 'services.web.ports[0] publishes 32230/tcp, which is reserved on the nodes (SSH port of server_1)',
        hint: 'Publish another port; SSH port of server_1 uses this one on every node.',
      },
    ]);
    expect(translate([service({ ports: published([[32230, 80]]) })], { extraReservedHostPorts: [] }).diagnostics).toEqual([]);
  });

  test("the sibling role's published ports are reserved with a reason naming the sibling service", () => {
    const extraReservedHostPorts = siblingPublishedReservations('accessory', [{ key: 'db', published: [{ port: 5432, protocol: 'TCP' }] }]);
    const t = translate([service({ ports: published([[5432, 5432]]) })], { extraReservedHostPorts });
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.reserved-host-port',
        path: 'services.web.ports[0]',
        message: 'services.web.ports[0] publishes 5432/tcp, which is reserved on the nodes (published by accessories service db)',
        hint: 'Publish another port; published by accessories service db uses this one on every node.',
      },
    ]);
  });

  test('a Dockflow-owned Traefik on the cluster reserves 80/TCP and 443/TCP whatever the stack proxy (K28)', () => {
    const svc = (role: StackRole): CanonicalService =>
      service({ role, ports: ports([{ target: 80, published: 80 }, { target: 8443, published: 443 }]) });
    const cases: TranslateOverrides[] = [
      { traefikOnCluster: true, proxy: null },
      { traefikOnCluster: true, role: 'accessory', proxy: proxyIntent({ domain: null }) },
      { traefikOnCluster: true, role: 'accessory', proxy: null },
    ];
    for (const overrides of cases) {
      const t = translate([svc(overrides.role ?? 'app')], overrides);
      expect(t.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'ports.reserved-host-port',
          path: 'services.web.ports[0]',
          message: 'services.web.ports[0] publishes 80/tcp, which is reserved on the nodes (Dockflow Traefik)',
          hint: 'Route the service through the proxy with traefik labels, or publish another port.',
        },
        {
          severity: 'error',
          code: 'ports.reserved-host-port',
          path: 'services.web.ports[1]',
          message: 'services.web.ports[1] publishes 443/tcp, which is reserved on the nodes (Dockflow Traefik)',
          hint: 'Route the service through the proxy with traefik labels, or publish another port.',
        },
      ]);
    }
    expect(translate([svc('app')], { traefikOnCluster: false, proxy: proxyIntent() }).diagnostics).toEqual([]);
  });

  test('the nginx host plugin ports are reserved with their own reason while the proxy is off (T-EXPO-14)', () => {
    const nginx = [
      { port: 80, protocol: 'TCP' as const, reason: 'nginx host plugin' },
      { port: 443, protocol: 'TCP' as const, reason: 'nginx host plugin' },
    ];
    const svc = service({ ports: ports([{ target: 80, published: 80 }, { target: 8443, published: 443 }]) });
    const t = translate([svc], { extraReservedHostPorts: nginx, traefikOnCluster: false, proxy: null });
    expect(t.diagnostics.map((d) => d.message)).toEqual([
      'services.web.ports[0] publishes 80/tcp, which is reserved on the nodes (nginx host plugin)',
      'services.web.ports[1] publishes 443/tcp, which is reserved on the nodes (nginx host plugin)',
    ]);
    const both = translate([svc], { extraReservedHostPorts: nginx, traefikOnCluster: true });
    expect(both.diagnostics[0]?.message).toEndWith('(nginx host plugin)');
    const neither = translate([svc], { extraReservedHostPorts: [], traefikOnCluster: false, proxy: null });
    expect(neither.diagnostics).toEqual([]);
    expect(neither.get('web-lb').spec.ports?.map((p) => p.port)).toEqual([80, 443]);
  });

  test('the Traefik reservation is TCP only', () => {
    const t = translate([service({ ports: ports([{ target: 80, published: 80, protocol: 'UDP' }]) })], { traefikOnCluster: true });
    expect(t.diagnostics).toEqual([]);
  });

  test('host bindings and host-network container ports are compared like load-balancer ports', () => {
    const hostport = translate([service({ ports: published([[22, 2222]]), extension: { publish: 'hostport' } })]);
    expect(codes(hostport.diagnostics)).toEqual(['error ports.reserved-host-port services.web.ports[0]']);
    const host = translate([service({ ports: ports([{ target: 80, published: 6443, mode: 'host' }]) })]);
    expect(codes(host.diagnostics)).toEqual(['error ports.reserved-host-port services.web.ports[0]']);
    const hostNetwork = translate([service({ expose: expose([10250]), network: { hostNetwork: true } })]);
    expect(hostNetwork.diagnostics[0]?.message).toBe(
      'services.web.expose[0] publishes 10250/tcp, which is reserved on the nodes (kubelet)',
    );
  });

  test('ports that are not exposed on the nodes are never compared', () => {
    const none = translate([service({ ports: published([[22, 80]]), extension: { publish: 'none' } })]);
    expect(codes(none.diagnostics)).toEqual(['info ports.publish-none services.web.x-dockflow.publish']);
    const sctp = translate([service({ ports: ports([{ target: 22, published: 22, protocol: 'SCTP' }]) })], {
      extraReservedHostPorts: [{ port: 22, protocol: 'SCTP', reason: 'test' }],
    });
    expect(codes(sctp.diagnostics)).toEqual(['error ports.sctp-loadbalancer services.web.ports[0]']);
  });
});

describe('published-port conflicts inside the render (design-02 6.6)', () => {
  const web = (): CanonicalService => service({ composeName: 'web', ports: published([[8080, 80]], 'web') });
  const admin = (): CanonicalService => service({ composeName: 'admin', ports: published([[8080, 3000]], 'admin') });

  test('the second service publishing a port is refused, naming the first', () => {
    const t = translate([admin(), web()]);
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.published-conflict',
        path: 'services.web.ports[0]',
        message: 'services.web.ports[0] publishes 8080/tcp, already published by services.admin.ports[0]',
        hint: 'Publish each node port from one service only.',
      },
    ]);
    expect(t.ctx.publishedOwners.get('8080/TCP')).toBe('services.admin.ports[0]');
  });

  test('SC-06: web and admin both "8080:80", the second in code-unit order is refused', () => {
    const t = translate([
      service({ composeName: 'web', ports: published([[8080, 80]], 'web') }),
      service({ composeName: 'admin', ports: published([[8080, 80]], 'admin') }),
    ]);
    expect(codes(t.diagnostics)).toEqual(['error ports.published-conflict services.web.ports[0]']);
    expect(t.names).toEqual(['web', 'web-lb', 'admin', 'admin-lb']);
  });

  test('the outcome does not depend on the order of the service list', () => {
    const forward = translate([admin(), web()]);
    const backward = translate([web(), admin()]);
    expect(backward.diagnostics).toEqual(forward.diagnostics);
    expect([...backward.ctx.publishedOwners]).toEqual([...forward.ctx.publishedOwners]);
  });

  test('a load-balancer port and a host binding of another service conflict', () => {
    const api = service({ composeName: 'api', ports: ports([{ target: 80, published: 8080, mode: 'host' }], 'api') });
    const t = translate([api, web()]);
    expect(codes(t.diagnostics)).toEqual(['error ports.published-conflict services.web.ports[0]']);
    expect(t.diagnostics[0]?.message).toBe('services.web.ports[0] publishes 8080/tcp, already published by services.api.ports[0]');
  });

  test('a host-network container port conflicts with a published port', () => {
    const agent = service({ composeName: 'agent', expose: expose([8080], 'agent'), network: { hostNetwork: true } });
    const t = translate([agent, web()]);
    expect(codes(t.diagnostics)).toEqual(['error ports.published-conflict services.web.ports[0]']);
  });

  test('inside one service: a host binding on a port its load balancer already publishes', () => {
    const t = translate([
      service({
        ports: ports([
          { target: 80, published: 8080 },
          { target: 81, published: 8080, mode: 'host', hostIp: '10.0.0.5' },
        ]),
      }),
    ]);
    expect(codes(t.diagnostics)).toEqual(['error ports.published-conflict services.web.ports[1]']);
  });

  test('another protocol on the same number is no conflict', () => {
    const dns = service({ composeName: 'dns', ports: ports([{ target: 8080, published: 8080, protocol: 'UDP' }], 'dns') });
    expect(translate([dns, web()]).diagnostics).toEqual([]);
  });

  test('a reserved port is refused for each service and not recorded as published', () => {
    const a = service({ composeName: 'a', ports: published([[22, 80]], 'a') });
    const b = service({ composeName: 'b', ports: published([[22, 81]], 'b') });
    const t = translate([a, b]);
    expect(codes(t.diagnostics)).toEqual([
      'error ports.reserved-host-port services.a.ports[0]',
      'error ports.reserved-host-port services.b.ports[0]',
    ]);
    expect(t.ctx.publishedOwners.has('22/TCP')).toBe(false);
  });

  test('running the check twice reports nothing new', () => {
    const t = translate([admin(), web()]);
    checkPublishedPorts(t.ctx);
    expect(t.ctx.sink.list()).toEqual(t.diagnostics);
  });
});

describe('ports bound on the node running the pod (K36)', () => {
  test('host bindings with several replicas are refused; global services and one replica are not', () => {
    const t = translate([service({ ports: published([[8080, 80]]), extension: { publish: 'hostport' }, replicas: 2 })]);
    expect(t.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.host-port-replicas',
        path: 'services.web.deploy.replicas',
        message: 'web binds node port 8080/tcp and runs 2 replicas, but two pods cannot bind one port on one node',
        hint: 'Publish through the load balancer (`x-dockflow.publish: loadbalancer`), or run one pod per node with `deploy.mode: global`.',
      },
    ]);
    const hostMode = translate([service({ ports: ports([{ target: 80, published: 80, mode: 'host' }]), replicas: 3 })]);
    expect(codes(hostMode.diagnostics)).toEqual(['error ports.host-port-replicas services.web.deploy.replicas']);
    const global = translate([service({ ports: ports([{ target: 80, published: 80, mode: 'host' }]), mode: 'global', replicas: 3 })]);
    expect(global.diagnostics).toEqual([]);
    const one = translate([service({ ports: ports([{ target: 80, published: 80, mode: 'host' }]), replicas: 1 })]);
    expect(one.diagnostics).toEqual([]);
    const lb = translate([service({ ports: published([[8080, 80]]), replicas: 3 })]);
    expect(lb.diagnostics).toEqual([]);
  });

  test('the refusal names the first node binding in model order, as pod.ts does', () => {
    const bindings: PortInput[] = [
      { target: 9000, published: 9000, mode: 'host' },
      { target: 80, published: 8080, mode: 'host' },
    ];
    const t = translate([service({ ports: ports(bindings), replicas: 2 })]);
    expect(t.diagnostics.map((d) => d.message)).toEqual([
      'web binds node port 9000/tcp and runs 2 replicas, but two pods cannot bind one port on one node',
    ]);
    // A load-balanced port earlier in the list binds nothing on the node, so it is never named.
    const mixed = translate([
      service({
        ports: ports([
          { target: 80, published: 8080 },
          { target: 81, published: 9081, mode: 'host' },
        ]),
        replicas: 2,
      }),
    ]);
    expect(mixed.diagnostics.map((d) => d.message)).toEqual([
      'web binds node port 9081/tcp and runs 2 replicas, but two pods cannot bind one port on one node',
    ]);
  });

  test('a host-network pod binds its container ports: several replicas are refused too', () => {
    const t = translate([service({ expose: expose([9100]), network: { hostNetwork: true }, replicas: 2 })]);
    expect(t.diagnostics[0]?.message).toBe('web binds node port 9100/tcp and runs 2 replicas, but two pods cannot bind one port on one node');
    expect(translate([service({ network: { hostNetwork: true }, replicas: 2 })]).diagnostics).toEqual([]);
  });

  test('two node bindings of one container port are refused, whatever their host ports and addresses', () => {
    const samePort = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, mode: 'host', hostIp: '127.0.0.1' },
          { target: 80, published: 8080, mode: 'host', hostIp: '10.0.0.5' },
        ]),
      }),
    ]);
    expect(samePort.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ports.host-duplicate-target',
        path: 'services.web.ports[1]',
        message: 'services.web.ports[1] binds container port 80/tcp on the node a second time',
        hint: 'Bind the container port once in `mode: host`, or use the default ingress mode.',
      },
    ]);
    const otherPort = translate([
      service({
        ports: ports([
          { target: 80, published: 8080, mode: 'host' },
          { target: 80, published: 8081, mode: 'host' },
        ]),
      }),
    ]);
    expect(codes(otherPort.diagnostics)).toEqual(['error ports.host-duplicate-target services.web.ports[1]']);
    const hostport = translate([service({ ports: published([[8080, 80], [8081, 80]]), extension: { publish: 'hostport' } })]);
    expect(codes(hostport.diagnostics)).toEqual(['error ports.host-duplicate-target services.web.ports[1]']);
  });

  test('two load-balanced publications of one container port are fine', () => {
    expect(translate([service({ ports: published([[8080, 80], [8081, 80]]) })]).diagnostics).toEqual([]);
  });
});

describe('determinism and catalogue', () => {
  const stackServices = (): CanonicalService[] => [
    service({ composeName: 'api', ports: published([[8080, 80]], 'api'), network: { aliases: ['backend'] } }),
    service({ composeName: 'db', extension: { kind: 'statefulset' }, expose: expose([5432], 'db') }),
    service({ composeName: 'web', routes: [route(3000, 'site', 'web')] }),
  ];

  test('translating twice gives identical objects and diagnostics', () => {
    const first = translate(stackServices());
    const second = translate(stackServices());
    expect(second.objects).toEqual(first.objects);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expectValid(first.objects);
  });

  test('every code the module emits is in TRANSLATOR_CODES', () => {
    const t = translate([
      service({ composeName: 'a', ports: ports([{ target: 1 }, { target: 5432, published: 5432, hostIp: '127.0.0.1' }], 'a') }),
      service({ composeName: 'b', ports: ports([{ target: 9, published: 9, protocol: 'SCTP' }], 'b'), routes: [route(80, 'r', 'b')] }),
      service({ composeName: 'c', ports: published([[22, 80], [5432, 81]], 'c'), extension: { publish: 'hostport' }, replicas: 2 }),
      service({ composeName: 'd', ports: published([[8080, 80]], 'd'), extension: { publish: 'none' } }),
    ]);
    expect(t.diagnostics.length).toBeGreaterThan(5);
    for (const d of t.diagnostics) expect(isTranslatorCode(d.code)).toBe(true);
  });
});
