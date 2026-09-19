// User, groups, capabilities, security options, sysctls, host namespaces and the kernel and
// runtime keys Kubernetes cannot honour (design-01 5.2 user rows, 5.10). Engine-level resource keys
// (`cpus`, `cpu_*`, `mem_*`, `memswap_limit`, `pids_limit`, `cpuset`) belong to deploy.ts. Pure.

import type { SecuritySpec } from '../model/types';
import { isSysctlName, parseBool } from '../model/units';
import { childPath, sortedUnique, type NormalizeContext, type ServiceDraft } from './context';
import {
  displayValue,
  isAbsent,
  readBool,
  readInt,
  readListOrDict,
  readString,
  readStringList,
  reportEmpty,
  reportInvalidType,
} from './env';

/** Linux ids are 32-bit; Kubernetes stores runAsUser/runAsGroup as int64 but runtimes use uint32 minus one */
const ID_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------
// user and group_add (design-01 5.2)
// ---------------------------------------------------------------------------

type IdPart = { id: number } | { name: true } | { outOfRange: true };

function idPart(text: string): IdPart {
  if (text === 'root') return { id: 0 };
  if (!/^[0-9]+$/.test(text)) return { name: true };
  const n = Number(text);
  return Number.isSafeInteger(n) && n <= ID_MAX ? { id: n } : { outOfRange: true };
}

function readUser(value: unknown, path: string, image: string, ctx: NormalizeContext): { uid: number; gid: number | null } | null {
  if (typeof value === 'number') {
    const uid = readInt(value, path, 0, ID_MAX, ctx);
    return uid === null ? null : { uid, gid: null };
  }
  if (typeof value !== 'string') {
    reportInvalidType(ctx, path, 'string', value);
    return null;
  }
  if (value === '') {
    reportEmpty(ctx, path);
    return null;
  }
  const parts = value.split(':');
  const ids = parts.length > 2 ? [{ name: true } as IdPart] : parts.map(idPart);
  if (ids.some((p) => 'name' in p)) {
    ctx.sink.error(
      'security.user-name',
      path,
      `user ${value} uses a name; Kubernetes only accepts numeric user and group ids`,
      `Use the numeric ids (\`docker run --rm --entrypoint id ${image}\` prints them), for example \`user: "1000:1000"\`.`,
    );
    return null;
  }
  if (ids.some((p) => 'outOfRange' in p)) {
    readInt(value, path, 0, ID_MAX, ctx);
    return null;
  }
  const [uid, gid] = ids as { id: number }[];
  return { uid: uid.id, gid: gid === undefined ? null : gid.id };
}

