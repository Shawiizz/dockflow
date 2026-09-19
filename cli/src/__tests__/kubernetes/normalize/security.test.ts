import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { ServiceDraft } from '../../../services/orchestrator/kubernetes/normalize/context';
import { classifySysctl, SAFE_SYSCTLS, security as normalizeSecurity } from '../../../services/orchestrator/kubernetes/normalize/security';
import { type NormalizeInputOverrides, normalizeContext, serviceDraft } from '../support/builders';

/** design-01 codes security.ts may emit (5.2 user rows, 5.10, the value layer it reads through) */
const SECURITY_CODES = new Set([
  'security.user-name',
  'security.group-name',
  'security.invalid-capability',
  'security.seccomp-localhost',
  'security.selinux-ignored',
  'security.option-unsupported',
  'security.invalid-option',
  'security.unsafe-sysctl',
  'security.host-sysctl',
  'security.invalid-sysctl',
  'security.host-namespace',
  'security.option-ignored',
  'security.shared-namespace-unsupported',
  'security.invalid-namespace-mode',
  'security.uts-host-unsupported',
  'security.userns-unsupported',
  'security.cgroup-host-unsupported',
  'security.devices-unsupported',
  'resources.devices-unsupported',
  'security.runtime-unsupported',
  'resources.windows-only',
  'security.api-socket-unsupported',
  'security.ulimits-ignored',
  'resources.oom-ignored',
  'resources.blkio-ignored',
  'resources.storage-opt-ignored',
  'logging.ignored',
  'values.invalid-type',
  'values.invalid-boolean',
  'values.yaml11-boolean',
  'values.invalid-integer',
  'values.empty',
  'values.empty-key',
  'values.duplicate-key',
]);

const emitted = new Set<string>();

function run(node: Record<string, unknown>, overrides: NormalizeInputOverrides = {}): { draft: ServiceDraft; diagnostics: Diagnostic[] } {
  const ctx = normalizeContext(overrides);
  const draft = serviceDraft('web', ctx);
  draft.image = { ref: 'node:22', composeRef: 'node:22', origin: 'pulled', pullPolicy: 'IfNotPresent' };
  normalizeSecurity(draft, node, ctx);
  const diagnostics = ctx.sink.list();
  for (const d of diagnostics) emitted.add(d.code);
  return { draft, diagnostics };
}

const brief = (ds: Diagnostic[]): [string, string, string][] => ds.map((d) => [d.severity, d.code, d.path]);

describe('user and group_add (design-01 5.2)', () => {
  test('PROC-15: numeric users and root', () => {
    const rows: [unknown, { uid: number; gid: number | null }][] = [
      ['1000', { uid: 1000, gid: null }],
      ['1000:1001', { uid: 1000, gid: 1001 }],
      [1000, { uid: 1000, gid: null }],
      ['root', { uid: 0, gid: null }],
      ['0:root', { uid: 0, gid: 0 }],
    ];
    for (const [user, expected] of rows) {
      const { draft, diagnostics } = run({ user });
      expect(draft.process.user).toEqual(expected);
      expect(diagnostics).toEqual([]);
    }
  });

  test('PROC-16: names are refused, the hint shows how to read the ids of the image', () => {
    for (const user of ['node', '1000:staff', 'a:b:c']) {
      const { draft, diagnostics } = run({ user });
      expect(draft.process.user).toBeNull();
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'security.user-name',
          path: 'services.web.user',
          message: `user ${user} uses a name; Kubernetes only accepts numeric user and group ids`,
          hint: 'Use the numeric ids (`docker run --rm --entrypoint id node:22` prints them), for example `user: "1000:1000"`.',
        },
      ]);
    }
  });

  test('user values out of range or of another type', () => {
    expect(brief(run({ user: -1 }).diagnostics)).toEqual([['error', 'values.invalid-integer', 'services.web.user']]);
    expect(brief(run({ user: '99999999999' }).diagnostics)).toEqual([['error', 'values.invalid-integer', 'services.web.user']]);
    expect(brief(run({ user: '' }).diagnostics)).toEqual([['error', 'values.empty', 'services.web.user']]);
    expect(brief(run({ user: ['1000'] }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.user']]);
  });

  test('PROC-17: group_add sorted unique; names refused', () => {
    const { draft, diagnostics } = run({ group_add: [1000, '44', 1000, 'root'] });
    expect(draft.process.groupAdd).toEqual([0, 44, 1000]);
    expect(diagnostics).toEqual([]);
    const named = run({ group_add: ['mail', 5] });
    expect(named.draft.process.groupAdd).toEqual([5]);
    expect(named.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.group-name',
        path: 'services.web.group_add[0]',
        message: 'group mail uses a name; Kubernetes only accepts numeric group ids',
        hint: 'Use the numeric group id.',
      },
    ]);
    expect(brief(run({ group_add: [-1, 1.5] }).diagnostics)).toEqual([
      ['error', 'values.invalid-integer', 'services.web.group_add[0]'],
      ['error', 'values.invalid-integer', 'services.web.group_add[1]'],
    ]);
  });
});

