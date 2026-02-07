/**
 * Docker Service Operations
 * 
 * Provides high-level operations for managing Docker Swarm services
 * via SSH connections to remote hosts.
 */

import type { SSHKeyConnection, SSHExecResult } from '../types';
import { sshExec, sshExecStream } from '../utils/ssh';

/**
 * Get all services in a stack
 */
export async function getStackServices(
  conn: SSHKeyConnection,
  stackName: string
): Promise<string[]> {
  const result = await sshExec(conn, `docker stack services ${stackName} --format '{{.Name}}'`);
  return result.stdout.trim().split('\n').filter(Boolean);
}

/**
 * Get running containers for a stack
 */
export async function getStackContainers(
  conn: SSHKeyConnection,
  stackName: string
): Promise<string[]> {
  const result = await sshExec(
    conn,
    `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.ID}}'`
  );
  return result.stdout.trim().split('\n').filter(Boolean);
}

/**
 * Find container ID for a specific service
 */
export async function findServiceContainer(
  conn: SSHKeyConnection,
  stackName: string,
  serviceName: string
): Promise<string | null> {
  const fullServiceName = `${stackName}_${serviceName}`;
  const result = await sshExec(
    conn,
    `docker ps --filter "label=com.docker.swarm.service.name=${fullServiceName}" --format '{{.ID}}' | head -n1`
  );
  const containerId = result.stdout.trim();
  return containerId || null;
}

/**
 * Service operation types for the Strategy pattern
 */
export type ServiceOperation = 
  | { type: 'restart' }
  | { type: 'rollback' }
  | { type: 'scale'; replicas: number }
  | { type: 'logs'; tail: number; follow: boolean };

/**
 * Operation result
 */
export interface ServiceOperationResult {
  service: string;
  success: boolean;
  message?: string;
}

/**
 * Execute an operation on a single service
 */
async function executeServiceOperation(
  conn: SSHKeyConnection,
  serviceName: string,
  operation: ServiceOperation
): Promise<ServiceOperationResult> {
  let result: SSHExecResult;

  switch (operation.type) {
    case 'restart':
      result = await sshExec(conn, `docker service update --force ${serviceName}`);
      break;
    case 'rollback':
      result = await sshExec(conn, `docker service rollback ${serviceName}`);
      break;
    case 'scale':
      result = await sshExec(conn, `docker service scale ${serviceName}=${operation.replicas}`);
      break;
    case 'logs':
      // Logs are streamed, not returned
      await sshExecStream(
        conn,
        `docker service logs ${operation.follow ? '-f' : ''} --tail ${operation.tail} ${serviceName} 2>&1`
      );
      return { service: serviceName, success: true };
  }

  return {
    service: serviceName,
    success: result.exitCode === 0,
    message: result.exitCode !== 0 ? result.stderr.trim() : undefined,
  };
}

/**
 * Execute an operation on one or all services in a stack.
 * Provides progress callbacks for UI feedback during bulk operations.
 */
export async function executeOnServices(
  conn: SSHKeyConnection,
  stackName: string,
  operation: ServiceOperation,
  targetService?: string,
  onProgress?: (service: string, status: 'started' | 'completed' | 'failed') => void
): Promise<ServiceOperationResult[]> {
  const results: ServiceOperationResult[] = [];

  if (targetService) {
    // Single service operation
    const fullServiceName = `${stackName}_${targetService}`;
    onProgress?.(fullServiceName, 'started');
    
    const result = await executeServiceOperation(conn, fullServiceName, operation);
    results.push(result);
    
    onProgress?.(fullServiceName, result.success ? 'completed' : 'failed');
  } else {
    // All services operation
    const services = await getStackServices(conn, stackName);
    
    if (services.length === 0) {
      return [{
        service: stackName,
        success: false,
        message: `No services found for stack ${stackName}`,
      }];
    }

    for (const serviceName of services) {
      onProgress?.(serviceName, 'started');
      
      const result = await executeServiceOperation(conn, serviceName, operation);
      results.push(result);
      
      onProgress?.(serviceName, result.success ? 'completed' : 'failed');
    }
  }

  return results;
}

/**
 * Get stack details including services, tasks, and resource usage
 */
export async function getStackDetails(
  conn: SSHKeyConnection,
  stackName: string
): Promise<{ services: string; tasks: string; stats: string }> {
  const [servicesResult, tasksResult, containerIds] = await Promise.all([
    sshExec(conn, `docker stack services ${stackName}`),
    sshExec(conn, `docker stack ps ${stackName} --no-trunc`),
    sshExec(conn, `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.ID}}' | tr '\\n' ' '`),
  ]);

  let stats = 'No running containers';
  if (containerIds.stdout.trim()) {
    const statsResult = await sshExec(conn, `docker stats --no-stream ${containerIds.stdout.trim()}`);
    stats = statsResult.stdout;
  }

  return {
    services: servicesResult.stdout,
    tasks: tasksResult.stdout,
    stats,
  };
}
