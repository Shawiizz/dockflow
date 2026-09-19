// design-07 4.2 row catalogue, group N-SEC (user, groups, capabilities, security_opt, sysctls, host
// namespaces; design-01 5.2 user rows, 5.10). Every row runs the full pipeline (PD-11 (a)).

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-SEC-01',
    title: 'capabilities are uppercased, CAP_ stripped, sorted unique',
    compose: 'image: nginx:1.27\ncap_add: [CAP_NET_ADMIN, net_raw, NET_ADMIN]\ncap_drop: [ALL]',
    expect: [
      { select: '/services/0/security/capAdd', equals: ['NET_ADMIN', 'NET_RAW'] },
      { select: '/services/0/security/capDrop', equals: ['ALL'] },
    ],
  },
  {
    id: 'N-SEC-02',
    title: 'privileged and read_only are mapped, with the privileged warning',
    compose: 'image: nginx:1.27\nprivileged: true\nread_only: true',
    expect: [
      { select: '/services/0/security/privileged', equals: true },
      { select: '/services/0/security/readOnlyRootFilesystem', equals: true },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-SEC-03a',
    title: 'no-new-privileges without a value means true',
    compose: 'image: nginx:1.27\nsecurity_opt: ["no-new-privileges"]',
    expect: { select: '/services/0/security/noNewPrivileges', equals: true },
  },
  {
    id: 'N-SEC-03b',
    title: 'no-new-privileges:true means true',
    compose: 'image: nginx:1.27\nsecurity_opt: ["no-new-privileges:true"]',
    expect: { select: '/services/0/security/noNewPrivileges', equals: true },
  },
  {
    id: 'N-SEC-04',
    title: 'unconfined seccomp and apparmor',
    compose: 'image: nginx:1.27\nsecurity_opt: ["seccomp=unconfined", "apparmor=unconfined"]',
    expect: [
      { select: '/services/0/security/seccomp', equals: 'unconfined' },
      { select: '/services/0/security/apparmor', equals: 'unconfined' },
    ],
  },
  {
    id: 'N-SEC-05',
    title: 'a seccomp profile path becomes a localhost profile, with a warning',
    compose: 'image: nginx:1.27\nsecurity_opt: ["seccomp=/etc/profiles/p.json"]',
    expect: [
      { select: '/services/0/security/seccomp', equals: { localhostProfile: '/etc/profiles/p.json' } },
      { diagnostics: [{ severity: 'warning', code: 'security.seccomp-localhost', path: 'services.web.security_opt[0]' }] },
    ],
  },
  {
    id: 'N-SEC-06',
    title: 'a label security option warns and is ignored',
    compose: 'image: nginx:1.27\nsecurity_opt: ["label=type:x"]',
    expect: { diagnostics: [{ severity: 'warning', code: 'security.selinux-ignored', path: 'services.web.security_opt[0]' }] },
  },
  {
    id: 'N-SEC-07',
    title: 'a kubelet-safe sysctl name is kept as a string',
    compose: 'image: nginx:1.27\nsysctls:\n  net.ipv4.ip_unprivileged_port_start: 0',
    expect: { select: '/services/0/security/sysctls', equals: { 'net.ipv4.ip_unprivileged_port_start': '0' } },
  },
  {
    id: 'N-SEC-07b',
    title: 'the list form of sysctls',
    compose: 'image: nginx:1.27\nsysctls:\n  - net.ipv4.ip_unprivileged_port_start=1024',
    expect: { select: '/services/0/security/sysctls', equals: { 'net.ipv4.ip_unprivileged_port_start': '1024' } },
  },
  {
    id: 'N-SEC-11',
    title: 'an unsafe namespaced sysctl is refused: the kubelet would reject the pod',
    compose: 'image: nginx:1.27\nsysctls:\n  net.core.somaxconn: 1024',
    expect: { diagnostics: [{ severity: 'error', code: 'security.unsafe-sysctl', path: 'services.web.sysctls["net.core.somaxconn"]' }] },
  },
  {
    id: 'N-SEC-12',
    title: 'a host-level sysctl is refused with a distinct code',
    compose: 'image: nginx:1.27\nsysctls:\n  vm.max_map_count: 262144',
    expect: { diagnostics: [{ severity: 'error', code: 'security.host-sysctl', path: 'services.web.sysctls["vm.max_map_count"]' }] },
  },
  {
    id: 'N-SEC-08a',
    title: 'pid: host is applied with a warning',
    compose: 'image: nginx:1.27\npid: host',
    expect: [
      { select: '/services/0/security/hostPid', equals: true },
      { diagnostics: [{ severity: 'warning', code: 'security.host-namespace', path: 'services.web.pid' }] },
    ],
  },
  {
    id: 'N-SEC-08b',
    title: 'ipc: host is applied with a warning',
    compose: 'image: nginx:1.27\nipc: host',
    expect: [
      { select: '/services/0/security/hostIpc', equals: true },
      { diagnostics: [{ severity: 'warning', code: 'security.host-namespace', path: 'services.web.ipc' }] },
    ],
  },
  {
    id: 'N-SEC-09a',
    title: 'ulimits is ignored with a warning',
    compose: 'image: nginx:1.27\nulimits:\n  nofile: 1024',
    expect: { diagnostics: [{ severity: 'warning', code: 'security.ulimits-ignored', path: 'services.web.ulimits' }] },
  },
  {
    id: 'N-SEC-09b',
    title: 'oom_score_adj is ignored with a warning',
    compose: 'image: nginx:1.27\noom_score_adj: 100',
    expect: { diagnostics: [{ severity: 'warning', code: 'resources.oom-ignored', path: 'services.web.oom_score_adj' }] },
  },
  {
    id: 'N-SEC-09c',
    title: 'cgroup_parent is ignored with a warning',
    compose: 'image: nginx:1.27\ncgroup_parent: /custom',
    expect: { diagnostics: [{ severity: 'warning', code: 'security.option-ignored', path: 'services.web.cgroup_parent' }] },
  },
  {
    id: 'N-SEC-10a',
    title: 'devices are refused',
    compose: 'image: nginx:1.27\ndevices: ["/dev/net/tun"]',
    expect: { diagnostics: [{ severity: 'error', code: 'security.devices-unsupported', path: 'services.web.devices' }] },
  },
  {
    id: 'N-SEC-10b',
    title: 'gpus are refused',
    compose: 'image: nginx:1.27\ngpus: all',
    expect: { diagnostics: [{ severity: 'error', code: 'resources.devices-unsupported', path: 'services.web.gpus' }] },
  },
  {
    id: 'N-SEC-10c',
    title: 'a non-runc runtime is refused',
    compose: 'image: nginx:1.27\nruntime: nvidia',
    expect: { diagnostics: [{ severity: 'error', code: 'security.runtime-unsupported', path: 'services.web.runtime' }] },
  },
];

runNormalizeRows('normalize/security (N-SEC)', rows);