describe('privileges and capabilities (design-01 5.10)', () => {
  test('SECU-01: privileged is recorded; its warning is the translator’s (security.privileged, T2)', () => {
    const privileged = run({ privileged: true });
    expect(privileged.draft.security.privileged).toBe(true);
    expect(privileged.diagnostics).toEqual([]);
    const unprivileged = run({ privileged: 'false' });
    expect(unprivileged.draft.security.privileged).toBe(false);
    expect(unprivileged.diagnostics).toEqual([]);
    expect(run({ privileged: 'maybe' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-boolean',
        path: 'services.web.privileged',
        message: 'expected true or false, got maybe',
        hint: 'Write `true` or `false`.',
      },
    ]);
    expect(brief(run({ privileged: 'on' }).diagnostics)).toEqual([['warning', 'values.yaml11-boolean', 'services.web.privileged']]);
  });

  test('SECU-02: capabilities upper-cased, CAP_ stripped, sorted unique; invalid names refused', () => {
    const { draft, diagnostics } = run({ cap_add: ['cap_net_admin', 'NET_ADMIN', 'SYS_TIME'], cap_drop: ['ALL'] });
    expect(draft.security.capAdd).toEqual(['NET_ADMIN', 'SYS_TIME']);
    expect(draft.security.capDrop).toEqual(['ALL']);
    expect(diagnostics).toEqual([]);
    const invalid = run({ cap_add: ['net admin', 'CHOWN'] });
    expect(invalid.draft.security.capAdd).toEqual(['CHOWN']);
    expect(invalid.diagnostics).toEqual([
      { severity: 'error', code: 'security.invalid-capability', path: 'services.web.cap_add[0]', message: 'net admin is not a Linux capability name' },
    ]);
    expect(brief(run({ cap_drop: 'ALL' }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.cap_drop']]);
  });

  test('SECU-03: read_only', () => {
    expect(run({ read_only: true }).draft.security.readOnlyRootFilesystem).toBe(true);
  });
});

describe('security_opt (design-01 5.10)', () => {
  const opt = (...options: string[]) => run({ security_opt: options });

  test('SECU-04: no-new-privileges and its boolean forms', () => {
    expect(opt('no-new-privileges').draft.security.noNewPrivileges).toBe(true);
    expect(opt('no-new-privileges:true').draft.security.noNewPrivileges).toBe(true);
    expect(opt('no-new-privileges=true').draft.security.noNewPrivileges).toBe(true);
    const off = opt('no-new-privileges=false');
    expect(off.draft.security.noNewPrivileges).toBe(false);
    expect(off.diagnostics).toEqual([]);
    expect(brief(opt('no-new-privileges=sometimes').diagnostics)).toEqual([['error', 'security.invalid-option', 'services.web.security_opt[0]']]);
  });

  test('SECU-05: seccomp and apparmor profiles', () => {
    const unconfined = opt('seccomp=unconfined', 'apparmor=unconfined');
    expect(unconfined.draft.security.seccomp).toBe('unconfined');
    expect(unconfined.draft.security.apparmor).toBe('unconfined');
    expect(unconfined.diagnostics).toEqual([]);
    expect(opt('seccomp:unconfined').draft.security.seccomp).toBe('unconfined');

    const localhost = opt('seccomp=/etc/docker/seccomp.json');
    expect(localhost.draft.security.seccomp).toEqual({ localhostProfile: '/etc/docker/seccomp.json' });
    expect(localhost.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'security.seccomp-localhost',
        path: 'services.web.security_opt[0]',
        message:
          'the seccomp profile /etc/docker/seccomp.json must exist on every node in the kubelet seccomp directory (Docker reads it on the machine running the command)',
      },
    ]);
    const apparmor = opt('apparmor=my-profile');
    expect(apparmor.draft.security.apparmor).toEqual({ localhostProfile: 'my-profile' });
    expect(apparmor.diagnostics).toEqual([]);
    expect(brief(opt('seccomp=').diagnostics)).toEqual([['error', 'security.invalid-option', 'services.web.security_opt[0]']]);
  });

  test('SECU-06: SELinux labels warned, host-level options and unknown options refused', () => {
    expect(opt('label=disable').diagnostics).toEqual([
      { severity: 'warning', code: 'security.selinux-ignored', path: 'services.web.security_opt[0]', message: 'SELinux label options are ignored' },
    ]);
    expect(brief(opt('label:type:svirt_apache_t').diagnostics)).toEqual([['warning', 'security.selinux-ignored', 'services.web.security_opt[0]']]);
    expect(opt('systempaths=unconfined', 'writable-cgroups=true').diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.option-unsupported',
        path: 'services.web.security_opt[0]',
        message: 'security option systempaths=unconfined is not supported',
        hint: 'Use `privileged: true` if the service needs it.',
      },
      {
        severity: 'error',
        code: 'security.option-unsupported',
        path: 'services.web.security_opt[1]',
        message: 'security option writable-cgroups=true is not supported',
        hint: 'Use `privileged: true` if the service needs it.',
      },
    ]);
    expect(opt('writable-cgroups=false').diagnostics).toEqual([]);
    expect(opt('foo=bar').diagnostics).toEqual([
      { severity: 'error', code: 'security.invalid-option', path: 'services.web.security_opt[0]', message: 'foo=bar is not a security option' },
    ]);
  });
});

