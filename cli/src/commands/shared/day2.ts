/**
 * Shared day-2 foundations (design-06 2.1): the orchestrator-neutral entry every day-2 command opens
 * with, service-name resolution, `--tail` validation, `exec` planning, `prune` target planning and
 * the log printer. Individual commands own their own flags and output text; this file owns only the
 * pieces more than one command needs so they read the same way on both orchestrators.
 */

import chalk from 'chalk';
import type { DockflowConfig } from '../../utils/config';
import { CLIError, ErrorCode, UnsupportedOperationError, ValidationError } from '../../utils/errors';
import { printInfo, printRaw, printWarning } from '../../utils/output';
import { selectPrompt } from '../../utils/prompts';
import { capabilityRefusal } from '../../services/orchestrator/capabilities';
import { openOrchestrator, type OpenedOrchestrator } from '../../services/orchestrator/factory';
import type {
  ExecRequest,
  InstanceInfo,
  LockStore,
  LogLine,
  LogSink,
  Orchestrator,
  OrchestratorCapabilities,
  ServiceInfo,
  StackRef,
} from '../../services/orchestrator/interfaces';
import { formatAge, formatRestarts, instanceLabel, orderInstances } from '../../services/orchestrator/kubernetes/status/pods';
// `parseTailOption` has no Kubernetes dependency (design-06 3.1): it is the one `--tail` validator
// for both orchestrators, already implemented and tested where the shared `--since` grammar lives.
export { parseTailOption } from '../../services/orchestrator/kubernetes/status/logs';

// ---------------------------------------------------------------------------
// openDay2
// ---------------------------------------------------------------------------

export interface Day2Context {
  env: string;
  config: DockflowConfig;
  orchestrator: Orchestrator;
  /** orchestrator.target.stackName */
  stackName: string;
  appRef: StackRef;
  accessoryRef: StackRef;
  /**
   * Drops this context's `getServices` memo for `ref` (both refs when omitted). The backend's own
   * inventory memo is invalidated by the backend's mutating methods themselves, so no `Orchestrator`
   * member is needed for it.
   */
  invalidate(ref?: StackRef): void;
  /** deploy lock of this stack, built lazily on each call */
  lock(): LockStore;
}

export interface Day2Options {
  /** --server; must name a manager (core 6.6 step 2, R-22), no exemption */
  server?: string;
  /** default true */
  failover?: boolean;
}

type OrchestratorOpener = (env: string, options?: Parameters<typeof openOrchestrator>[1]) => Promise<OpenedOrchestrator>;

let orchestratorOpener: OrchestratorOpener = openOrchestrator;

/**
 * Test-only seam. The Kubernetes suite never uses `mock.module` (every remote call goes through a
 * fake instead); this is how `commands/*` tests hand `openDay2` a `FakeOrchestrator` without one.
 */
export function __setOrchestratorOpenerForTests(opener: OrchestratorOpener | null): void {
  orchestratorOpener = opener ?? openOrchestrator;
}

interface ServiceMemo {
  app?: Promise<ServiceInfo[]>;
  accessory?: Promise<ServiceInfo[]>;
}

const serviceMemos = new WeakMap<Day2Context, ServiceMemo>();

function memoFor(ctx: Day2Context): ServiceMemo {
  let memo = serviceMemos.get(ctx);
  if (!memo) {
    memo = {};
    serviceMemos.set(ctx, memo);
  }
  return memo;
}

/** `orchestrator.stack.getServices(ref)`, memoised per context and role; a failure is never cached. */
async function getServicesMemoized(ctx: Day2Context, ref: StackRef): Promise<ServiceInfo[]> {
  const memo = memoFor(ctx);
  const cached = memo[ref.role];
  if (cached) return cached;
  const pending = ctx.orchestrator.stack.getServices(ref);
  memo[ref.role] = pending;
  try {
    return await pending;
  } catch (error) {
    if (memo[ref.role] === pending) delete memo[ref.role];
    throw error;
  }
}

/** Builds a `Day2Context` around an already-open orchestrator bundle; used by `openDay2` and tests. */
export function buildDay2Context(env: string, config: DockflowConfig, orchestrator: Orchestrator): Day2Context {
  const project = orchestrator.target.project;
  const appRef: StackRef = { project, env, role: 'app' };
  const accessoryRef: StackRef = { project, env, role: 'accessory' };
  const ctx: Day2Context = {
    env,
    config,
    orchestrator,
    stackName: orchestrator.target.stackName,
    appRef,
    accessoryRef,
    invalidate(ref?: StackRef): void {
      const memo = memoFor(ctx);
      if (ref) delete memo[ref.role];
      else {
        delete memo.app;
        delete memo.accessory;
      }
    },
    lock(): LockStore {
      return orchestrator.lock(orchestrator.target.stackName, config.lock?.stale_threshold_minutes);
    },
  };
  return ctx;
}

