import type { Command } from 'commander';
import { printDebug, createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStack } from '../../services/swarm/stack';
import { CLIError, DockerError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { requireAppService, serviceMode } from './service-name';

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--no-wait', 'Return once Swarm accepted the change, without waiting for the service to converge')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string, replicas: string, options: { server?: string; wait?: boolean }) => {
      const { config, stackName, connection } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      if (!/^\d+$/.test(replicas)) {
        throw new CLIError('Replicas must be a non-negative integer', ErrorCode.INVALID_ARGUMENT);
      }
      const replicaCount = Number(replicas);

      await requireAppService(connection, env, stackName, service, 'scale');
      const mode = await serviceMode(connection, stackName, service);
      if (mode !== 'replicated') {
        throw new CLIError(
          `${service} runs in ${mode} mode, which has no replica count to scale`,
          ErrorCode.INVALID_ARGUMENT,
          mode === 'global' ? 'A global service runs one task per node.' : 'A job runs to completion; deploy it again to run it again.',
        );
      }

      const swarm = new SwarmStack(connection);
      const spinner = createSpinner();
      spinner.start(`Scaling ${stackName}_${service} to ${replicaCount} replicas...`);

      try {
        await swarm.scaleService(stackName, service, replicaCount, { detach: options.wait === false });
        spinner.succeed('Done');
      } catch (error) {
        if (error instanceof CLIError) {
          spinner.fail(error.message);
          throw error;
        }
        spinner.fail(`Failed to scale: ${error}`);
        throw new DockerError(`${error}`);
      }
    })));
}
