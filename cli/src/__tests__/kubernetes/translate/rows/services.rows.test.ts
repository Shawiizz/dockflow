// design-07 5.2 T-EXPO rows (translate/services.ts): Service shapes, port names and the
// published-port checks (D9, C2, C9, PD-2).
//
// T-EXPO-01: design-07's cell lists `externalTrafficPolicy: Cluster` on `web-lb`, but design-02 6.6
// ("`externalTrafficPolicy` | omitted (Cluster: source IP is SNATed...)") is explicit that the field
// is never emitted, and `loadBalancerService()` confirms it. This file follows design-02 and asserts
// the field is absent.

import { LABELS } from '../../../../services/orchestrator/kubernetes/constants';
import { namespaceFor } from '../../../../services/orchestrator/kubernetes/naming';
import { type TranslateRow, runTranslateRows } from '../../support/rows';

const NAMESPACE = namespaceFor('shop', 'production');

const rows: TranslateRow[] = [
  {
    id: 'T-EXPO-01',
    title: 'ports: ["8080:80"] -> ClusterIP + LoadBalancer + container port, no externalTrafficPolicy (design-02)',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/ports', equals: [{ name: 'tcp-80', port: 80, protocol: 'TCP' }] },
      { object: 'Service/web', pointer: '/spec/type', absent: true },
      { object: 'Service/web-lb', pointer: '/spec/type', equals: 'LoadBalancer' },
      { object: 'Service/web-lb', pointer: '/spec/ports', equals: [{ name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 }] },
      { object: 'Service/web-lb', pointer: '/spec/allocateLoadBalancerNodePorts', equals: false },
      { object: 'Service/web-lb', pointer: '/spec/externalTrafficPolicy', absent: true },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/ports/0', equals: { name: 'tcp-80', containerPort: 80, protocol: 'TCP' } },
    ],
  },
  {
    id: 'T-EXPO-02',
    title: 'ports: ["3000"] (no published port) -> Service/web only',
    compose: `
      image: nginx:1.27
      ports: ["3000"]
    `,
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      { diagnostics: [{ severity: 'warning', code: 'ports.no-published-port', path: 'services.web.ports[0]' }] },
    ],
  },
  {
    id: 'T-EXPO-03',
    title: 'expose: ["3000"] -> ClusterIP Service only, generated port name',
    compose: `
      image: nginx:1.27
      expose: ["3000"]
    `,
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      { object: 'Service/web', pointer: '/spec/ports', equals: [{ name: 'tcp-3000', port: 3000, protocol: 'TCP' }] },
    ],
  },
  {
    id: 'T-EXPO-04',
    title: 'no ports, headlessServiceNeedsPort: true (k3s default) -> headless with the placeholder port',
    compose: 'image: nginx:1.27',
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      { object: 'Service/web', pointer: '/spec/clusterIP', equals: 'None' },
      { object: 'Service/web', pointer: '/spec/ports', equals: [{ name: 'placeholder', port: 9, protocol: 'TCP' }] },
    ],
  },
  {
    id: 'T-EXPO-05',
    title: 'no ports, headlessServiceNeedsPort: false -> headless, no ports key at all',
    compose: 'image: nginx:1.27',
    options: { traits: { headlessServiceNeedsPort: false } },
    expect: [
      { object: 'Service/web', pointer: '/spec/clusterIP', equals: 'None' },
      { object: 'Service/web', pointer: '/spec/ports', absent: true },
    ],
  },
  {
    id: 'T-EXPO-06',
    title: '["53:53/udp","53:53/tcp"] -> both Services carry tcp-53 and udp-53, sorted by protocol',
    compose: `
      image: nginx:1.27
      ports: ["53:53/udp","53:53/tcp"]
    `,
    expect: [
      {
        object: 'Service/web',
        pointer: '/spec/ports',
        equals: [
          { name: 'tcp-53', port: 53, protocol: 'TCP' },
          { name: 'udp-53', port: 53, protocol: 'UDP' },
        ],
      },
      {
        object: 'Service/web-lb',
        pointer: '/spec/ports',
        equals: [
          { name: 'tcp-53', port: 53, protocol: 'TCP', targetPort: 53 },
          { name: 'udp-53', port: 53, protocol: 'UDP', targetPort: 53 },
        ],
      },
    ],
  },
  {
    id: 'T-EXPO-07',
    title: 'long syntax name: http -> the port name on both the container and the ClusterIP Service',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
          name: http
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/ports/0/name', equals: 'http' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/ports/0/name', equals: 'http' },
    ],
  },
  {
    id: 'T-EXPO-08',
    title: 'long syntax mode: host, host_ip, published -> container hostPort/hostIP, no web-lb',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
          mode: host
          host_ip: 10.0.0.1
    `,
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/containers/0/ports/0',
        equals: { name: 'tcp-80', containerPort: 80, protocol: 'TCP', hostPort: 8080, hostIP: '10.0.0.1' },
      },
    ],
  },
  {
    id: 'T-EXPO-09a',
    title: '127.0.0.1:5432:5432 under load-balancer exposure (default) -> translator error ports.host-ip-unsupported',
    compose: `
      image: nginx:1.27
      ports: ["127.0.0.1:5432:5432"]
    `,
    expect: {
      diagnostics: [{ severity: 'error', code: 'ports.host-ip-unsupported', path: 'services.web.ports[0]' }],
    },
  },
  {
    id: 'T-EXPO-09b',
    title: '127.0.0.1:5432:5432 with x-dockflow.publish: hostport -> accepted, no translator diagnostic',
    compose: `
      image: nginx:1.27
      ports:
        - "127.0.0.1:5432:5432"
      x-dockflow:
        publish: hostport
    `,
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/containers/0/ports/0',
      equals: { name: 'tcp-5432', containerPort: 5432, protocol: 'TCP', hostPort: 5432, hostIP: '127.0.0.1' },
    },
  },
  {
    id: 'T-EXPO-09c',
    title: '127.0.0.1:5432:5432 with x-dockflow.publish: none -> normalizer warning ports.host-ip-ignored, no translator error',
    compose: `
      image: nginx:1.27
      ports:
        - "127.0.0.1:5432:5432"
      x-dockflow:
        publish: none
    `,
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      { diagnostics: [{ severity: 'warning', code: 'ports.host-ip-ignored', path: 'services.web.ports[0]' }] },
    ],
  },
  {
    id: 'T-EXPO-10a',
    title: 'x-dockflow.publish: none -> no web-lb',
    compose: `
      image: nginx:1.27
      ports:
        - "8080:80"
      x-dockflow:
        publish: none
    `,
    expect: { kinds: ['Deployment/web', 'Service/web'] },
  },
  {
    id: 'T-EXPO-10b',
    title: 'x-dockflow.publish: hostport -> container hostPort, no web-lb',
    compose: `
      image: nginx:1.27
      ports:
        - "8080:80"
      x-dockflow:
        publish: hostport
    `,
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/ports/0/hostPort', equals: 8080 },
    ],
  },
  {
    id: 'T-EXPO-11',
    title: 'x-dockflow.lb_source_ranges -> web-lb.spec.loadBalancerSourceRanges',
    compose: `
      image: nginx:1.27
      ports:
        - "8080:80"
      x-dockflow:
        lb_source_ranges: ["10.0.0.0/8"]
    `,
    expect: { object: 'Service/web-lb', pointer: '/spec/loadBalancerSourceRanges', equals: ['10.0.0.0/8'] },
  },
  {
    id: 'T-EXPO-12a',
    title: 'publishing 22:80 -> ports.reserved-host-port (default SSH reservation of server_1)',
    compose: `
      image: nginx:1.27
      ports: ["22:80"]
    `,
    expect: { diagnostics: [{ severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[0]' }] },
  },
  {
    id: 'T-EXPO-12b',
    title: 'publishing 2222:80 with an environment SSH port of 2222 -> ports.reserved-host-port',
    compose: `
      image: nginx:1.27
      ports: ["2222:80"]
    `,
    options: { extraReservedHostPorts: [{ port: 2222, protocol: 'TCP', reason: 'SSH port of server_1' }] },
    expect: { diagnostics: [{ severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[0]' }] },
  },
  {
    id: 'T-EXPO-13',
    title: 'every k3s-reserved port is refused when published',
    compose: `
      image: nginx:1.27
      ports:
        - "6443:80"
        - "10250:81"
        - "2379:82"
        - "2380:83"
        - "5001:84"
        - target: 85
          published: 8472
          protocol: udp
        - target: 86
          published: 51820
          protocol: udp
        - target: 87
          published: 51821
          protocol: udp
    `,
    options: { extraReservedHostPorts: [] },
    expect: {
      diagnostics: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        severity: 'error' as const,
        code: 'ports.reserved-host-port',
        path: `services.web.ports[${i}]`,
      })),
    },
  },
  {
    id: 'T-EXPO-14a',
    title: '80:80 and 443:443 refused when a Dockflow Traefik runs on the cluster (traefikOnCluster, PD-2)',
    compose: `
      image: nginx:1.27
      ports: ["80:80","443:443"]
    `,
    options: { traefikOnCluster: true, extraReservedHostPorts: [] },
    expect: {
      diagnostics: [
        { severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[0]' },
        { severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[1]' },
      ],
    },
  },
  {
    id: 'T-EXPO-14b',
    title: '80:80 and 443:443 refused when the nginx plugin reserves them',
    compose: `
      image: nginx:1.27
      ports: ["80:80","443:443"]
    `,
    options: {
      extraReservedHostPorts: [
        { port: 80, protocol: 'TCP', reason: 'nginx plugin' },
        { port: 443, protocol: 'TCP', reason: 'nginx plugin' },
      ],
    },
    expect: {
      diagnostics: [
        { severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[0]' },
        { severity: 'error', code: 'ports.reserved-host-port', path: 'services.web.ports[1]' },
      ],
    },
  },
  {
    id: 'T-EXPO-14c',
    title: '80:80 and 443:443 allowed with neither reservation',
    compose: `
      image: nginx:1.27
      ports: ["80:80","443:443"]
    `,
    options: { extraReservedHostPorts: [] },
    expect: { diagnostics: [] },
  },
  {
    id: 'T-EXPO-15',
    title: 'endpoint_mode: dnsrr -> the main Service is headless with ports; web-lb still emitted',
    compose: `
      image: nginx:1.27
      ports:
        - "8080:80"
      deploy:
        endpoint_mode: dnsrr
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/clusterIP', equals: 'None' },
      { object: 'Service/web', pointer: '/spec/ports', equals: [{ name: 'tcp-80', port: 80, protocol: 'TCP' }] },
      { object: 'Service/web-lb', pointer: '/spec/type', equals: 'LoadBalancer' },
    ],
  },
  {
    id: 'T-EXPO-16',
    title: 'network alias -> a Service named after the alias, with web\'s selector and P/service: web',
    compose: `
      image: nginx:1.27
      ports:
        - "8080:80"
      networks:
        default:
          aliases: [database]
    `,
    expect: [
      { object: 'Service/database', pointer: '/spec/selector', equals: { [LABELS.stack]: NAMESPACE, [LABELS.service]: 'web' } },
      { object: 'Service/database', pointer: '/spec/ports', equals: [{ name: 'tcp-80', port: 80, protocol: 'TCP' }] },
      { object: 'Service/database', pointer: `/metadata/labels/${LABELS.service.replace('/', '~1')}`, equals: 'web' },
    ],
  },
  {
    id: 'T-EXPO-17',
    title: '9000-9001:9000-9001 (range) -> two entries in every Service',
    compose: `
      image: nginx:1.27
      ports: ["9000-9001:9000-9001"]
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/ports/0/port', equals: 9000 },
      { object: 'Service/web', pointer: '/spec/ports/1/port', equals: 9001 },
      { object: 'Service/web-lb', pointer: '/spec/ports/0/port', equals: 9000 },
      { object: 'Service/web-lb', pointer: '/spec/ports/1/port', equals: 9001 },
    ],
  },
  {
    id: 'T-EXPO-18',
    title: 'app_protocol: http -> appProtocol on both Services',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
          app_protocol: http
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/ports/0/appProtocol', equals: 'http' },
      { object: 'Service/web-lb', pointer: '/spec/ports/0/appProtocol', equals: 'http' },
    ],
  },
  {
    id: 'T-EXPO-19a',
    title: 'a requested name is kept',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
          name: http
    `,
    expect: { object: 'Service/web-lb', pointer: '/spec/ports/0/name', equals: 'http' },
  },
  {
    id: 'T-EXPO-19b',
    title: 'two ports requesting the same name: the later one falls back to <protocol>-<port>',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
          name: http
        - target: 81
          published: 8081
          name: http
    `,
    expect: {
      object: 'Service/web',
      pointer: '/spec/ports',
      equals: [
        { name: 'http', port: 80, protocol: 'TCP' },
        { name: 'tcp-81', port: 81, protocol: 'TCP' },
      ],
    },
  },
  {
    id: 'T-EXPO-19c',
    title: 'a published-port change on an unchanged target does not rename the -lb port (8080)',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    expect: { object: 'Service/web-lb', pointer: '/spec/ports/0/name', equals: 'tcp-80' },
  },
  {
    id: 'T-EXPO-19d',
    title: 'a published-port change on an unchanged target does not rename the -lb port (9090)',
    compose: `
      image: nginx:1.27
      ports: ["9090:80"]
    `,
    expect: { object: 'Service/web-lb', pointer: '/spec/ports/0/name', equals: 'tcp-80' },
  },
  {
    id: 'T-EXPO-19e',
    title: 'two published ports onto one target -> -lb port names stay unique',
    compose: `
      image: nginx:1.27
      ports: ["8080:80","8081:80"]
    `,
    expect: {
      object: 'Service/web-lb',
      pointer: '/spec/ports',
      equals: [
        { name: 'tcp-80', port: 8080, protocol: 'TCP', targetPort: 80 },
        { name: 'tcp-80-8081', port: 8081, protocol: 'TCP', targetPort: 80 },
      ],
    },
  },
  {
    id: 'T-EXPO-19f',
    title: 'a name matching another port\'s generated form is foreign and never adopted',
    compose: `
      image: nginx:1.27
      ports:
        - target: 80
          published: 8080
        - target: 81
          published: 8081
          name: tcp-80
    `,
    expect: {
      object: 'Service/web',
      pointer: '/spec/ports',
      equals: [
        { name: 'tcp-80', port: 80, protocol: 'TCP' },
        { name: 'tcp-81', port: 81, protocol: 'TCP' },
      ],
    },
  },
  {
    id: 'T-EXPO-20',
    title: 'protocol is emitted on every container port and Service port, TCP included',
    compose: `
      image: nginx:1.27
      ports: ["8080:80"]
    `,
    expect: [
      { object: 'Service/web', pointer: '/spec/ports/0/protocol', equals: 'TCP' },
      { object: 'Service/web-lb', pointer: '/spec/ports/0/protocol', equals: 'TCP' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/ports/0/protocol', equals: 'TCP' },
    ],
  },
];

runTranslateRows('translate/services (T-EXPO)', rows);
