/** Checks that the accessories stack and its services exist, for the accessories commands. */

import type { SSHKeyConnection } from '../../types/connection';
import { getAccessoriesStackName } from '../../utils/config';
import { shellQuote, sshExec } from '../../utils/ssh';
import { runDockerQuery } from '../../services/swarm/docker';
import { DockerError, ErrorCode } from '../../utils/errors';

export interface StackValidation {
  exists: boolean;
  stackName: string;
  services: string[];
}

export async function validateAccessoriesStack(
  connection: SSHKeyConnection,
  env: string
): Promise<StackValidation> {
  const stackName = getAccessoriesStackName(env)!;
  
  const stacks = (await runDockerQuery(connection, `docker stack ls --format '{{.Name}}'`, 'docker stack ls') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!stacks.includes(stackName)) {
    return { exists: false, stackName, services: [] };
  }

  const services = (await runDockerQuery(connection, `docker stack services ${shellQuote(stackName)} --format '{{.Name}}'`, 'docker stack services') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return { exists: true, stackName, services };
}

/** Throws a DockerError when the accessories stack is not deployed. */
export async function requireAccessoriesStack(
  connection: SSHKeyConnection,
  env: string,
  action: string = 'perform this action'
): Promise<{ stackName: string; services: string[] }> {
  const validation = await validateAccessoriesStack(connection, env);
  
  if (!validation.exists) {
    throw new DockerError(
      'Accessories not deployed yet',
      { code: ErrorCode.STACK_NOT_FOUND, suggestion: `Deploy with: dockflow deploy ${env} --accessories` }
    );
  }

  return { stackName: validation.stackName, services: validation.services };
}

export async function validateAccessoryService(
  connection: SSHKeyConnection,
  stackName: string,
  service: string
): Promise<boolean> {
  const fullServiceName = `${stackName}_${service}`;
  
  const checkResult = await sshExec(connection, 
    `docker service ls --filter "name=${fullServiceName}" --format "{{.Name}}"`
  );
  
  return checkResult.stdout.trim() !== '';
}

/** Throws a DockerError listing the available accessories when the service is missing; otherwise returns its full Swarm name. */
export async function requireAccessoryService(
  connection: SSHKeyConnection,
  stackName: string,
  service: string
): Promise<string> {
  const exists = await validateAccessoryService(connection, stackName, service);
  
  if (!exists) {
    const servicesResult = await sshExec(connection, 
      `docker stack services ${stackName} --format "{{.Name}}" | sed 's/${stackName}_//'`
    );
    
    const available = servicesResult.stdout.trim()
      ? `Available accessories: ${servicesResult.stdout.trim().split('\n').join(', ')}`
      : undefined;
    
    throw new DockerError(
      `Accessory '${service}' not found`,
      { code: ErrorCode.SERVICE_NOT_FOUND, suggestion: available }
    );
  }

  return `${stackName}_${service}`;
}

export function getShortServiceNames(services: string[], stackName: string): string[] {
  return services.map(s => s.replace(`${stackName}_`, ''));
}