describe('sysctls (design-01 5.10: one classification, three normalizer codes)', () => {
  test('SECU-07: safe kept as strings; unsafe, host-level and invalid names refused', () => {
    const { draft, diagnostics } = run({
      sysctls: { 'net.ipv4.tcp_syncookies': 0, 'net.core.somaxconn': 1024, 'vm.max_map_count': 262144, 'bad name': 1 },
    });
    expect(draft.security.sysctls).toEqual({ 'net.ipv4.tcp_syncookies': '0' });
    expect(diagnostics).toEqual([
      { severity: 'error', code: 'security.invalid-sysctl', path: 'services.web.sysctls["bad name"]', message: 'bad name is not a sysctl name' },
      {
        severity: 'error',
        code: 'security.unsafe-sysctl',
        path: 'services.web.sysctls["net.core.somaxconn"]',
        message:
          "sysctl net.core.somaxconn is not in the Kubernetes safe set, and Dockflow's k3s setup does not enable unsafe sysctls, so the kubelet rejects every pod of web with SysctlForbidden",
        hint: 'Remove the sysctl, or set it on the nodes themselves.',
      },
      {
        severity: 'error',
        code: 'security.host-sysctl',
        path: 'services.web.sysctls["vm.max_map_count"]',
        message: 'sysctl vm.max_map_count is not namespaced and cannot be set for one container',
      },
    ]);
  });

  test('list form, duplicates and missing values', () => {
    const { draft, diagnostics } = run({
      sysctls: ['net.ipv4.ip_unprivileged_port_start=0', 'net.ipv4.tcp_fin_timeout=30', 'net.ipv4.tcp_fin_timeout=20', 'net.ipv4.tcp_rmem', '=1'],
    });
    expect(draft.security.sysctls).toEqual({ 'net.ipv4.ip_unprivileged_port_start': '0', 'net.ipv4.tcp_fin_timeout': '20' });
    expect(brief(diagnostics)).toEqual([
      ['info', 'values.duplicate-key', 'services.web.sysctls[2]'],
      ['error', 'values.empty', 'services.web.sysctls[3]'],
      ['error', 'values.empty-key', 'services.web.sysctls[4]'],
    ]);
  });

  test('classification: every safe name is safe; namespaced prefixes are unsafe; the rest is host-level', () => {
    for (const name of SAFE_SYSCTLS) expect(classifySysctl(name)).toBe('safe');
    expect(classifySysctl('net/ipv4/tcp_syncookies')).toBe('safe');
    for (const name of ['net.core.somaxconn', 'kernel.shmmax', 'kernel.msgmax', 'kernel.sem', 'fs.mqueue.msg_max']) {
      expect(classifySysctl(name)).toBe('unsafe');
    }
    for (const name of ['vm.max_map_count', 'kernel.pid_max', 'fs.file-max']) expect(classifySysctl(name)).toBe('host');
    for (const name of ['Net.core.x', '.net', 'net..x', 'bad name']) expect(classifySysctl(name)).toBe('invalid');
  });
});

