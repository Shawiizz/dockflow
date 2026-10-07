/**
 * Exec command - Execute commands in containers
 *
 * Also serves as: bash, shell (aliases)
 */

import type { Command } from 'commander';
import { printInfo, printDebug, printBlank } from '../../utils/output';
import { resolveEnv, getAllNodeConnections, withResolvedEnv } from '../../utils/validation';
import { createContainerBackend, createStackBackend } from '../../services/orchestrator/factory';
import { DockerError, CLIError, withServicesRequired } from '../../utils/errors';

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .aliases(['bash', 'shell'])
    .description('Execute a command in a container (default: interactive shell)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-u, --user <user>', 'Run as specified user')
    .option('-w, --workdir <dir>', 'Working directory inside container')
    .option('--sh', 'Use sh instead of bash for interactive shell')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string, command: string[], options: {
      server?: string;
      user?: string;
      workdir?: string;
      sh?: boolean;
    }) => {
      const { config, stackName, connection } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const execBackend = createContainerBackend(connection, getAllNodeConnections(env));
      const cmd = command.length > 0 ? command.join(' ') : undefined;

      try {
        // Interactive shell (no command, or explicit bash/sh)
        if (!cmd || cmd === 'bash' || cmd === 'sh') {
          printInfo(`Connecting to ${service}...`);
          printBlank();

          // Explicit sh or --sh flag → use sh directly; otherwise auto-detect bash/sh
          const result = (options.sh || cmd === 'sh')
            ? await execBackend.shell(stackName, service, '/bin/sh')
            : await execBackend.bash(stackName, service);

          if (!result.success) {
            const orchestrator = createStackBackend(connection);
            const services = await orchestrator.getServices(stackName);
            const suggestion = services.length > 0
              ? `Available services: ${services.map(s => s.name).join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { suggestion });
          }
        } else {
          // Execute non-interactive command
          printInfo(`Executing in ${service}...`);

          const result = await execBackend.exec(stackName, service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            throw new DockerError(result.error.message);
          }

          process.stdout.write(result.data.stdout);
          if (result.data.stderr) process.stderr.write(result.data.stderr);
          if (result.data.exitCode !== 0) {
            throw new CLIError(
              `Command exited with code ${result.data.exitCode}`,
              result.data.exitCode,
            );
          }
        }
      } catch (error) {
        if (error instanceof DockerError || error instanceof CLIError) throw error;
        throw new DockerError(`Failed to exec: ${error}`);
      }
    })));
}
