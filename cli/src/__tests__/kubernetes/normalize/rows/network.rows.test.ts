// design-07 4.2 row catalogue, group N-NET (top-level `networks` and service networking keys;
// design-01 6.1, 5.11). Every row runs the full pipeline (PD-11 (a)).

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-NET-01',
    title: 'network aliases and a link alias are sanitized and merged, sorted',
    compose:
      'image: nginx:1.27\nnetworks:\n  default:\n    aliases: [database, db_primary]\nlinks: ["cache:redis-cache"]',
    sibling: { services: ['cache'] },
    expect: [
      { select: '/services/0/network/aliases', equals: ['database', 'db-primary', 'redis-cache'] },
      { diagnostics: [{ severity: 'warning', code: 'names.sanitized', path: 'services.web.networks.default.aliases[1]' }] },
    ],
  },
  {
    id: 'N-NET-02a',
    title: 'external_links warns and is ignored',
    compose: 'image: nginx:1.27\nexternal_links: ["legacy:legacy"]',
    expect: { diagnostics: [{ severity: 'warning', code: 'network.external-links-ignored', path: 'services.web.external_links' }] },
  },
  {
    id: 'N-NET-02b',
    title: 'mac_address warns and is ignored',
    compose: 'image: nginx:1.27\nmac_address: "02:42:ac:11:00:02"',
    expect: { diagnostics: [{ severity: 'warning', code: 'network.attachment-option-ignored', path: 'services.web.mac_address' }] },
  },
  {
    id: 'N-NET-02c',
    title: 'a static ipv4_address is refused',
    compose: 'image: nginx:1.27\nnetworks:\n  default:\n    ipv4_address: 10.0.0.5',
    expect: { diagnostics: [{ severity: 'error', code: 'network.static-ip-unsupported', path: 'services.web.networks.default.ipv4_address' }] },
  },
  {
    id: 'N-NET-03',
    title: 'dns, dns_search and dns_opt become arrays',
    compose: 'image: nginx:1.27\ndns: 1.1.1.1\ndns_search: [example.internal]\ndns_opt: ["ndots:2"]',
    expect: [
      { select: '/services/0/network/dns', equals: ['1.1.1.1'] },
      { select: '/services/0/network/dnsSearch', equals: ['example.internal'] },
      { select: '/services/0/network/dnsOptions', equals: ['ndots:2'] },
    ],
  },
  {
    id: 'N-NET-04a',
    title: 'extra_hosts list form, sorted by (ip, hostname)',
    compose: 'image: nginx:1.27\nextra_hosts: ["h1:10.0.0.1", "h2=10.0.0.2"]',
    expect: {
      select: '/services/0/network/extraHosts',
      equals: [{ hostname: 'h1', ip: '10.0.0.1' }, { hostname: 'h2', ip: '10.0.0.2' }],
    },
  },
  {
    id: 'N-NET-04b',
    title: 'extra_hosts map form',
    compose: 'image: nginx:1.27\nextra_hosts:\n  h1: 10.0.0.1',
    expect: { select: '/services/0/network/extraHosts', equals: [{ hostname: 'h1', ip: '10.0.0.1' }] },
  },
  {
    id: 'N-NET-05',
    title: 'host-gateway has no fixed address and is refused',
    compose: 'image: nginx:1.27\nextra_hosts: ["gw:host-gateway"]',
    expect: { diagnostics: [{ severity: 'error', code: 'network.host-gateway-unsupported', path: 'services.web.extra_hosts[0]' }] },
  },
  {
    id: 'N-NET-06',
    title: 'network_mode: host',
    compose: 'image: nginx:1.27\nnetwork_mode: host',
    expect: { select: '/services/0/network/hostNetwork', equals: true },
  },
  {
    id: 'N-NET-07a',
    title: 'network_mode: none is refused',
    compose: 'image: nginx:1.27\nnetwork_mode: none',
    expect: { diagnostics: [{ severity: 'error', code: 'network.mode-none-unsupported', path: 'services.web.network_mode' }] },
  },
  {
    id: 'N-NET-07b',
    title: 'network_mode: service:db is refused',
    compose: 'image: nginx:1.27\nnetwork_mode: "service:db"',
    expect: { diagnostics: [{ severity: 'error', code: 'network.shared-namespace-unsupported', path: 'services.web.network_mode' }] },
  },
  {
    id: 'N-NET-07c',
    title: 'network_mode: container:x is refused',
    compose: 'image: nginx:1.27\nnetwork_mode: "container:x"',
    expect: { diagnostics: [{ severity: 'error', code: 'network.shared-namespace-unsupported', path: 'services.web.network_mode' }] },
  },
  {
    id: 'N-NET-08',
    title: 'a plain top-level network declaration is registry policy, no error',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    networks: [backend]\nnetworks:\n  backend:\n    driver: overlay\n    internal: true\n',
    expect: { diagnostics: [
      { severity: 'info', code: 'network.flat', path: 'networks' },
      { severity: 'info', code: 'networks.option-ignored', path: 'networks.backend.driver' },
      { severity: 'warning', code: 'networks.internal-not-enforced', path: 'networks.backend.internal' },
    ] },
  },
];

runNormalizeRows('normalize/network (N-NET)', rows);