/** `openOrchestrator(env, {server, failover}) + refs`. Prints `Checking N managers...` only when probes ran. */
export async function openDay2(env: string, options: Day2Options = {}): Promise<Day2Context> {
  const { config, orchestrator } = await orchestratorOpener(env, { server: options.server, failover: options.failover });
  if (orchestrator.target.probes.length > 0) {
    printInfo(`Checking ${orchestrator.target.probes.length} manager(s)...`);
  }
  return buildDay2Context(env, config, orchestrator);
}

// ---------------------------------------------------------------------------
// resolveService
// ---------------------------------------------------------------------------

export interface ResolveServiceOptions {
  /** default true: Helm release rows are valid targets */
  allowHelm: boolean;
  /** default false: only `exec` and `cp` accept `<release>/<workload>` (they build an InstanceTarget) */
  allowWorkload: boolean;
  /** wording: 'service' (app) or 'accessory' */
  noun: 'service' | 'accessory';
  /** `logs` appends the `--pick` hint to the workload-without-allowWorkload refusal */
  pickHint?: boolean;
  /** the `dockflow accessories` subcommand an app command points to when the name is an accessory */
  accessoryCommand?: string;
}

const DEFAULT_RESOLVE_OPTIONS: ResolveServiceOptions = { allowHelm: true, allowWorkload: false, noun: 'service' };

/** A resolved name: the core ServiceInfo plus, for `<release>/<workload>`, the workload. */
export interface ResolvedService {
  service: ServiceInfo;
  workload?: string;
}

function splitWorkloadForm(raw: string): { release: string; workload: string } | null {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { release: raw.slice(0, slash), workload: raw.slice(slash + 1) };
}

function notFoundError(ctx: Day2Context, ref: StackRef, raw: string, options: ResolveServiceOptions, services: readonly ServiceInfo[]): CLIError {
  if (options.noun === 'accessory') {
    const suggestion = services.length > 0 ? `Available accessories: ${services.map((s) => s.name).join(', ')}.` : undefined;
    return new CLIError(`Accessory '${raw}' not found`, ErrorCode.SERVICE_NOT_FOUND, suggestion);
  }
  if (services.length === 0) {
    return new CLIError(
      `Service '${raw}' not found in ${ctx.orchestrator.naming.describe(ref)}`,
      ErrorCode.SERVICE_NOT_FOUND,
      `Deploy first with: \`dockflow deploy ${ctx.env}\`.`,
    );
  }
  const compose = services.filter((s) => s.kind !== 'helm').map((s) => s.name);
  const helm = services.filter((s) => s.kind === 'helm').map((s) => s.name);
  const helmNote = helm.length > 0 ? ` (Helm: ${helm.join(', ')})` : '';
  return new CLIError(
    `Service '${raw}' not found in ${ctx.orchestrator.naming.describe(ref)}`,
    ErrorCode.SERVICE_NOT_FOUND,
    `Available services: ${compose.join(', ')}${helmNote}.`,
  );
}

