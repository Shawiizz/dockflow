/**
 * `dockflow status [env]` (design-06 3.7): one row per environment, fetched in parallel with a
 * per-env budget (core 8.6): 8s with one manager, 20s with several (failover probing needs the
 * extra time). Kept from today: the table shape and the four error column texts.
 */

import type { Command } from 'commander';
import { STATUS_BUDGET_MULTI_MANAGER_MS, STATUS_BUDGET_SINGLE_MANAGER_MS } from '../../constants';
import { withServicesRequired } from '../../utils/errors';
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
}

const TIMEOUT = Symbol('status-timeout');

function timeout(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
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
  const managers = deps.managerCount(env);
  if (managers === 0) return { env, version: null, deployedAt: null, services: null, error: 'no manager configured' };

  const budgetMs = deps.budgetMs(managers);
  try {
    const raced = await Promise.race([openDay2(env, {}), timeout(budgetMs)]);
    if (raced === TIMEOUT) return { env, version: null, deployedAt: null, services: null, error: 'timeout' };
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
    if (error instanceof Error && /No SSH credentials/.test(error.message)) {
      return { env, version: null, deployedAt: null, services: null, error: 'host not set (CI secret missing?)' };
    }
    return { env, version: null, deployedAt: null, services: null, error: error instanceof Error ? error.message : String(error) };
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
    printWarning(`Environment "${env}" not found. Available: ${allEnvs.join(', ')}`);
    return;
  }

  printSection('Fetching status…');
  printBlank();

  const results = await Promise.all(envs.map((e) => getEnvStatus(e, deps)));

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