describe('namespaces (design-01 5.10)', () => {
  test('SECU-08: pid and ipc modes', () => {
    const host = run({ pid: 'host', ipc: 'host' });
    expect(host.draft.security.hostPid).toBe(true);
    expect(host.draft.security.hostIpc).toBe(true);
    expect(host.diagnostics).toEqual([
      { severity: 'warning', code: 'security.host-namespace', path: 'services.web.ipc', message: "ipc: host shares the node's IPC namespace" },
      {
        severity: 'warning',
        code: 'security.host-namespace',
        path: 'services.web.pid',
        message: "pid: host shares the node's process namespace with the container",
      },
    ]);
    for (const ipc of ['shareable', 'private']) expect(run({ ipc }).diagnostics).toEqual([]);
    expect(run({ ipc: 'none' }).diagnostics).toEqual([
      { severity: 'warning', code: 'security.option-ignored', path: 'services.web.ipc', message: 'ipc: none is ignored' },
    ]);
    expect(run({ ipc: 'service:db' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.shared-namespace-unsupported',
        path: 'services.web.ipc',
        message: 'ipc service:db is not supported: services run in separate pods',
        hint: 'Remove `ipc`.',
      },
    ]);
    expect(brief(run({ pid: 'container:abc' }).diagnostics)).toEqual([['error', 'security.shared-namespace-unsupported', 'services.web.pid']]);
    expect(run({ pid: 'bogus' }).diagnostics).toEqual([
      { severity: 'error', code: 'security.invalid-namespace-mode', path: 'services.web.pid', message: 'pid bogus is not supported' },
    ]);
  });

  test('SECU-09: uts and userns_mode', () => {
    expect(run({ uts: 'host' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.uts-host-unsupported',
        path: 'services.web.uts',
        message: 'uts: host is only available with network_mode: host on Kubernetes',
        hint: 'Use `network_mode: host`, or remove `uts`.',
      },
    ]);
    expect(run({ uts: 'host', network_mode: 'host' }).diagnostics).toEqual([]);
    expect(run({ userns_mode: 'host' }).diagnostics).toEqual([]);
    expect(run({ userns_mode: 'keep-id' }).diagnostics).toEqual([
      { severity: 'error', code: 'security.userns-unsupported', path: 'services.web.userns_mode', message: 'userns_mode keep-id is not supported' },
    ]);
  });

  test('SECU-10: cgroup and cgroup_parent', () => {
    expect(run({ cgroup: 'host' }).diagnostics).toEqual([
      { severity: 'error', code: 'security.cgroup-host-unsupported', path: 'services.web.cgroup', message: 'cgroup: host is not supported', hint: 'Remove `cgroup`.' },
    ]);
    expect(run({ cgroup: 'private' }).diagnostics).toEqual([]);
    expect(run({ cgroup_parent: 'x' }).diagnostics).toEqual([
      { severity: 'warning', code: 'security.option-ignored', path: 'services.web.cgroup_parent', message: 'cgroup_parent is ignored' },
    ]);
  });
});

