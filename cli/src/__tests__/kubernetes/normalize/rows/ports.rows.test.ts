// design-07 4.2 row catalogue, group N-PORT (`ports` and `expose`; design-01 5.4, D9, C7). Every
// row runs the full pipeline (PD-11 (a)).
//
// Rows marked (T2) in design-01/design-07 are translator conditions: the normalizer keeps the
// entries and emits nothing, which several rows below assert directly (ports.test.ts, the direct
// handler test owned by P21, documents the same (T2) rows).
//
// Difference from the design-07 proposal, resolved by design-01 5.4's own `parsePortShort`
// pseudocode: N-PORT-11's `["0:80"]` case is not `ports.invalid` (host port 0 means "assign any
// free port", the same as an absent host port, so it maps to `published: null`, design-01 line
// "host port 0 = random = not published"); the row asserts that instead (N-PORT-11c).

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-PORT-01',
    title: 'a container-only short port',
    compose: 'image: nginx:1.27\nports: ["3000"]',
    expect: {
      select: '/services/0/ports/0',
      equals: { target: 3000, published: null, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
    },
  },
  {
    id: 'N-PORT-02',
    title: 'host:container short port',
    compose: 'image: nginx:1.27\nports: ["8080:80"]',
    expect: [
      { select: '/services/0/ports/0/target', equals: 80 },
      { select: '/services/0/ports/0/published', equals: 8080 },
    ],
  },
  {
    id: 'N-PORT-03',
    title: 'a bare YAML integer port',
    compose: 'image: nginx:1.27\nports: [80]',
    expect: [
      { select: '/services/0/ports/0/target', equals: 80 },
      { select: '/services/0/ports/0/published', equals: null },
    ],
  },
  {
    id: 'N-PORT-04',
    title: 'an IPv4 host address',
    compose: 'image: nginx:1.27\nports: ["127.0.0.1:8080:80"]',
    expect: { select: '/services/0/ports/0/hostIp', equals: '127.0.0.1' },
  },
  {
    id: 'N-PORT-05',
    title: 'a bracketed IPv6 host address',
    compose: 'image: nginx:1.27\nports: ["[::1]:8080:80"]',
    expect: { select: '/services/0/ports/0/hostIp', equals: '::1' },
  },
  {
    id: 'N-PORT-06',
    title: 'a port range pairs up into three entries',
    compose: 'image: nginx:1.27\nports: ["8000-8002:9000-9002"]',
    expect: {
      select: '/services/0/ports',
      equals: [
        { target: 9000, published: 8000, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
        { target: 9001, published: 8001, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
        { target: 9002, published: 8002, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
      ],
    },
  },
  {
    id: 'N-PORT-07',
    title: 'a host range onto one container port is refused',
    compose: 'image: nginx:1.27\nports: ["8000-8002:9000"]',
    expect: [
      { select: '/services/0/ports', equals: [] },
      { diagnostics: [{ severity: 'error', code: 'ports.dynamic-range', path: 'services.web.ports[0]' }] },
    ],
  },
  {
    id: 'N-PORT-08',
    title: 'UDP, TCP and SCTP sorted by (target, protocol, published)',
    compose: 'image: nginx:1.27\nports: ["53:53/udp", "53:53/tcp", "5000:5000/sctp"]',
    expect: {
      select: '/services/0/ports',
      equals: [
        { target: 53, published: 53, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[1]' },
        { target: 53, published: 53, protocol: 'UDP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
        { target: 5000, published: 5000, protocol: 'SCTP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[2]' },
      ],
    },
  },
  {
    id: 'N-PORT-09',
    title: 'the long syntax maps every field',
    compose:
      'image: nginx:1.27\nports:\n  - target: "80"\n    published: "8080"\n    protocol: tcp\n    mode: host\n    host_ip: 10.0.0.1\n    name: web\n    app_protocol: http',
    expect: {
      select: '/services/0/ports/0',
      equals: { target: 80, published: 8080, protocol: 'TCP', mode: 'host', hostIp: '10.0.0.1', name: 'web', appProtocol: 'http', path: 'services.web.ports[0]' },
    },
  },
  {
    id: 'N-PORT-10',
    title: 'a long published range is refused',
    compose: 'image: nginx:1.27\nports:\n  - target: 80\n    published: "8080-8090"',
    expect: { diagnostics: [{ severity: 'error', code: 'ports.dynamic-range', path: 'services.web.ports[0].published' }] },
  },
  {
    id: 'N-PORT-11a',
    title: 'a container port past 65535 is invalid',
    compose: 'image: nginx:1.27\nports: ["8080:65536"]',
    expect: { diagnostics: [{ severity: 'error', code: 'ports.invalid', path: 'services.web.ports[0]' }] },
  },
  {
    id: 'N-PORT-11b',
    title: 'a non-numeric port entry is invalid',
    compose: 'image: nginx:1.27\nports: ["abc"]',
    expect: { diagnostics: [{ severity: 'error', code: 'ports.invalid', path: 'services.web.ports[0]' }] },
  },
  {
    id: 'N-PORT-11c',
    title: 'host port 0 asks for any free port: not an error, just unpublished',
    compose: 'image: nginx:1.27\nports: ["0:80"]',
    expect: [
      { select: '/services/0/ports/0', equals: { target: 80, published: null, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' } },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-PORT-12',
    title: 'two identical host ports are deduplicated with an error',
    compose: 'image: nginx:1.27\nports: ["8080:80", "8080:80"]',
    expect: [
      { select: '/services/0/ports', equals: [{ target: 80, published: 8080, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' }] },
      { diagnostics: [{ severity: 'error', code: 'ports.duplicate', path: 'services.web.ports[1]' }] },
    ],
  },
  {
    id: 'N-PORT-13',
    title: 'two published ports on one target are kept as two entries',
    compose: 'image: nginx:1.27\nports: ["8080:80", "8081:80"]',
    expect: { select: '/services/0/ports', equals: [
      { target: 80, published: 8080, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]' },
      { target: 80, published: 8081, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[1]' },
    ] },
  },
  {
    id: 'N-PORT-14',
    title: 'expose ranges and protocols',
    compose: 'image: nginx:1.27\nexpose: ["3000", "4000-4001", "5000/udp"]',
    expect: {
      select: '/services/0/expose',
      equals: [
        { target: 3000, protocol: 'TCP', path: 'services.web.expose[0]' },
        { target: 4000, protocol: 'TCP', path: 'services.web.expose[1]' },
        { target: 4001, protocol: 'TCP', path: 'services.web.expose[1]' },
        { target: 5000, protocol: 'UDP', path: 'services.web.expose[2]' },
      ],
    },
  },
  {
    id: 'N-PORT-15',
    title: 'a range of 101 ports is refused: ServiceLB creates one container per port',
    compose: 'image: nginx:1.27\nports: ["7000-7100:7000-7100"]',
    expect: { diagnostics: [{ severity: 'error', code: 'ports.range-too-large', path: 'services.web.ports[0]' }] },
  },
  {
    id: 'N-PORT-16a',
    title: 'a host IP is carried to the model with x-dockflow.publish: hostport, no ports.host-ip-unsupported',
    compose: 'image: nginx:1.27\nports: ["127.0.0.1:8080:80"]\nx-dockflow: {publish: hostport}',
    expect: [
      { select: '/services/0/ports/0/hostIp', equals: '127.0.0.1' },
      { diagnostics: [{ severity: 'info', code: 'ports.loopback-host-port', path: 'services.web.ports[0]' }], exact: true },
    ],
  },
  {
    id: 'N-PORT-16b',
    title: 'a host IP is carried to the model with mode: host, no ports.host-ip-unsupported',
    compose: 'image: nginx:1.27\nports:\n  - target: 80\n    published: 8080\n    host_ip: 127.0.0.1\n    mode: host',
    expect: [
      { select: '/services/0/ports/0/hostIp', equals: '127.0.0.1' },
      { diagnostics: [{ severity: 'info', code: 'ports.loopback-host-port', path: 'services.web.ports[0]' }], exact: true },
    ],
  },
  {
    id: 'N-PORT-17',
    title: 'a host IP under load-balancer exposure is carried with no normalizer diagnostic',
    compose: 'image: nginx:1.27\nports: ["127.0.0.1:8080:80"]',
    expect: [
      { select: '/services/0/ports/0/hostIp', equals: '127.0.0.1' },
      { diagnostics: [], exact: true },
    ],
  },
];

runNormalizeRows('normalize/ports (N-PORT)', rows);