/** Resolves a user-supplied name to one ServiceInfo of `ref`. Memoised per context, dropped by `ctx.invalidate`. */
export async function resolveService(
  ctx: Day2Context,
  ref: StackRef,
  raw: string,
  options?: Partial<ResolveServiceOptions>,
): Promise<ResolvedService> {
  const opts: ResolveServiceOptions = { ...DEFAULT_RESOLVE_OPTIONS, ...options };
  const services = await getServicesMemoized(ctx, ref);

  let hit = services.find((s) => s.name === raw);
  if (!hit) {
    const scope = ctx.orchestrator.naming.scope(ref);
    const prefix = `${scope}_`;
    if (raw.startsWith(prefix)) hit = services.find((s) => s.name === raw.slice(prefix.length));
  }
  if (!hit) hit = services.find((s) => s.nativeName === raw);

  if (!hit) {
    const split = splitWorkloadForm(raw);
    if (split) {
      const release = services.find((s) => s.name === split.release && s.kind === 'helm');
      if (release) {
        if (opts.allowWorkload) return { service: release, workload: split.workload };
        const hint = opts.pickHint ? ' Add `--pick` to choose one pod.' : '';
        throw new ValidationError(
          `${raw} names a workload of Helm release ${split.release}; only exec and cp accept that form`,
          `Use the release name \`${split.release}\`.${hint}`,
        );
      }
    }
  }

  if (!hit && ref.role === 'app') {
    const accessories = await getServicesMemoized(ctx, ctx.accessoryRef).catch(() => []);
    if (accessories.some((s) => s.name === raw || s.nativeName === raw)) {
      throw new CLIError(
        `'${raw}' is an accessory of ${ctx.env}, not a service of the app`,
        ErrorCode.SERVICE_NOT_FOUND,
        opts.accessoryCommand ? `Run \`dockflow accessories ${opts.accessoryCommand} ${ctx.env} ${raw}\`.` : 'This command works on app services only.',
      );
    }
  }
  if (!hit) throw notFoundError(ctx, ref, raw, opts, services);

  if (hit.kind === 'helm' && !opts.allowHelm) {
    throw new UnsupportedOperationError(
      `Helm release ${hit.name} is not a valid target for this command`,
      'Choose a compose service instead.',
    );
  }

  return { service: hit };
}

// ---------------------------------------------------------------------------
// Listing --json shape
// ---------------------------------------------------------------------------

export interface ListingJson<T> {
  stack: string;
  /** null on Swarm */
  namespace: string | null;
  items: T[];
}

/** The one `--json` shape every listing command emits (design-06 2.5): `{stack, namespace, items}`. */
export function listingJson<T>(ctx: Day2Context, ref: StackRef, items: T[]): ListingJson<T> {
  return {
    stack: ctx.stackName,
    namespace: ctx.orchestrator.kind === 'k3s' ? ctx.orchestrator.naming.scope(ref) : null,
    items,
  };
}

// ---------------------------------------------------------------------------
// Instance picking (logs --pick, exec --pick, cp --pick)
// ---------------------------------------------------------------------------

/** Prompts for one instance of `service`, in the shared display order. */
export async function pickInstance(
  ctx: Day2Context,
  ref: StackRef,
  service: ServiceInfo,
  options?: { includeTerminated?: boolean },
): Promise<string> {
  const list = await ctx.orchestrator.stack.listInstances(ref, { service: service.name, includeTerminated: options?.includeTerminated });
  if (list.length === 0) {
    throw new CLIError(`No instances found for service ${service.name}`, ErrorCode.CONTAINER_NOT_FOUND);
  }
  const now = new Date();
  return selectPrompt({
    message: 'Pick an instance:',
    options: orderInstances(list).map((instance: InstanceInfo) => ({
      value: instance.id,
      label: `${instance.label} on ${instance.node ?? 'unknown node'}`,
      hint:
        `${instance.status}, restarts ${formatRestarts(instance.restarts)}, age ${formatAge(instance.startedAt, now)}` +
        (instance.error ? ` — ${instance.error}` : ''),
    })),
  });
}

// ---------------------------------------------------------------------------
// planExec (dockflow exec / bash / shell)
// ---------------------------------------------------------------------------

export type ExecPlan = { mode: 'shell'; shell: 'auto' | '/bin/sh' | '/bin/bash' } | { mode: 'command'; request: ExecRequest };

export interface ExecPlanOptions {
  sh?: boolean;
  workdir?: string;
  env?: readonly string[];
  user?: string;
  noTty?: boolean;
}

