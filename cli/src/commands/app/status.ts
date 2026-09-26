/**
 * `dockflow status [env]` (design-06 3.7): one row per environment, fetched in parallel with a
 * per-env budget (core 8.6): 8s with one manager, 20s with several (failover probing needs the
 * extra time). Kept from today: the table shape and the four error column texts. An environment
 * named on the command line that cannot be read fails the command with its own error and exit code
 * instead of a row, so scripts can rely on the exit code.
 */

import type { Command } from 'commander';
import { STATUS_BUDGET_MULTI_MANAGER_MS, STATUS_BUDGET_SINGLE_MANAGER_MS } from '../../constants';
import { CLIError, ConnectionError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { colors, printBlank, printIntro, printRaw, printSection, printWarning } from '../../utils/output';
import { getAvailableEnvironments, getManagersForEnvironment } from '../../utils/servers';
import { withSecrets } from '../../utils/secrets';
import { openDay2 } from '../shared/day2';

interface EnvStatus {
  env: string;
  version: string | null;
  deployedAt: string | null;
  services: { running: number; desired: number } | null;
  error: string | null;
  /** the error behind `error`, thrown when the environment was named */
  failure?: CLIError;
}

const TIMEOUT = Symbol('status-timeout');

/** `cancel` must run once the race settles: a pending timer keeps the process alive until it fires. */
function timeout(ms: number): { expired: Promise<typeof TIMEOUT>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

/** What `status` reads before it can call `openDay2`, so tests never touch this checkout's own servers.yml. */
export interface StatusDeps {
  availableEnvironments(): string[];
  managerCount(env: string): number;
  /** core 8.6 per-command budget; overridable so a timeout can be exercised without a real wait */
  budgetMs(managers: number): number;
}

const defaultStatusDeps: StatusDeps = {
  availableEnvironments: getAvailableEnvironments,
  managerCount: (env) => getManagersForEnvironment(env).length,
  budgetMs: (managers) => (managers > 1 ? STATUS_BUDGET_MULTI_MANAGER_MS : STATUS_BUDGET_SINGLE_MANAGER_MS),
};

async function getEnvStatus(env: string, deps: StatusDeps): Promise<EnvStatus> {
  const unavailable = (error: string, failure: CLIError): EnvStatus => ({ env, version: null, deployedAt: null, services: null, error, failure });
  const managers = deps.managerCount(env);
  if (managers === 0) {
    return unavailable('no manager configured', new CLIError(`No manager is configured for ${env}`, ErrorCode.NO_SERVERS_FOR_ENV, 'Tag a manager with it in servers.yml.'));
  }

  const budgetMs = deps.budgetMs(managers);
  const budget = timeout(budgetMs);
  try {
    const raced = await Promise.race([openDay2(env, {}), budget.expired]);
    if (raced === TIMEOUT) return unavailable('timeout', new ConnectionError(`${env} did not answer within ${budgetMs / 1000}s`));
    const ctx = raced;
    const [meta, services] = await Promise.all([
      ctx.orchestrator.releases.current(ctx.stackName),
      ctx.orchestrator.stack.getServices(ctx.appRef),
    ]);
    const totals = services.reduce(
      (sum, s) => ({ running: sum.running + s.replicas.running, desired: sum.desired + s.replicas.desired }),
      { running: 0, desired: 0 },
    );
    return { env, version: meta?.version ?? null, deployedAt: meta?.timestamp ?? null, services: totals, error: null };
  } catch (error) {
    const failure = CLIError.from(error, ErrorCode.CONNECTION_FAILED);
    if (/No SSH credentials/.test(failure.message)) return unavailable('host not set (CI secret missing?)', failure);
    return unavailable(failure.message, failure);
  } finally {
    budget.cancel();
  }
}

function formatTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export async function runStatus(env: string | undefined, deps: StatusDeps = defaultStatusDeps): Promise<void> {
  printIntro(colors.bold('Deployment Status'));
  printBlank();

  const allEnvs = deps.availableEnvironments();
  if (allEnvs.length === 0) {
    printWarning('No environments configured in servers.yml');
    return;
  }

  const envs = env ? allEnvs.filter((e) => e === env) : allEnvs;
  if (envs.length === 0) {
    throw new CLIError(`Environment "${env}" not found`, ErrorCode.NO_SERVERS_FOR_ENV, `Available: ${allEnvs.join(', ')}`);
  }

  printSection('Fetching status…');
  printBlank();

  const results = await Promise.all(envs.map((e) => getEnvStatus(e, deps)));
  const named = env ? results[0] : undefined;
  if (named?.failure) throw named.failure;

  const COL = { env: 14, version: 22, services: 12, deployed: 16 };
  printRaw(colors.dim(`  ${'ENV'.padEnd(COL.env)}${'VERSION'.padEnd(COL.version)}${'SERVICES'.padEnd(COL.services)}DEPLOYED`));
  printRaw(colors.dim(`  ${'─'.repeat(COL.env + COL.version + COL.services + COL.deployed)}`));

  for (const r of results) {
    const envLabel = (r.env === 'production' ? colors.error : colors.warning)(r.env.padEnd(COL.env));
    if (r.error) {
      printRaw(`  ${envLabel}${colors.dim('unavailable'.padEnd(COL.version))}${colors.dim('—'.padEnd(COL.services))}${colors.dim(r.error)}`);
      continue;
    }
    const version = r.version ? colors.success(r.version.padEnd(COL.version)) : colors.dim('—'.padEnd(COL.version));
    const deployed = r.deployedAt ? colors.dim(formatTimestamp(r.deployedAt)) : colors.dim('—');
    let svcLabel = colors.dim('—'.padEnd(COL.services));
    if (r.services) {
      const svcStr = `${r.services.running}/${r.services.desired}`;
      svcLabel = (r.services.running === r.services.desired ? colors.success : colors.warning)(svcStr.padEnd(COL.services));
    }
    printRaw(`  ${envLabel}${version}${svcLabel}${deployed}`);
  }
  printBlank();
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status [env]')
    .description('Show deployment status (all environments, or a specific one)')
    .helpGroup('Inspect')
    .action(withServicesRequired(withSecrets((env?: string) => runStatus(env))));
}