describe('devices, runtimes and ignored kernel options (design-01 5.10)', () => {
  test('SECU-11: devices and GPUs are refused', () => {
    expect(run({ devices: ['/dev/ttyUSB0:/dev/ttyUSB0'], device_cgroup_rules: ['c 1:3 mr'] }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.devices-unsupported',
        path: 'services.web.device_cgroup_rules',
        message: 'device access is not supported',
        hint: 'Remove `device_cgroup_rules`, or mount the device path with a bind mount and `privileged: true`.',
      },
      {
        severity: 'error',
        code: 'security.devices-unsupported',
        path: 'services.web.devices',
        message: 'device access is not supported',
        hint: 'Remove `devices`, or mount the device path with a bind mount and `privileged: true`.',
      },
    ]);
    expect(run({ gpus: 'all' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'resources.devices-unsupported',
        path: 'services.web.gpus',
        message: 'device reservations (for example GPUs) are not supported in this Dockflow version',
        hint: 'Remove the device reservation.',
      },
    ]);
    expect(run({ devices: [], gpus: [] }).diagnostics).toEqual([]);
  });

  test('SECU-12: runtimes, Windows-only keys and the API socket', () => {
    expect(run({ runtime: 'runsc' }).diagnostics).toEqual([
      { severity: 'error', code: 'security.runtime-unsupported', path: 'services.web.runtime', message: 'runtime runsc is not supported', hint: 'Remove `runtime`.' },
    ]);
    expect(run({ isolation: 'hyperv' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'resources.windows-only',
        path: 'services.web.isolation',
        message: 'isolation only applies to Windows containers',
        hint: 'Remove `isolation`.',
      },
    ]);
    expect(brief(run({ credential_spec: { file: 'x' } }).diagnostics)).toEqual([['error', 'resources.windows-only', 'services.web.credential_spec']]);
    expect(run({ use_api_socket: true }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'security.api-socket-unsupported',
        path: 'services.web.use_api_socket',
        message: 'use_api_socket is not supported: k3s nodes have no Docker API socket',
        hint: 'Remove `use_api_socket`.',
      },
    ]);
    expect(run({ runtime: 'runc', isolation: 'default', use_api_socket: false }).diagnostics).toEqual([]);
    expect(run({ runtime: 'io.containerd.runc.v2' }).diagnostics).toEqual([]);
  });

  test('SECU-13: ulimits, OOM, block IO and storage options are ignored with warnings', () => {
    const { diagnostics } = run({
      ulimits: { nofile: { soft: 20000, hard: 40000 } },
      oom_score_adj: 500,
      oom_kill_disable: true,
      blkio_config: { weight: 300 },
      storage_opt: { size: '1G' },
    });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'resources.blkio-ignored',
        path: 'services.web.blkio_config',
        message: 'blkio_config is ignored: Kubernetes has no block IO limits',
      },
      {
        severity: 'warning',
        code: 'resources.oom-ignored',
        path: 'services.web.oom_kill_disable',
        message: 'oom_kill_disable is ignored: Kubernetes derives OOM priorities from the pod QoS class',
      },
      {
        severity: 'warning',
        code: 'resources.oom-ignored',
        path: 'services.web.oom_score_adj',
        message: 'oom_score_adj is ignored: Kubernetes derives OOM priorities from the pod QoS class',
      },
      { severity: 'warning', code: 'resources.storage-opt-ignored', path: 'services.web.storage_opt', message: 'storage_opt is ignored' },
      {
        severity: 'warning',
        code: 'security.ulimits-ignored',
        path: 'services.web.ulimits',
        message: "ulimits are ignored: containers inherit the limits of the node's container runtime",
        hint: 'Set the limits in the container entrypoint (`ulimit`) if the program needs them.',
      },
    ]);
  });

  test('engine-level resource keys belong to deploy.ts (design-01 1.1 row 13)', () => {
    expect(run({ memswap_limit: '1g', mem_swappiness: 10, cpus: 1, pids_limit: 50, cpu_count: 2 }).diagnostics).toEqual([]);
  });

  test('SECU-14: logging is ignored with a warning', () => {
    expect(run({ logging: { driver: 'json-file' } }).diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'logging.ignored',
        path: 'services.web.logging',
        message: 'logging is ignored: container logs are collected by the kubelet and rotated on each node',
        hint: 'Read logs with `dockflow logs <env> <service>`, or ship them with a log collector.',
      },
    ]);
  });
});

describe('handler contract', () => {
  test('absent keys leave every default', () => {
    const { draft, diagnostics } = run({});
    expect(draft.security).toEqual(serviceDraft().security);
    expect(draft.process.user).toBeNull();
    expect(draft.process.groupAdd).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('a service marked fatal is skipped', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    normalizeSecurity(draft, { user: 'node', pid: 'bogus' }, ctx);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('every code emitted in this file is a design-01 code of security.ts, and every such code is exercised', () => {
    expect([...emitted].filter((code) => !SECURITY_CODES.has(code))).toEqual([]);
    expect([...SECURITY_CODES].filter((code) => !emitted.has(code))).toEqual([]);
  });
});
