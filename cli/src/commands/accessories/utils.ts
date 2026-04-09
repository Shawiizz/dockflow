/**
 * Accessories utilities - Shared functions for accessories commands
 * Follows DRY principle by centralizing common operations
 */

import type { SSHKeyConnection } from '../../types/connection';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec } from '../../utils/ssh';
import { DockerError, ErrorCode } from '../../utils/errors';

/**
 * Result of stack validation
 */
export interface StackValidation {
  exists: boolean;
  stackName: string;
  services: string[];
}

/**
 * Check if accessories stack exists and return its services
 */
export async function validateAccessoriesStack(
  connection: SSHKeyConnection,
  env: string
): Promise<StackValidation> {
  const stackName = getAccessoriesStackName(env)!;
  
  const stacksResult = await sshExec(connection, `docker stack ls --format "{{.Name}}"`);
  const stacks = stacksResult.stdout.trim().split('\n').filter(Boolean);
  
  if (!stacks.includes(stackName)) {
    return { exists: false, stackName, services: [] };
  }

  const servicesResult = await sshExec(connection, 
    `docker stack services ${stackName} --format "{{.Name}}"`
  );
  const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

  return { exists: true, stackName, services };
}

/**
 * Throw error if accessories stack doesn't exist
 */
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

/**
 * Check if a specific service exists in the accessories stack
 */
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

/**
 * Throw error if accessory service doesn't exist, showing available services
 */
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

/**
 * Get short service names (without stack prefix)
 */
export function getShortServiceNames(services: string[], stackName: string): string[] {
  return services.map(s => s.replace(`${stackName}_`, ''));
}
