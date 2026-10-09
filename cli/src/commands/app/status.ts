/**
 * `dockflow status [env]`: one row per environment, fetched in parallel within a budget each. An
 * environment named on the command line that cannot be read fails the command with its own error
 * and exit code instead of a row, so scripts can rely on the exit code.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { getAvailableEnvironments, getManagersForEnvironment } from '../../utils/servers';
import { createStackBackend } from '../../services/orchestrator/factory';
import { withSecrets } from '../../utils/secrets';
import { CLIError, ConnectionError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { resolveEnv, resolveEnvironmentPrefix } from '../../utils/validation';
import { printIntro, printBlank, printRaw, printSection, printWarning, colors } from '../../utils/output';

const STATUS_BUDGET_MS = 8000;
/** time to find, among several managers, one that answers, then read through it */
const STATUS_FAILOVER_BUDGET_MS = 20000;

export interface EnvReading {
  version: string | null;
  deployedAt: string | null;
  services: { running: number; desired: number };
}

interface EnvStatus {
  env: string;
  reading: EnvReading | null;
  /** the short text of the row */
  error: string | null;
  /** the error behind `error`, thrown when the environment was named */
  failure?: CLIError;
}

/** What `status` reads, so tests never touch this checkout's own servers.yml or a server. */
export interface StatusDeps {
  availableEnvironments(): string[];
  /** throws a CLIError when the environment cannot be read */
  read(env: string): Promise<EnvReading>;
  budgetMs(env: string): number;
}

async function readEnvironment(env: string): Promise<EnvReading> {
  const { stackName, connection } = await resolveEnv(env);
  const orchestrator = createStackBackend(connection);
  const [meta, services] = await Promise.all([orchestrator.getMetadata(stackName), orchestrator.getServices(stackName)]);
  const totals = services.reduce(
    (sum, s) => {
      const [running, desired] = s.replicas.split('/').map(Number);
      return { running: sum.running + (running || 0), desired: sum.desired + (desired || 0) };
    },
    { running: 0, desired: 0 },
  );
  return { version: meta?.version ?? null, deployedAt: meta?.timestamp ?? null, services: totals };
}

const defaultStatusDeps: StatusDeps = {
  availableEnvironments: getAvailableEnvironments,
  read: readEnvironment,
  budgetMs: (env) => (getManagersForEnvironment(env).length > 1 ? STATUS_FAILOVER_BUDGET_MS : STATUS_BUDGET_MS),
};

const TIMEOUT = Symbol('status-timeout');

/** `cancel` must run once the race settles: a pending timer keeps the process alive until it fires. */
function timeout(ms: number): { expired: Promise<typeof TIMEOUT>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

function rowText(failure: CLIError): string {
  if (failure.code === ErrorCode.NO_SERVERS_FOR_ENV) return 'no manager configured';
  if (failure.code === ErrorCode.SSH_KEY_NOT_FOUND) return 'host not set (CI secret missing?)';
  return failure.message;
}

async function getEnvStatus(env: string, deps: StatusDeps): Promise<EnvStatus> {
  const budgetMs = deps.budgetMs(env);
  const budget = timeout(budgetMs);
  try {
    const reading = await Promise.race([deps.read(env), budget.expired]);
    if (reading === TIMEOUT) {
      return { env, reading: null, error: 'timeout', failure: new ConnectionError(`${env} did not answer within ${budgetMs / 1000}s`) };
    }
    return { env, reading, error: null };
  } catch (error) {
    const failure = CLIError.from(error, ErrorCode.CONNECTION_FAILED);
    return { env, reading: null, error: rowText(failure), failure };
  } finally {
    budget.cancel();
  }
}

function formatTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export async function runStatus(env: string | undefined, deps: StatusDeps = defaultStatusDeps): Promise<void> {
  printIntro(chalk.bold('Deployment Status'));
  printBlank();

  const allEnvs = deps.availableEnvironments();
  if (allEnvs.length === 0) {
    printWarning('No environments configured in servers.yml');
    return;
  }

  const envs = env ? allEnvs.filter(e => e === env) : allEnvs;
  if (envs.length === 0) {
    throw new CLIError(`Environment "${env}" not found`, ErrorCode.NO_SERVERS_FOR_ENV, `Available: ${allEnvs.join(', ')}`);
  }

  printSection('Fetching status…');
  printBlank();

  const results = await Promise.all(envs.map(e => getEnvStatus(e, deps)));
  const named = env ? results[0] : undefined;
  if (named?.failure) throw named.failure;

  const COL = { env: 14, version: 22, services: 12, deployed: 16 };
  printRaw(
    colors.dim(
      `  ${'ENV'.padEnd(COL.env)}${'VERSION'.padEnd(COL.version)}${'SERVICES'.padEnd(COL.services)}DEPLOYED`,
    ),
  );
  printRaw(colors.dim(`  ${'─'.repeat(COL.env + COL.version + COL.services + COL.deployed)}`));

  for (const r of results) {
    const envLabel = (r.env === 'production' ? colors.error : colors.warning)(r.env.padEnd(COL.env));

    if (!r.reading) {
      printRaw(
        `  ${envLabel}${colors.dim('unavailable'.padEnd(COL.version))}${colors.dim('—'.padEnd(COL.services))}${colors.dim(r.error ?? '')}`,
      );
      continue;
    }

    const { version, deployedAt, services } = r.reading;
    const versionLabel = version ? colors.success(version.padEnd(COL.version)) : colors.dim('—'.padEnd(COL.version));
    const deployed = deployedAt ? colors.dim(formatTimestamp(deployedAt)) : colors.dim('—');
    const svcStr = `${services.running}/${services.desired}`;
    const svcLabel = (services.running === services.desired ? colors.success : colors.warning)(svcStr.padEnd(COL.services));

    printRaw(`  ${envLabel}${versionLabel}${svcLabel}${deployed}`);
  }

  printBlank();
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status [env]')
    .description('Show deployment status (all environments, or a specific one)')
    .helpGroup('Inspect')
    .action(withServicesRequired(withSecrets((env?: string) => runStatus(env === undefined ? undefined : resolveEnvironmentPrefix(env)))));
}
