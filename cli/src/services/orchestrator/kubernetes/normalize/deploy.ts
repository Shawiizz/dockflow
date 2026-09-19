// Normalizer handler for `deploy.*` (except `deploy.labels`, identity.ts), `scale`, `restart`,
// `depends_on` and the engine-level resource keys (design-01 1.1 row 13, 5.8, 5.9, 5.10). It fills
// mode, workload kind, replicas, update, restart, resources and placement of a draft. Conditions
// decidable on the model (restart_policy limits, reservation above limit, approximate
// max_replicas_per_node, strategy overrides) are the translator's (design-01 1.6); the
// `update_config` family keys on written keys and is reported here.
// Pure. A handler never throws on user input: an invalid value is reported and keeps its default.

import type { PlacementConstraint, RestartSpec, ServiceMode } from '../model/types';
import { isArchName, isLabelKey, parseBool, parseBytes, parseDurationMs, parseIntStrict, parseMilliCpu } from '../model/units';
import { nodeNameFor } from '../naming';
import { childPath, indexPath, isPlainMap, type NormalizeContext, type ServiceDraft, sortedKeys } from './context';

/** replicas, scale, parallelism and max_replicas_per_node (design-01 DPL-04) */
const MAX_REPLICAS = 10_000;
/** Job backoffLimit and PID limits are int32 in Kubernetes */
const MAX_INT32 = 2_147_483_647;
const DEFAULT_CPU_PERIOD_US = 100_000;
/** Docker's accepted cpu_period range, in microseconds */
const MIN_CPU_PERIOD_US = 1_000;
const MAX_CPU_PERIOD_US = 1_000_000;

// ---------------------------------------------------------------------------
// Value helpers (design-01 2.4-2.7)
// ---------------------------------------------------------------------------

type Mapping = Record<string, unknown>;

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'list';
  if (isPlainMap(v)) return 'mapping';
  return typeof v;
}

/** The scalar as written; deploy keys never carry sensitive values. */
function show(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}

