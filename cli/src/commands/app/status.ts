import type { Command } from 'commander';
import chalk from 'chalk';
import { getAvailableEnvironments, getManagersForEnvironment, getFullConnectionInfo } from '../../utils/servers';
import { createStackService } from '../../services';
import { withSecrets } from '../../utils/secrets';
import { withErrorHandler } from '../../utils/errors';
import { printIntro, printBlank, printRaw, printSection, printWarning, colors } from '../../utils/output';

interface EnvStatus {
  env: string;
  version: string | null;
  deployedAt: string | null;
  services: { running: number; desired: number } | null;
  error: string | null;
}

async function getEnvStatus(env: string): Promise<EnvStatus> {
  const managers = getManagersForEnvironment(env);
  if (managers.length === 0) {
    return { env, version: null, deployedAt: null, services: null, error: 'no manager configured' };
  }

  const mgr = managers[0];
  const connection = getFullConnectionInfo(env, mgr.name);

  if (!connection) {
    return { env, version: null, deployedAt: null, services: null, error: 'host not set (CI secret missing?)' };
  }

  try {
    const config = (await import('../../utils/config')).loadConfig();
    if (!config) return { env, version: null, deployedAt: null, services: null, error: 'config.yml not found' };

    const stackName = `${config.project_name}-${env}`;
    const stackService = createStackService(connection, stackName);

    const [metaResult, servicesResult] = await Promise.allSettled([
      stackService.getMetadata(),
      stackService.getServices(),
    ]);

    const meta = metaResult.status === 'fulfilled' && metaResult.value.success
      ? metaResult.value.data
      : null;

    let services: { running: number; desired: number } | null = null;
    if (servicesResult.status === 'fulfilled' && servicesResult.value.success) {
      const svcs = servicesResult.value.data;
      const running = svcs.reduce((sum, s) => {
        const [cur] = s.replicas.split('/').map(Number);
        return sum + (cur || 0);
      }, 0);
      const desired = svcs.reduce((sum, s) => {
        const [, des] = s.replicas.split('/').map(Number);
        return sum + (des || 0);
      }, 0);
      services = { running, desired };
    }

    return {
      env,
      version: meta?.version ?? null,
      deployedAt: meta?.timestamp ?? null,
      services,
      error: null,
    };
  } catch (e) {
    return { env, version: null, deployedAt: null, services: null, error: String(e) };
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

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show deployment status across all environments')
    .helpGroup('Inspect')
    .action(withErrorHandler(withSecrets(async () => {
      printIntro(chalk.bold('Deployment Status'));
      printBlank();

      const envs = getAvailableEnvironments();
      if (envs.length === 0) {
        printWarning('No environments configured in servers.yml');
        return;
      }

      printSection('Fetching status…');
      printBlank();

      // Connect to all envs in parallel, with individual timeouts
      const results = await Promise.all(
        envs.map(env =>
          Promise.race([
            getEnvStatus(env),
            new Promise<EnvStatus>(resolve =>
              setTimeout(() => resolve({ env, version: null, deployedAt: null, services: null, error: 'timeout' }), 8000),
            ),
          ]),
        ),
      );

      // Header
      const COL = { env: 14, version: 22, services: 12, deployed: 16 };
      printRaw(
        colors.dim(
          `  ${'ENV'.padEnd(COL.env)}${'VERSION'.padEnd(COL.version)}${'SERVICES'.padEnd(COL.services)}DEPLOYED`,
        ),
      );
      printRaw(colors.dim(`  ${'─'.repeat(COL.env + COL.version + COL.services + COL.deployed)}`));

      for (const r of results) {
        const envLabel = (r.env === 'production' ? colors.error : colors.warning)(r.env.padEnd(COL.env));

        if (r.error) {
          printRaw(
            `  ${envLabel}${colors.dim('unavailable'.padEnd(COL.version))}${colors.dim('—'.padEnd(COL.services))}${colors.dim(r.error)}`,
          );
          continue;
        }

        const version = r.version ? colors.success(r.version.padEnd(COL.version)) : colors.dim('—'.padEnd(COL.version));
        const deployed = r.deployedAt ? colors.dim(formatTimestamp(r.deployedAt)) : colors.dim('—');

        let svcLabel = colors.dim('—'.padEnd(COL.services));
        if (r.services) {
          const { running, desired } = r.services;
          const svcStr = `${running}/${desired}`;
          svcLabel = (running === desired ? colors.success : colors.warning)(svcStr.padEnd(COL.services));
        }

        printRaw(`  ${envLabel}${version}${svcLabel}${deployed}`);
      }

      printBlank();
    })));
}