function readGroups(value: unknown, path: string, ctx: NormalizeContext): number[] {
  const items = readStringList(value, path, ctx, { numbers: true });
  if (items === null) return [];
  const groups = new Set<number>();
  for (const item of items) {
    const part = idPart(item.value);
    if ('id' in part) groups.add(part.id);
    else if ('outOfRange' in part) readInt(item.value, item.path, 0, ID_MAX, ctx);
    else if (/^-?[0-9.]+$/.test(item.value)) readInt(item.value, item.path, 0, ID_MAX, ctx);
    else {
      ctx.sink.error(
        'security.group-name',
        item.path,
        `group ${item.value} uses a name; Kubernetes only accepts numeric group ids`,
        'Use the numeric group id.',
      );
    }
  }
  return [...groups].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Capabilities and security_opt (design-01 5.10)
// ---------------------------------------------------------------------------

const CAPABILITY_RE = /^[A-Z][A-Z0-9_]*$/;

function readCapabilities(value: unknown, path: string, ctx: NormalizeContext): string[] {
  const items = readStringList(value, path, ctx);
  if (items === null) return [];
  const caps: string[] = [];
  for (const item of items) {
    let cap = item.value.toUpperCase();
    if (cap.startsWith('CAP_')) cap = cap.slice('CAP_'.length);
    if (CAPABILITY_RE.test(cap)) caps.push(cap);
    else ctx.sink.error('security.invalid-capability', item.path, `${displayValue(item.value)} is not a Linux capability name`);
  }
  return sortedUnique(caps);
}

const SECURITY_OPT_RE = /^([^=:]+)(?:[=:]([\s\S]*))?$/;

function applySecurityOptions(value: unknown, path: string, security: SecuritySpec, ctx: NormalizeContext): void {
  const items = readStringList(value, path, ctx);
  if (items === null) return;
  for (const item of items) {
    const m = SECURITY_OPT_RE.exec(item.value);
    const invalid = (): void => {
      ctx.sink.error('security.invalid-option', item.path, `${displayValue(item.value)} is not a security option`);
    };
    const unsupported = (): void => {
      ctx.sink.error(
        'security.option-unsupported',
        item.path,
        `security option ${item.value} is not supported`,
        'Use `privileged: true` if the service needs it.',
      );
    };
    if (!m) {
      invalid();
      continue;
    }
    const [, name, option] = m;
    switch (name) {
      case 'no-new-privileges': {
        const flag = option === undefined ? { value: true } : parseBool(option);
        if (flag === null) invalid();
        else security.noNewPrivileges = flag.value;
        break;
      }
      case 'seccomp':
        if (option === undefined || option === '') invalid();
        else if (option === 'unconfined') security.seccomp = 'unconfined';
        else {
          security.seccomp = { localhostProfile: option };
          ctx.sink.warn(
            'security.seccomp-localhost',
            item.path,
            `the seccomp profile ${option} must exist on every node in the kubelet seccomp directory (Docker reads it on the machine running the command)`,
          );
        }
        break;
      case 'apparmor':
        if (option === undefined || option === '') invalid();
        else security.apparmor = option === 'unconfined' ? 'unconfined' : { localhostProfile: option };
        break;
      case 'label':
        ctx.sink.warn('security.selinux-ignored', item.path, 'SELinux label options are ignored');
        break;
      case 'systempaths':
        if (option === 'unconfined') unsupported();
        else invalid();
        break;
      case 'writable-cgroups': {
        const flag = option === undefined ? null : parseBool(option);
        if (flag === null) invalid();
        else if (flag.value) unsupported();
        break;
      }
      default:
        invalid();
    }
  }
}

// ---------------------------------------------------------------------------
// sysctls (design-01 5.10; one classification, three normalizer codes, 1.6 tie-break 2)
// ---------------------------------------------------------------------------

/** kubelet safe set (Kubernetes 1.34) */
export const SAFE_SYSCTLS: ReadonlySet<string> = new Set([
  'kernel.shm_rmid_forced',
  'net.ipv4.ip_local_port_range',
  'net.ipv4.tcp_syncookies',
  'net.ipv4.ping_group_range',
  'net.ipv4.ip_unprivileged_port_start',
  'net.ipv4.ip_local_reserved_ports',
  'net.ipv4.tcp_keepalive_time',
  'net.ipv4.tcp_fin_timeout',
  'net.ipv4.tcp_keepalive_intvl',
  'net.ipv4.tcp_keepalive_probes',
  'net.ipv4.tcp_rmem',
  'net.ipv4.tcp_wmem',
]);

const NAMESPACED_SYSCTL_PREFIXES = ['net.', 'kernel.shm', 'kernel.msg', 'kernel.sem', 'fs.mqueue.'];

export type SysctlClass = 'safe' | 'unsafe' | 'host' | 'invalid';

export function classifySysctl(name: string): SysctlClass {
  if (!isSysctlName(name)) return 'invalid';
  // Kubernetes accepts `/` as the separator and compares the dotted form
  const dotted = name.replaceAll('/', '.');
  if (SAFE_SYSCTLS.has(dotted)) return 'safe';
  return NAMESPACED_SYSCTL_PREFIXES.some((p) => dotted.startsWith(p)) ? 'unsafe' : 'host';
}

function readSysctls(value: unknown, path: string, composeName: string, ctx: NormalizeContext): Record<string, string> {
  const sysctls: Record<string, string> = {};
  for (const entry of readListOrDict(value, path, ctx) ?? []) {
    switch (classifySysctl(entry.key)) {
      case 'invalid':
        ctx.sink.error('security.invalid-sysctl', entry.path, `${entry.key} is not a sysctl name`);
        break;
      case 'host':
        ctx.sink.error('security.host-sysctl', entry.path, `sysctl ${entry.key} is not namespaced and cannot be set for one container`);
        break;
      case 'unsafe':
        ctx.sink.error(
          'security.unsafe-sysctl',
          entry.path,
          `sysctl ${entry.key} is not in the Kubernetes safe set, and Dockflow's k3s setup does not enable unsafe sysctls, so the kubelet rejects every pod of ${composeName} with SysctlForbidden`,
          'Remove the sysctl, or set it on the nodes themselves.',
        );
        break;
      case 'safe':
        if (entry.value === null) reportEmpty(ctx, entry.path);
        else sysctls[entry.key] = entry.value;
        break;
    }
  }
  return sysctls;
}

// ---------------------------------------------------------------------------
// Namespaces (design-01 5.10)
// ---------------------------------------------------------------------------

function sharedNamespace(key: 'pid' | 'ipc', mode: string, path: string, ctx: NormalizeContext): boolean {
  if (!mode.startsWith('service:') && !mode.startsWith('container:')) return false;
  ctx.sink.error(
    'security.shared-namespace-unsupported',
    path,
    `${key} ${mode} is not supported: services run in separate pods`,
    `Remove \`${key}\`.`,
  );
  return true;
}

function invalidNamespaceMode(key: string, mode: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.error('security.invalid-namespace-mode', path, `${key} ${displayValue(mode)} is not supported`);
}

function applyNamespaces(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  const mode = (key: string): { value: string; path: string } | null => {
    if (isAbsent(node[key])) return null;
    const keyPath = childPath(path, key);
    const value = readString(node[key], keyPath, ctx);
    return value === null ? null : { value, path: keyPath };
  };

  const pid = mode('pid');
  if (pid !== null) {
    if (pid.value === 'host') {
      draft.security.hostPid = true;
      ctx.sink.warn('security.host-namespace', pid.path, "pid: host shares the node's process namespace with the container");
    } else if (!sharedNamespace('pid', pid.value, pid.path, ctx)) {
      invalidNamespaceMode('pid', pid.value, pid.path, ctx);
    }
  }

  const ipc = mode('ipc');
  if (ipc !== null) {
    if (ipc.value === 'host') {
      draft.security.hostIpc = true;
      ctx.sink.warn('security.host-namespace', ipc.path, "ipc: host shares the node's IPC namespace");
    } else if (ipc.value === 'none') {
      ctx.sink.warn('security.option-ignored', ipc.path, 'ipc: none is ignored');
    } else if (ipc.value !== 'private' && ipc.value !== 'shareable' && !sharedNamespace('ipc', ipc.value, ipc.path, ctx)) {
      invalidNamespaceMode('ipc', ipc.value, ipc.path, ctx);
    }
  }

  const uts = mode('uts');
  if (uts !== null) {
    if (uts.value !== 'host') invalidNamespaceMode('uts', uts.value, uts.path, ctx);
    else if (node.network_mode !== 'host') {
      ctx.sink.error(
        'security.uts-host-unsupported',
        uts.path,
        'uts: host is only available with network_mode: host on Kubernetes',
        'Use `network_mode: host`, or remove `uts`.',
      );
    }
  }

  const userns = mode('userns_mode');
  if (userns !== null && userns.value !== 'host') {
    ctx.sink.error('security.userns-unsupported', userns.path, `userns_mode ${displayValue(userns.value)} is not supported`);
  }

  const cgroup = mode('cgroup');
  if (cgroup !== null) {
    if (cgroup.value === 'host') {
      ctx.sink.error('security.cgroup-host-unsupported', cgroup.path, 'cgroup: host is not supported', 'Remove `cgroup`.');
    } else if (cgroup.value !== 'private') {
      invalidNamespaceMode('cgroup', cgroup.value, cgroup.path, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Keys refused or ignored as a whole (design-01 5.10)
// ---------------------------------------------------------------------------

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function refuseAndIgnore(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  const path = draft.path;
  const at = (key: string): string => childPath(path, key);

  if (!isAbsent(node.cgroup_parent)) ctx.sink.warn('security.option-ignored', at('cgroup_parent'), 'cgroup_parent is ignored');

  for (const key of ['devices', 'device_cgroup_rules']) {
    if (isAbsent(node[key]) || isEmptyList(node[key])) continue;
    ctx.sink.error(
      'security.devices-unsupported',
      at(key),
      'device access is not supported',
      `Remove \`${key}\`, or mount the device path with a bind mount and \`privileged: true\`.`,
    );
  }
  if (!isAbsent(node.gpus) && !isEmptyList(node.gpus)) {
    ctx.sink.error(
      'resources.devices-unsupported',
      at('gpus'),
      'device reservations (for example GPUs) are not supported in this Dockflow version',
      'Remove the device reservation.',
    );
  }

  if (!isAbsent(node.runtime)) {
    const runtime = readString(node.runtime, at('runtime'), ctx);
    if (runtime !== null && runtime !== 'runc' && runtime !== 'io.containerd.runc.v2') {
      ctx.sink.error('security.runtime-unsupported', at('runtime'), `runtime ${displayValue(runtime)} is not supported`, 'Remove `runtime`.');
    }
  }
  const windowsOnly = (key: string): void => {
    ctx.sink.error('resources.windows-only', at(key), `${key} only applies to Windows containers`, `Remove \`${key}\`.`);
  };
  if (!isAbsent(node.isolation)) {
    const isolation = readString(node.isolation, at('isolation'), ctx);
    if (isolation !== null && isolation !== 'default') windowsOnly('isolation');
  }
  if (!isAbsent(node.credential_spec)) windowsOnly('credential_spec');

  if (!isAbsent(node.use_api_socket) && readBool(node.use_api_socket, at('use_api_socket'), ctx) === true) {
    ctx.sink.error(
      'security.api-socket-unsupported',
      at('use_api_socket'),
      'use_api_socket is not supported: k3s nodes have no Docker API socket',
      'Remove `use_api_socket`.',
    );
  }

  if (!isAbsent(node.ulimits)) {
    ctx.sink.warn(
      'security.ulimits-ignored',
      at('ulimits'),
      "ulimits are ignored: containers inherit the limits of the node's container runtime",
      'Set the limits in the container entrypoint (`ulimit`) if the program needs them.',
    );
  }
  for (const key of ['oom_score_adj', 'oom_kill_disable']) {
    if (!isAbsent(node[key])) {
      ctx.sink.warn('resources.oom-ignored', at(key), `${key} is ignored: Kubernetes derives OOM priorities from the pod QoS class`);
    }
  }
  if (!isAbsent(node.blkio_config)) {
    ctx.sink.warn('resources.blkio-ignored', at('blkio_config'), 'blkio_config is ignored: Kubernetes has no block IO limits');
  }
  if (!isAbsent(node.storage_opt)) ctx.sink.warn('resources.storage-opt-ignored', at('storage_opt'), 'storage_opt is ignored');
  if (!isAbsent(node.logging)) {
    ctx.sink.warn(
      'logging.ignored',
      at('logging'),
      'logging is ignored: container logs are collected by the kubelet and rotated on each node',
      'Read logs with `dockflow logs <env> <service>`, or ship them with a log collector.',
    );
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * design-01 1.1 step 7. The `privileged` warning is the translator's (`security.privileged`,
 * design-01 1.6): this handler only records the flag.
 */
export function security(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const path = draft.path;
  const at = (key: string): string => childPath(path, key);

  if (!isAbsent(node.user)) {
    const image = draft.image.composeRef === '' ? '<image>' : draft.image.composeRef;
    draft.process.user = readUser(node.user, at('user'), image, ctx);
  }
  if (!isAbsent(node.group_add)) draft.process.groupAdd = readGroups(node.group_add, at('group_add'), ctx);

  const flags = [
    ['privileged', 'privileged'],
    ['read_only', 'readOnlyRootFilesystem'],
  ] as const;
  for (const [key, field] of flags) {
    if (isAbsent(node[key])) continue;
    const value = readBool(node[key], at(key), ctx);
    if (value !== null) draft.security[field] = value;
  }
  if (!isAbsent(node.cap_add)) draft.security.capAdd = readCapabilities(node.cap_add, at('cap_add'), ctx);
  if (!isAbsent(node.cap_drop)) draft.security.capDrop = readCapabilities(node.cap_drop, at('cap_drop'), ctx);
  if (!isAbsent(node.security_opt)) applySecurityOptions(node.security_opt, at('security_opt'), draft.security, ctx);
  if (!isAbsent(node.sysctls)) draft.security.sysctls = readSysctls(node.sysctls, at('sysctls'), draft.composeName, ctx);

  applyNamespaces(draft, node, ctx);
  refuseAndIgnore(draft, node, ctx);
}
