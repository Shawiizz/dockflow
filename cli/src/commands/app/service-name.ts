/**
 * The service an app command is given, checked against the stack: an accessory's name points to
 * the accessories command, an unknown one lists what exists.
 */

import type { SSHKeyConnection } from '../../types';
import { createStackBackend } from '../../services/orchestrator/factory';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec, shellQuote } from '../../utils/ssh';
import { CLIError, ErrorCode } from '../../utils/errors';
import { qualifyServiceName } from '../../services/orchestrator/swarm/swarm-utils';

/** The commands `dockflow accessories` has too. */
const ACCESSORY_COMMANDS = new Set(['exec', 'logs', 'restart', 'stop']);

/** The error for `service` missing from `services`, the app's service names. */
export function unknownServiceError(
  env: string,
  stackName: string,
  service: string,
  services: readonly string[],
  isAccessory: boolean,
  command: string,
): CLIError {
  if (isAccessory) {
    return new CLIError(
      `'${service}' is an accessory of ${env}, not a service of the app`,
      ErrorCode.SERVICE_NOT_FOUND,
      ACCESSORY_COMMANDS.has(command)
        ? `Run \`dockflow accessories ${command} ${env} ${service}\`.`
        : `Accessories have no ${command}: change accessories.yml and run \`dockflow deploy ${env} --accessories\`.`,
    );
  }
  if (services.length === 0) {
    return new CLIError(`Nothing is deployed to ${env} (${stackName})`, ErrorCode.STACK_NOT_FOUND, `Deploy first: \`dockflow deploy ${env}\`.`);
  }
  return new CLIError(`No service ${service} in ${stackName}`, ErrorCode.SERVICE_NOT_FOUND, `Services: ${services.join(', ')}`);
}

export async function requireAppService(
  connection: SSHKeyConnection,
  env: string,
  stackName: string,
  service: string,
  command: string,
): Promise<void> {
  const services = (await createStackBackend(connection).getServices(stackName)).map((s) => s.name);
  if (services.includes(service) || services.includes(service.replace(`${stackName}_`, ''))) return;

  const accessories = getAccessoriesStackName(env);
  let isAccessory = false;
  if (accessories) {
    const listed = await sshExec(connection, `docker stack services ${shellQuote(accessories)} --format '{{.Name}}' 2>/dev/null`);
    isAccessory = listed.stdout.split('\n').map((line) => line.trim()).includes(`${accessories}_${service}`);
  }
  throw unknownServiceError(env, stackName, service, services, isAccessory, command);
}

export type ServiceMode = 'replicated' | 'global' | 'replicated-job' | 'global-job';

/** The Swarm mode of an app service, read from the running service. */
export async function serviceMode(connection: SSHKeyConnection, stackName: string, service: string): Promise<ServiceMode> {
  const result = await sshExec(
    connection,
    `docker service inspect ${shellQuote(qualifyServiceName(stackName, service))} --format '{{if .Spec.Mode.Global}}global{{else if .Spec.Mode.GlobalJob}}global-job{{else if .Spec.Mode.ReplicatedJob}}replicated-job{{else}}replicated{{end}}'`,
  );
  const mode = result.stdout.trim();
  return mode === 'global' || mode === 'global-job' || mode === 'replicated-job' ? mode : 'replicated';
}

/** Services among `names` whose desired replica count is 0: a restart leaves them stopped. */
export function idleServices(services: readonly { name: string; replicas: string }[], names: readonly string[]): string[] {
  return services
    .filter((s) => names.includes(s.name) && s.replicas.split('/')[1]?.trim() === '0')
    .map((s) => s.name);
}