function written(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function invalidType(ctx: NormalizeContext, path: string, expected: string, v: unknown): void {
  ctx.sink.error('values.invalid-type', path, `expected ${expected}, got ${typeName(v)}`, 'See the Compose specification for the accepted forms.');
}

/** `parent[key]` when it is a mapping; null when absent, null or of another type (reported). */
function mappingAt(parent: Mapping, key: string, path: string, ctx: NormalizeContext): Mapping | null {
  const v = parent[key];
  if (!written(v)) return null;
  if (isPlainMap(v)) return v;
  invalidType(ctx, path, 'mapping', v);
  return null;
}

function integerAt(ctx: NormalizeContext, path: string, v: unknown, min: number, max: number): number | null {
  const n = parseIntStrict(v, min, max);
  if (n === null) ctx.sink.error('values.invalid-integer', path, `expected an integer between ${min} and ${max}, got ${show(v)}`, 'Write a whole number.');
  return n;
}

function durationAt(ctx: NormalizeContext, path: string, v: unknown): number | null {
  const ms = parseDurationMs(v);
  if (typeof ms === 'number') return ms;
  if (ms === 'negative') ctx.sink.error('values.negative-duration', path, `${show(v)} must not be negative`);
  else if (ms === 'overflow') ctx.sink.error('values.duration-too-large', path, `${show(v)} is too large`);
  else ctx.sink.error('values.invalid-duration', path, `${show(v)} is not a duration`, 'Use a duration such as `30s`, `1m30s` or `500ms`.');
  return null;
}

function booleanAt(ctx: NormalizeContext, path: string, v: unknown): boolean | null {
  const b = parseBool(v);
  if (b === null) {
    ctx.sink.error('values.invalid-boolean', path, `expected true or false, got ${show(v)}`, 'Write `true` or `false`.');
    return null;
  }
  if (b.yaml11) {
    ctx.sink.warn('values.yaml11-boolean', path, `${show(v)} is read as ${b.value}; YAML 1.2 only knows true and false`, `Write \`${b.value}\`.`);
  }
  return b.value;
}

/** A number written as a number or a decimal string, inside [min, max]. */
function numberAt(ctx: NormalizeContext, path: string, v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(v) ? Number(v) : Number.NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  ctx.sink.error('values.invalid-number', path, `expected a number between ${min} and ${max}, got ${show(v)}`);
  return null;
}

/**
 * Millicores of a CPU count; null for `0` (no limit or reservation); undefined when absent or
 * invalid (reported), so only real values take part in the conflict checks.
 */
function cpuAt(ctx: NormalizeContext, path: string, v: unknown): number | null | undefined {
  if (!written(v)) return undefined;
  const cpu = parseMilliCpu(v);
  if (cpu === null) {
    ctx.sink.error('values.invalid-cpus', path, `${show(v)} is not a CPU count`, 'Write a decimal number of CPUs such as `0.5` or `2`.');
    return undefined;
  }
  if (cpu.rounded) ctx.sink.info('resources.cpu-rounded', path, `${show(v)} CPUs rounded up to ${cpu.milli}m (Kubernetes CPU precision is 1m)`);
  return cpu.milli === 0 ? null : cpu.milli;
}

/** Bytes, with the same null / undefined convention as cpuAt. */
function bytesAt(ctx: NormalizeContext, path: string, v: unknown): number | null | undefined {
  if (!written(v)) return undefined;
  const bytes = parseBytes(v);
  if (bytes === null) {
    ctx.sink.error('values.invalid-bytes', path, `${show(v)} is not a byte value`, 'Use bytes or a binary unit such as `512m`, `1g` or `2048k`.');
    return undefined;
  }
  return bytes === 0 ? null : bytes;
}

/** The first real value of the forms in precedence order; null when none sets one. */
function firstValue(...values: (number | null | undefined)[]): number | null {
  for (const v of values) if (typeof v === 'number') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * `node` is the interpolated service mapping. Runs after healthcheck.ts and before extension.ts
 * (design-01 1.1), which may turn a replicated Deployment into a StatefulSet.
 */
export function deploy(draft: ServiceDraft, node: Mapping, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const deployPath = childPath(draft.path, 'deploy');
  const spec = mappingAt(node, 'deploy', deployPath, ctx) ?? {};
  modeAndReplicas(draft, node, spec, deployPath, ctx);
  endpointMode(draft, spec, deployPath, ctx);
  updateConfig(draft, node, spec, deployPath, ctx);
  rollbackConfig(spec, deployPath, ctx);
  restart(draft, node, spec, deployPath, ctx);
  resources(draft, node, spec, deployPath, ctx);
  placement(draft, spec, deployPath, ctx);
  dependsOn(draft, node, ctx);
}

// ---------------------------------------------------------------------------
// mode, replicas, scale, endpoint_mode (design-01 5.8 RST-05, 5.9 DPL-01..05)
// ---------------------------------------------------------------------------

const MODES: readonly ServiceMode[] = ['replicated', 'global', 'replicated-job'];

function isMode(v: unknown): v is ServiceMode {
  return MODES.includes(v as ServiceMode);
}

function modeAndReplicas(draft: ServiceDraft, node: Mapping, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const modePath = childPath(deployPath, 'mode');
  let mode: ServiceMode = 'replicated';
  if (isMode(spec.mode)) mode = spec.mode;
  else if (spec.mode === 'global-job') {
    ctx.sink.error(
      'deploy.global-job',
      modePath,
      'mode global-job is not supported: Kubernetes has no run-once-per-node workload',
      'Use `mode: replicated-job`, or `mode: global` with a long-running command.',
    );
  } else if (typeof spec.mode === 'string') {
    ctx.sink.error('deploy.invalid-mode', modePath, `mode ${spec.mode} must be replicated, global or replicated-job`);
  } else if (written(spec.mode)) invalidType(ctx, modePath, 'string', spec.mode);
  draft.mode = mode;
  draft.workloadKind = mode === 'global' ? 'DaemonSet' : mode === 'replicated-job' ? 'Job' : 'Deployment';

  const replicasPath = childPath(deployPath, 'replicas');
  const scalePath = childPath(draft.path, 'scale');
  const replicas = written(spec.replicas) ? integerAt(ctx, replicasPath, spec.replicas, 0, MAX_REPLICAS) : null;
  const scale = written(node.scale) ? integerAt(ctx, scalePath, node.scale, 0, MAX_REPLICAS) : null;

  if (mode === 'global') {
    for (const [key, v, path] of [
      ['replicas', spec.replicas, replicasPath],
      ['scale', node.scale, scalePath],
    ] as const) {
      if (written(v)) {
        ctx.sink.error(
          'deploy.replicas-global',
          path,
          `${key} cannot be used with mode global`,
          `Remove \`${key}\`: a global service runs one pod per eligible node.`,
        );
      }
    }
    return;
  }
  if (replicas !== null && scale !== null && replicas !== scale) {
    ctx.sink.error('deploy.scale-conflict', scalePath, `scale ${scale} and deploy.replicas ${replicas} disagree`, 'Keep only `deploy.replicas`.');
  }
  draft.replicas = replicas ?? scale ?? 1;
}

function endpointMode(draft: ServiceDraft, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const v = spec.endpoint_mode;
  const path = childPath(deployPath, 'endpoint_mode');
  if (v === 'vip' || v === 'dnsrr') draft.network.endpointMode = v;
  else if (typeof v === 'string') ctx.sink.error('deploy.invalid-endpoint-mode', path, `endpoint_mode ${v} must be vip or dnsrr`);
  else if (written(v)) invalidType(ctx, path, 'string', v);
}

// ---------------------------------------------------------------------------
// update_config, rollback_config (design-01 5.9 DPL-06..09, DPL-11; D31)
// ---------------------------------------------------------------------------

/** Keys the user wrote; `x-*` keys are extension fields, silent by spec. */
function writtenKeys(map: Mapping): string[] {
  return Object.keys(map).filter((k) => !k.startsWith('x-'));
}

/** `x-dockflow.kind: statefulset` on a replicated service, read before extension.ts runs. */
function requestsStatefulSet(node: Mapping, mode: ServiceMode): boolean {
  const ext = node['x-dockflow'];
  return mode === 'replicated' && isPlainMap(ext) && ext.kind === 'statefulset';
}

function updateConfig(draft: ServiceDraft, node: Mapping, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const path = childPath(deployPath, 'update_config');
  const cfg = mappingAt(spec, 'update_config', path, ctx);
  if (cfg === null) return;
  const job = draft.mode === 'replicated-job';
  if (job && writtenKeys(cfg).length > 0) {
    // one warning for the whole key: the per-field notes below would all say the same
    ctx.sink.warn(
      'deploy.update-config-on-job',
      path,
      `update_config does not apply to ${draft.composeName}: a Job runs its pods once and is not rolled out`,
      'Remove `update_config`, or use `deploy.mode: replicated`.',
    );
  }
  const u = draft.update;
  const at = (key: string): string => childPath(path, key);

  if (written(cfg.parallelism)) {
    const p = integerAt(ctx, at('parallelism'), cfg.parallelism, 0, MAX_REPLICAS);
    if (p !== null) {
      u.parallelism = p;
      if (p !== 1 && !job && requestsStatefulSet(node, draft.mode)) {
        ctx.sink.info(
          'deploy.statefulset-pacing',
          at('parallelism'),
          `update_config.parallelism ${p} is not applied: a StatefulSet replaces its pods one at a time`,
        );
      }
    }
  }

  if (written(cfg.delay)) {
    const ms = durationAt(ctx, at('delay'), cfg.delay);
    if (ms !== null) {
      u.delayMs = ms;
      if (ms > 0 && !job) {
        ctx.sink.info('deploy.update-delay', at('delay'), 'update_config.delay is not applied: Kubernetes has no pause between update batches');
      }
    }
  }

  const action = cfg.failure_action;
  if (action === 'rollback' || action === 'pause' || action === 'continue') {
    u.failureAction = action;
    // D31: an app service honours all three (pause and continue fail the deploy without a
    // revert); accessories are never reverted (design-03 DV-S2-4), so a written rollback is not applied
    if (action === 'rollback' && draft.role === 'accessory' && !job) {
      ctx.sink.warn(
        'deploy.failure-action',
        at('failure_action'),
        'update_config.failure_action rollback is not applied: a failed accessory rollout stops the deploy without a revert',
      );
    }
  } else if (typeof action === 'string') {
    ctx.sink.error('deploy.invalid-failure-action', at('failure_action'), `update_config.failure_action ${action} must be rollback, pause or continue`);
  } else if (written(action)) invalidType(ctx, at('failure_action'), 'string', action);

  if (written(cfg.monitor)) {
    // the 210 s ceiling is the translator's update.monitor-too-long (PD-5)
    const ms = durationAt(ctx, at('monitor'), cfg.monitor);
    if (ms !== null) u.monitorMs = ms;
  }

  if (written(cfg.max_failure_ratio)) {
    const ratio = numberAt(ctx, at('max_failure_ratio'), cfg.max_failure_ratio, 0, 1);
    if (ratio !== null) {
      u.maxFailureRatio = ratio;
      if (ratio > 0 && !job) {
        ctx.sink.warn('deploy.max-failure-ratio', at('max_failure_ratio'), 'update_config.max_failure_ratio is ignored: any failed pod fails the rollout');
      }
    }
  }

  const order = cfg.order;
  if (order === 'start-first' || order === 'stop-first') u.order = order;
  else if (typeof order === 'string') {
    ctx.sink.error('deploy.invalid-order', at('order'), `update_config.order ${order} must be start-first or stop-first`);
  } else if (written(order)) invalidType(ctx, at('order'), 'string', order);
}

function rollbackConfig(spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const path = childPath(deployPath, 'rollback_config');
  const cfg = mappingAt(spec, 'rollback_config', path, ctx);
  if (cfg === null || writtenKeys(cfg).length === 0) return;
  ctx.sink.info(
    'deploy.rollback-config',
    path,
    'rollback_config has no Kubernetes equivalent: a revert re-applies the previous objects with their own update settings',
  );
}

// ---------------------------------------------------------------------------
// restart, deploy.restart_policy (design-01 5.8 RST-*, 5.9 DPL-10, C2, C6)
// ---------------------------------------------------------------------------

type ComposeRestart = Pick<RestartSpec, 'condition' | 'maxAttempts'>;

function parseRestart(v: unknown, path: string, ctx: NormalizeContext): ComposeRestart | null {
  if (v === 'always' || v === 'unless-stopped') return { condition: 'any', maxAttempts: null };
  if (v === 'on-failure') return { condition: 'on-failure', maxAttempts: null };
  if (v === 'no') return { condition: 'none', maxAttempts: null };
  const retries = typeof v === 'string' ? /^on-failure:([0-9]+)$/.exec(v) : null;
  const n = retries ? parseIntStrict(retries[1], 0, MAX_INT32) : null;
  if (n !== null) return { condition: 'on-failure', maxAttempts: n };
  ctx.sink.error('restart.invalid', path, `${show(v)} is not a restart policy`, 'Use `no`, `always`, `on-failure[:N]` or `unless-stopped`.');
  return null;
}

const ON_FAILURE_INFO = 'on Kubernetes a long-running container is also restarted when it exits with code 0';
const RUN_ONCE_HINT = 'Use `deploy.mode: replicated-job` for a container that must run once.';

function restart(draft: ServiceDraft, node: Mapping, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  // a Job's restartPolicy is always Never (design-01 5.8): nothing to warn about there
  const job = draft.mode === 'replicated-job';
  const restartPath = childPath(draft.path, 'restart');
  const fromCompose = written(node.restart) ? parseRestart(node.restart, restartPath, ctx) : null;
  const policyPath = childPath(deployPath, 'restart_policy');
  const policy = mappingAt(spec, 'restart_policy', policyPath, ctx);

  if (policy === null) {
    if (fromCompose === null) return;
    draft.restart = { condition: fromCompose.condition, delayMs: null, maxAttempts: fromCompose.maxAttempts, windowMs: null };
    if (job) return;
    if (fromCompose.condition === 'on-failure') ctx.sink.info('restart.on-failure', restartPath, ON_FAILURE_INFO);
    if (fromCompose.maxAttempts !== null) {
      ctx.sink.warn(
        'restart.max-retries-ignored',
        restartPath,
        `the retry limit ${fromCompose.maxAttempts} is ignored: Kubernetes restarts a failing container indefinitely with a back-off`,
      );
    }
    if (fromCompose.condition === 'none') {
      ctx.sink.warn(
        'restart.no-ignored',
        restartPath,
        'restart: no cannot be honoured by a long-running workload: Kubernetes restarts its containers',
        RUN_ONCE_HINT,
      );
    }
    return;
  }

  if (fromCompose !== null) ctx.sink.info('restart.overridden', restartPath, 'restart is overridden by deploy.restart_policy');
  // delay, window and max_attempts are stored as written: nothing is injected on k3s (C6), so the
  // translator's deploy.restart-policy-unsupported only ever sees user-authored values
  const r: RestartSpec = { condition: 'any', delayMs: null, maxAttempts: null, windowMs: null };
  const at = (key: string): string => childPath(policyPath, key);
  const condition = policy.condition;
  if (condition === 'any' || condition === 'on-failure' || condition === 'none') {
    r.condition = condition;
    if (condition === 'on-failure' && !job) ctx.sink.info('restart.on-failure', at('condition'), ON_FAILURE_INFO);
    if (condition === 'none' && !job) {
      ctx.sink.warn(
        'deploy.restart-none',
        at('condition'),
        'restart_policy.condition none cannot be honoured by a long-running workload: Kubernetes restarts its containers',
        RUN_ONCE_HINT,
      );
    }
  } else if (typeof condition === 'string') {
    ctx.sink.error('deploy.invalid-restart-condition', at('condition'), `restart_policy.condition ${condition} must be none, on-failure or any`);
  } else if (written(condition)) invalidType(ctx, at('condition'), 'string', condition);
  if (written(policy.delay)) r.delayMs = durationAt(ctx, at('delay'), policy.delay);
  if (written(policy.window)) r.windowMs = durationAt(ctx, at('window'), policy.window);
  if (written(policy.max_attempts)) r.maxAttempts = integerAt(ctx, at('max_attempts'), policy.max_attempts, 0, MAX_INT32);
  draft.restart = r;
}

// ---------------------------------------------------------------------------
// Resources: deploy.resources and the engine-level keys (design-01 5.9 RES-01..04, 5.10 RES-05/06)
// ---------------------------------------------------------------------------

function conflict(ctx: NormalizeContext, path: string, key: string, a: unknown, deployKey: string, b: unknown): void {
  ctx.sink.error('resources.conflict', path, `${key} ${show(a)} and deploy.resources.${deployKey} ${show(b)} disagree`, 'Keep `deploy.resources` only.');
}

/** Positive PID limit, null for `0` / `-1` (no limit), undefined when absent or invalid. */
function pidsAt(ctx: NormalizeContext, path: string, v: unknown): number | null | undefined {
  if (!written(v)) return undefined;
  const n = integerAt(ctx, path, v, -1, MAX_INT32);
  if (n === null) return undefined;
  return n > 0 ? n : null;
}

function pidsIgnored(ctx: NormalizeContext, path: string, key: string): void {
  ctx.sink.warn(
    'resources.pids-unsupported',
    path,
    `${key} is ignored: Kubernetes has no per-container process limit`,
    'Set `podPidsLimit` in the kubelet configuration if the limit matters.',
  );
}

/** A reservation list that asks for something; `[]` asks for nothing. */
function requested(v: unknown): boolean {
  return written(v) && !(Array.isArray(v) && v.length === 0);
}

function resources(draft: ServiceDraft, node: Mapping, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const resPath = childPath(deployPath, 'resources');
  const res = mappingAt(spec, 'resources', resPath, ctx) ?? {};
  const limitsPath = childPath(resPath, 'limits');
  const reservationsPath = childPath(resPath, 'reservations');
  const limits = mappingAt(res, 'limits', limitsPath, ctx) ?? {};
  const reservations = mappingAt(res, 'reservations', reservationsPath, ctx) ?? {};
  const svc = (key: string): string => childPath(draft.path, key);

  const deployCpu = cpuAt(ctx, childPath(limitsPath, 'cpus'), limits.cpus);
  const deployMemory = bytesAt(ctx, childPath(limitsPath, 'memory'), limits.memory);
  const deployPids = pidsAt(ctx, childPath(limitsPath, 'pids'), limits.pids);
  const reservedCpu = cpuAt(ctx, childPath(reservationsPath, 'cpus'), reservations.cpus);
  const reservedMemory = bytesAt(ctx, childPath(reservationsPath, 'memory'), reservations.memory);

  if (typeof deployPids === 'number') pidsIgnored(ctx, childPath(limitsPath, 'pids'), 'deploy.resources.limits.pids');
  if (requested(reservations.generic_resources)) {
    ctx.sink.error(
      'resources.generic-unsupported',
      childPath(reservationsPath, 'generic_resources'),
      'generic_resources is not supported',
      'Use `x-dockflow.node_selector` to place the service on nodes that have the resource.',
    );
  }
  if (requested(reservations.devices)) {
    ctx.sink.error(
      'resources.devices-unsupported',
      childPath(reservationsPath, 'devices'),
      'device reservations (for example GPUs) are not supported in this Dockflow version',
      'Remove the device reservation.',
    );
  }

  // engine-level forms merge into the same fields; deploy.resources wins a disagreement
  const cpus = cpuAt(ctx, svc('cpus'), node.cpus);
  const quota = cpuQuota(draft, node, ctx);
  const memLimit = bytesAt(ctx, svc('mem_limit'), node.mem_limit);
  const memReservation = bytesAt(ctx, svc('mem_reservation'), node.mem_reservation);

  if (typeof cpus === 'number' && typeof deployCpu === 'number' && cpus !== deployCpu) {
    conflict(ctx, svc('cpus'), 'cpus', node.cpus, 'limits.cpus', limits.cpus);
  }
  if (typeof quota === 'number' && typeof deployCpu === 'number' && quota !== deployCpu) {
    conflict(ctx, svc('cpu_quota'), 'cpu_quota', node.cpu_quota, 'limits.cpus', limits.cpus);
  }
  if (typeof quota === 'number' && typeof cpus === 'number' && quota !== cpus) {
    ctx.sink.error(
      'resources.conflict',
      svc('cpu_quota'),
      `cpu_quota ${show(node.cpu_quota)} and cpus ${show(node.cpus)} disagree`,
      'Keep only `cpus`.',
    );
  }
  if (typeof memLimit === 'number' && typeof deployMemory === 'number' && memLimit !== deployMemory) {
    conflict(ctx, svc('mem_limit'), 'mem_limit', node.mem_limit, 'limits.memory', limits.memory);
  }
  if (typeof memReservation === 'number' && typeof reservedMemory === 'number' && memReservation !== reservedMemory) {
    conflict(ctx, svc('mem_reservation'), 'mem_reservation', node.mem_reservation, 'reservations.memory', reservations.memory);
  }

  draft.resources = {
    limits: {
      cpu: firstValue(deployCpu, cpus, quota),
      memory: firstValue(deployMemory, memLimit),
      pids: firstValue(deployPids),
    },
    reservations: { cpu: firstValue(reservedCpu), memory: firstValue(reservedMemory, memReservation) },
  };

  if (typeof pidsAt(ctx, svc('pids_limit'), node.pids_limit) === 'number') pidsIgnored(ctx, svc('pids_limit'), 'pids_limit');
  engineKeys(draft, node, ctx);
}

/** `cpu_quota / cpu_period` CPUs in millicores, rounded up (design-01 RES-06). */
function cpuQuota(draft: ServiceDraft, node: Mapping, ctx: NormalizeContext): number | null | undefined {
  const quotaPath = childPath(draft.path, 'cpu_quota');
  const periodPath = childPath(draft.path, 'cpu_period');
  const period = written(node.cpu_period) ? integerAt(ctx, periodPath, node.cpu_period, MIN_CPU_PERIOD_US, MAX_CPU_PERIOD_US) : null;
  if (!written(node.cpu_quota)) {
    if (written(node.cpu_period)) ctx.sink.info('resources.cpu-period-alone', periodPath, 'cpu_period without cpu_quota has no effect');
    return undefined;
  }
  const quota = integerAt(ctx, quotaPath, node.cpu_quota, -1, Number.MAX_SAFE_INTEGER);
  if (quota === null || (written(node.cpu_period) && period === null)) return undefined;
  if (quota <= 0) return null;
  const periodUs = period ?? DEFAULT_CPU_PERIOD_US;
  const milli = Math.ceil((quota * 1000) / periodUs);
  if ((quota * 1000) % periodUs !== 0) {
    ctx.sink.info('resources.cpu-rounded', quotaPath, `${quota / periodUs} CPUs rounded up to ${milli}m (Kubernetes CPU precision is 1m)`);
  }
  return milli;
}

/** Engine-level keys with no Kubernetes field (design-01 5.10). */
function engineKeys(draft: ServiceDraft, node: Mapping, ctx: NormalizeContext): void {
  const svc = (key: string): string => childPath(draft.path, key);
  if (written(node.cpu_shares)) {
    ctx.sink.warn(
      'resources.cpu-shares-ignored',
      svc('cpu_shares'),
      'cpu_shares is ignored: Kubernetes weighs CPU by reservations',
      'Set `deploy.resources.reservations.cpus` instead (1024 shares = 1 CPU).',
    );
  }
  for (const key of ['cpu_rt_runtime', 'cpu_rt_period']) {
    if (written(node[key])) ctx.sink.error('resources.realtime-unsupported', svc(key), `${key} (real-time scheduling) is not supported`, `Remove \`${key}\`.`);
  }
  if (written(node.cpuset)) {
    ctx.sink.error(
      'resources.cpuset-unsupported',
      svc('cpuset'),
      'cpuset is not supported: CPU pinning needs the kubelet static CPU manager',
      'Remove `cpuset`.',
    );
  }
  for (const key of ['cpu_count', 'cpu_percent']) {
    if (written(node[key])) ctx.sink.error('resources.windows-only', svc(key), `${key} only applies to Windows containers`, `Remove \`${key}\`.`);
  }
  for (const key of ['mem_swappiness', 'memswap_limit']) {
    if (written(node[key])) ctx.sink.warn('resources.swap-ignored', svc(key), `${key} is ignored: swap is configured per node on Kubernetes`);
  }
}

// ---------------------------------------------------------------------------
// Placement (design-01 5.9 PLC-01..08)
// ---------------------------------------------------------------------------

const CONSTRAINT_RE = /^\s*([A-Za-z0-9_./-]+)\s*(==|!=)\s*(\S(?:.*\S)?)\s*$/;
const LABELS_PREFIX = 'node.labels.';

export type ConstraintError = { error: 'syntax' | 'attribute' | 'node-id' | 'engine-labels' | 'label-key' | 'role' | 'arch'; detail: string };

/** A Swarm placement constraint; values of `node.role`, `node.platform.*` are lower-cased. */
export function parseConstraint(raw: string, path: string): PlacementConstraint | ConstraintError {
  const m = CONSTRAINT_RE.exec(raw);
  if (!m) return { error: 'syntax', detail: raw };
  const [, attrRaw, op, value] = m;
  const attr = attrRaw.toLowerCase();
  const operator = op as '==' | '!=';
  if (attr.startsWith(LABELS_PREFIX)) {
    // label keys are case-sensitive
    const key = attrRaw.slice(LABELS_PREFIX.length);
    return isLabelKey(key) ? { attribute: 'node.labels', key, operator, value, path } : { error: 'label-key', detail: key };
  }
  if (attr.startsWith('engine.labels.')) return { error: 'engine-labels', detail: attrRaw };
  switch (attr) {
    case 'node.id':
      return { error: 'node-id', detail: raw };
    case 'node.hostname':
      return { attribute: 'node.hostname', operator, value, path };
    case 'node.role': {
      const v = value.toLowerCase();
      return v === 'manager' || v === 'worker' ? { attribute: 'node.role', operator, value: v, path } : { error: 'role', detail: value };
    }
    case 'node.platform.os':
      return { attribute: 'node.platform.os', operator, value: value.toLowerCase(), path };
    case 'node.platform.arch': {
      const v = value.toLowerCase();
      return isArchName(v) ? { attribute: 'node.platform.arch', operator, value: v, path } : { error: 'arch', detail: value };
    }
    default:
      return { error: 'attribute', detail: attrRaw };
  }
}

function constraintProblem(e: ConstraintError): string {
  switch (e.error) {
    case 'attribute':
      return `unknown attribute ${e.detail}`;
    case 'role':
      return 'role must be manager or worker';
    case 'label-key':
      return `invalid label key ${e.detail}`;
    case 'arch':
      return `unknown architecture ${e.detail}`;
    default:
      return 'invalid syntax';
  }
}

function reportConstraint(ctx: NormalizeContext, path: string, raw: string, e: ConstraintError): void {
  if (e.error === 'node-id') {
    ctx.sink.error(
      'placement.node-id',
      path,
      'node.id constraints are not supported: Swarm node ids do not exist on Kubernetes',
      'Use `node.hostname == <servers.yml name>` instead.',
    );
  } else if (e.error === 'engine-labels') {
    ctx.sink.error('placement.engine-labels', path, 'engine.labels constraints are not supported', 'Use `node.labels.<key>` with `node_labels` in `servers.yml`.');
  } else {
    ctx.sink.error(
      'placement.invalid-constraint',
      path,
      `${raw} is not a valid placement constraint: ${constraintProblem(e)}`,
      'Write `<attribute> == <value>` or `<attribute> != <value>`; attributes: `node.role`, `node.hostname`, `node.labels.<key>`, `node.platform.os`, `node.platform.arch`.',
    );
  }
}

/** Same Kubernetes node name (DESIGN-CORE 5.4): `Worker_1` and `worker-1` select one node. */
function isKnownServer(value: string, ctx: NormalizeContext): boolean {
  const wanted = nodeNameFor(value);
  return ctx.input.serverNames.some((s) => nodeNameFor(s) === wanted);
}

function placement(draft: ServiceDraft, spec: Mapping, deployPath: string, ctx: NormalizeContext): void {
  const path = childPath(deployPath, 'placement');
  const p = mappingAt(spec, 'placement', path, ctx);
  if (p === null) return;
  const target = draft.placement;

  const constraintsPath = childPath(path, 'constraints');
  const parsed: PlacementConstraint[] = [];
  if (Array.isArray(p.constraints)) {
    p.constraints.forEach((raw, i) => {
      const itemPath = indexPath(constraintsPath, i);
      if (typeof raw !== 'string') return invalidType(ctx, itemPath, 'string', raw);
      const c = parseConstraint(raw, itemPath);
      if ('error' in c) return reportConstraint(ctx, itemPath, raw, c);
      if (c.attribute === 'node.hostname' && !isKnownServer(c.value, ctx)) {
        const declared = ctx.input.serverNames.length > 0 ? ctx.input.serverNames.join(', ') : 'no server';
        ctx.sink.error(
          'placement.unknown-server',
          itemPath,
          `${c.value} is not a server of this environment (servers.yml declares ${declared})`,
          'Use one of the servers.yml keys; `node.hostname` selects nodes by their Dockflow name, not by their OS host name.',
        );
        return;
      }
      parsed.push(c);
    });
  } else if (written(p.constraints)) invalidType(ctx, constraintsPath, 'list', p.constraints);
  // identity.ts ran first and appended the `platform` constraints, which come last (IMG-11)
  target.constraints = [...parsed, ...target.constraints];

  const preferencesPath = childPath(path, 'preferences');
  if (Array.isArray(p.preferences)) {
    p.preferences.forEach((item, i) => {
      const itemPath = indexPath(preferencesPath, i);
      if (!isPlainMap(item)) return invalidType(ctx, itemPath, 'mapping', item);
      const spreadPath = childPath(itemPath, 'spread');
      const spread = item.spread;
      const key = typeof spread === 'string' && spread.startsWith(LABELS_PREFIX) ? spread.slice(LABELS_PREFIX.length) : null;
      if (key !== null && isLabelKey(key)) target.spreadLabels.push(key);
      else {
        const message = written(spread) ? `spread ${show(spread)} must be node.labels.<key>` : 'spread must be node.labels.<key>';
        ctx.sink.error('placement.invalid-preference', spreadPath, message);
      }
    });
  } else if (written(p.preferences)) invalidType(ctx, preferencesPath, 'list', p.preferences);

  if (written(p.max_replicas_per_node)) {
    const n = integerAt(ctx, childPath(path, 'max_replicas_per_node'), p.max_replicas_per_node, 0, MAX_REPLICAS);
    // 0 means unset (Swarm); N > 1 is the translator's placement.max-replicas-approximate
    if (n !== null) target.maxReplicasPerNode = n === 0 ? null : n;
  }
}

// ---------------------------------------------------------------------------
// depends_on (design-01 5.8 DEP-01..03)
// ---------------------------------------------------------------------------

const CONDITIONS = ['service_started', 'service_healthy', 'service_completed_successfully'];

function dependsOn(draft: ServiceDraft, node: Mapping, ctx: NormalizeContext): void {
  const path = childPath(draft.path, 'depends_on');
  const v = node.depends_on;
  if (!written(v)) return;
  const known = new Set([...Object.keys(ctx.input.compose.services ?? {}), ...ctx.input.sibling.services.map((s) => s.key)]);
  const unknownService = (dep: string, depPath: string): void => {
    if (known.has(dep)) return;
    ctx.sink.warn('depends_on.unknown-service', depPath, `${dep} is not a service of docker-compose.yml or accessories.yml`, 'Fix the name or remove the dependency.');
  };
  let declared = false;

  if (Array.isArray(v)) {
    v.forEach((dep, i) => {
      const depPath = indexPath(path, i);
      if (typeof dep !== 'string') return invalidType(ctx, depPath, 'string', dep);
      declared = true;
      unknownService(dep, depPath);
    });
  } else if (isPlainMap(v)) {
    for (const dep of sortedKeys(v)) {
      const depPath = childPath(path, dep);
      declared = true;
      unknownService(dep, depPath);
      const entry = v[dep];
      if (!written(entry)) continue;
      if (!isPlainMap(entry)) {
        invalidType(ctx, depPath, 'mapping', entry);
        continue;
      }
      dependency(dep, entry, depPath, ctx);
    }
  } else {
    invalidType(ctx, path, 'list or mapping', v);
  }

  if (declared) {
    ctx.sink.info(
      'depends_on.no-ordering',
      path,
      'depends_on has no Kubernetes equivalent: containers start in any order and restart until their dependencies answer; accessories are deployed before the app',
    );
  }
}

function dependency(dep: string, entry: Mapping, depPath: string, ctx: NormalizeContext): void {
  const conditionPath = childPath(depPath, 'condition');
  const condition = entry.condition;
  if (condition === 'service_healthy' || condition === 'service_completed_successfully') {
    const state = condition === 'service_healthy' ? 'healthy' : 'completed';
    ctx.sink.warn(
      'depends_on.condition-ignored',
      conditionPath,
      `condition ${condition} on ${dep} is not enforced: this service may start before ${dep} is ${state}`,
      'Make the program retry its connections at startup.',
    );
  } else if (written(condition) && !CONDITIONS.includes(condition as string)) {
    ctx.sink.error(
      'depends_on.invalid-condition',
      conditionPath,
      `condition ${show(condition)} must be service_started, service_healthy or service_completed_successfully`,
    );
  }
  if (written(entry.restart) && booleanAt(ctx, childPath(depPath, 'restart'), entry.restart) === true) {
    ctx.sink.warn(
      'depends_on.restart-ignored',
      childPath(depPath, 'restart'),
      `restart: true on ${dep} is ignored: Dockflow does not restart this service when ${dep} changes`,
    );
  }
  if (written(entry.required)) booleanAt(ctx, childPath(depPath, 'required'), entry.required);
}