/** the subset of `process.stdin`/`process.stdout` planning needs, so tests need no real TTY */
export interface ExecStdio {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

const SHELL_METACHARACTERS = /[\s|&;<>()$`\\"'*?~#]/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--env KEY=VALUE`, repeatable; the value is never echoed on a bad key. */
export function parseExecEnv(pairs: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (!ENV_KEY.test(key)) {
      throw new ValidationError('--env expects KEY=VALUE with KEY matching [A-Za-z_][A-Za-z0-9_]*', `Fix the key \`${key}\`.`);
    }
    env[key] = eq === -1 ? '' : pair.slice(eq + 1);
  }
  return env;
}

/** design-06 3.2: the shell/command split, argv wrapping and the tty/stdin matrix. */
export function planExec(command: readonly string[], options: ExecPlanOptions, stdio: ExecStdio): ExecPlan {
  if (command.length === 0) return { mode: 'shell', shell: options.sh ? '/bin/sh' : 'auto' };
  if (command.length === 1 && (command[0] === 'bash' || command[0] === '/bin/bash')) return { mode: 'shell', shell: '/bin/bash' };
  if (command.length === 1 && (command[0] === 'sh' || command[0] === '/bin/sh')) return { mode: 'shell', shell: '/bin/sh' };

  if (options.workdir !== undefined && !options.workdir.startsWith('/')) {
    throw new ValidationError(`--workdir must be an absolute path inside the container: ${options.workdir}`);
  }
  const env = parseExecEnv(options.env);
  const argv = command.length === 1 && SHELL_METACHARACTERS.test(command[0]) ? ['sh', '-c', command[0]] : [...command];
  const tty = !options.noTty && Boolean(stdio.stdin.isTTY) && Boolean(stdio.stdout.isTTY);
  const stdin = tty || !stdio.stdin.isTTY;

  const request: ExecRequest = {
    argv,
    tty,
    stdin,
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
  };
  return { mode: 'command', request };
}

// ---------------------------------------------------------------------------
// planPrune (dockflow prune)
// ---------------------------------------------------------------------------

export type PruneTarget = 'images' | 'containers' | 'volumes' | 'networks';

export interface PrunePlanOptions {
  images?: boolean;
  containers?: boolean;
  volumes?: boolean;
  networks?: boolean;
}

export interface PrunePlan {
  targets: PruneTarget[];
  /** printed before any work, only on the k3s default (no explicit target flag) */
  note?: string;
}

const PRUNE_TARGETS: readonly PruneTarget[] = ['images', 'containers', 'volumes', 'networks'];

const K3S_DEFAULT_NOTE = 'Targets: images (containers, volumes and networks are managed by Kubernetes)';

/** design-06 3.15, evaluated before `openDay2` so a refused target never probes a manager. */
export function planPrune(options: PrunePlanOptions, capabilities: OrchestratorCapabilities): PrunePlan {
  const requested = PRUNE_TARGETS.filter((target) => options[target]);
  // `volumes` and `networkPrune` differ on exactly one side each; either alone tells swarm from k3s.
  const isK3s = capabilities.volumes;
  if (!isK3s) return { targets: requested.length > 0 ? requested : [...PRUNE_TARGETS] };

  if (requested.length === 0) return { targets: ['images'], note: K3S_DEFAULT_NOTE };

  for (const target of requested) {
    switch (target) {
      case 'images':
        break;
      case 'networks': {
        const refusal = capabilityRefusal('networkPrune', 'dockflow prune --networks');
        throw new UnsupportedOperationError(refusal.message, refusal.suggestion);
      }
      case 'volumes':
        throw new UnsupportedOperationError(
          'dockflow prune --volumes is not supported with orchestrator: k3s: volumes are only deleted explicitly',
          'List them with `dockflow volumes list <env>`, then delete the ones you no longer need with `dockflow volumes rm <env> <name>`.',
        );
      case 'containers':
        throw new UnsupportedOperationError(
          'dockflow prune --containers is not supported with orchestrator: k3s: the kubelet removes exited containers itself',
          'Reclaim image space with `dockflow prune <env> --images --all`.',
        );
    }
  }
  return { targets: requested };
}

// ---------------------------------------------------------------------------
// Log printer (logs -f, accessories logs)
// ---------------------------------------------------------------------------

export interface LogPrinterOptions {
  timestamps: boolean;
  /** prefix every line with the colored instance label */
  prefix: boolean;
}

/** Stable color slot per instance: index in first-seen order, cycling through a small palette. */
class PrefixColorSlots {
  private readonly slots = new Map<string, number>();
  private readonly palette = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blueBright, chalk.gray];

  paint(instance: string): (text: string) => string {
    let slot = this.slots.get(instance);
    if (slot === undefined) {
      slot = this.slots.size % this.palette.length;
      this.slots.set(instance, slot);
    }
    return this.palette[slot];
  }
}

/** `[<colored label> | ]<timestamp ><text>`; nothing thrown reaches the SSH listener. */
export function createLogPrinter(options: LogPrinterOptions): LogSink {
  const slots = new PrefixColorSlots();
  return {
    line(entry: LogLine): void {
      const segments: string[] = [];
      if (options.prefix) {
        const label = instanceLabel({ id: entry.instance, service: entry.service }, entry.service);
        segments.push(`${slots.paint(entry.instance)(label)} |`);
      }
      if (options.timestamps && entry.timestamp) segments.push(entry.timestamp);
      segments.push(entry.text);
      printRaw(segments.join(' '));
    },
    warn(message: string): void {
      printWarning(message);
    },
  };
}
