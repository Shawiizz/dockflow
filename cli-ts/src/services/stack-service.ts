/**
 * Stack Service
 * 
 * High-level service for managing Docker Swarm stacks.
 * Encapsulates all stack-related operations and provides
 * a clean API for commands to use.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecStream } from '../utils/ssh';
import { ok, err, type Result } from '../types';

/**
 * Service information from Docker Swarm
 */
export interface ServiceInfo {
  name: string;
  fullName: string;
  image: string;
  replicas: string;
  ports: string;
}

/**
 * Container information
 */
export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  ports: string;
}

/**
 * Task information from Docker Swarm
 */
export interface TaskInfo {
  id: string;
  name: string;
  image: string;
  node: string;
  desiredState: string;
  currentState: string;
  error: string;
}

/**
 * Stack metadata from deployment
 */
export interface StackMetadata {
  version: string;
  environment: string;
  branch: string;
  timestamp: string;
  project_name: string;
}

/**
 * Operation result for service actions
 */
export interface OperationResult {
  success: boolean;
  message?: string;
  output?: string;
}

/**
 * Stack Service - manages Docker Swarm stack operations
 */
export class StackService {
  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string
  ) {}

  /**
   * Get the stack name
   */
  get name(): string {
    return this.stackName;
  }

  /**
   * Check if the stack exists
   */
  async exists(): Promise<boolean> {
    const result = sshExec(this.connection, `docker stack ls --format '{{.Name}}' | grep -q "^${this.stackName}$" && echo "exists" || echo "not_found"`);
    return result.stdout.trim() === 'exists';
  }

  /**
   * Get all services in the stack
   */
  async getServices(): Promise<Result<ServiceInfo[], Error>> {
    try {
      const result = sshExec(
        this.connection,
        `docker stack services ${this.stackName} --format '{{.Name}}|{{.Image}}|{{.Replicas}}|{{.Ports}}' 2>/dev/null`
      );

      if (result.exitCode !== 0) {
        return err(new Error(`Failed to get services: ${result.stderr}`));
      }

      const services = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [fullName, image, replicas, ports] = line.split('|');
          const name = fullName.replace(`${this.stackName}_`, '');
          return { name, fullName, image, replicas, ports };
        });

      return ok(services);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get service names only
   */
  async getServiceNames(): Promise<string[]> {
    const result = await this.getServices();
    if (!result.success) return [];
    return result.data.map(s => s.name);
  }

  /**
   * Get full service names (with stack prefix)
   */
  async getFullServiceNames(): Promise<string[]> {
    const result = await this.getServices();
    if (!result.success) return [];
    return result.data.map(s => s.fullName);
  }

  /**
   * Get running containers for the stack
   */
  async getContainers(): Promise<Result<ContainerInfo[], Error>> {
    try {
      const result = sshExec(
        this.connection,
        `docker ps --filter "label=com.docker.stack.namespace=${this.stackName}" --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}'`
      );

      if (result.exitCode !== 0) {
        return err(new Error(`Failed to get containers: ${result.stderr}`));
      }

      const containers = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [id, name, status, ports] = line.split('|');
          return { id, name, status, ports };
        });

      return ok(containers);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get tasks for the stack
   */
  async getTasks(): Promise<Result<TaskInfo[], Error>> {
    try {
      const result = sshExec(
        this.connection,
        `docker stack ps ${this.stackName} --format '{{.ID}}|{{.Name}}|{{.Image}}|{{.Node}}|{{.DesiredState}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null`
      );

      if (result.exitCode !== 0) {
        return err(new Error(`Failed to get tasks: ${result.stderr}`));
      }

      const tasks = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [id, name, image, node, desiredState, currentState, error] = line.split('|');
          return { id, name, image, node, desiredState, currentState, error };
        });

      return ok(tasks);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get deployment metadata
   */
  async getMetadata(): Promise<Result<StackMetadata, Error>> {
    try {
      const result = sshExec(
        this.connection,
        `cat /var/lib/dockflow/stacks/${this.stackName}/current/metadata.json 2>/dev/null`
      );

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return err(new Error('No deployment metadata found'));
      }

      const metadata = JSON.parse(result.stdout.trim()) as StackMetadata;
      return ok(metadata);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Find a container ID for a specific service
   */
  async findContainerForService(serviceName: string): Promise<string | null> {
    const fullServiceName = serviceName.includes('_') 
      ? serviceName 
      : `${this.stackName}_${serviceName}`;
      
    const result = sshExec(
      this.connection,
      `docker ps --filter "label=com.docker.swarm.service.name=${fullServiceName}" --format '{{.ID}}' | head -n1`
    );
    
    return result.stdout.trim() || null;
  }

  /**
   * Restart a service or all services
   */
  async restart(serviceName?: string): Promise<OperationResult> {
    if (serviceName) {
      const fullName = `${this.stackName}_${serviceName}`;
      const result = sshExec(this.connection, `docker service update --force ${fullName}`);
      return {
        success: result.exitCode === 0,
        message: result.exitCode === 0 ? `Restarted ${fullName}` : result.stderr,
        output: result.stdout,
      };
    }

    // Restart all services
    const services = await this.getFullServiceNames();
    if (services.length === 0) {
      return { success: false, message: 'No services found' };
    }

    const results: string[] = [];
    let allSuccess = true;

    for (const svc of services) {
      const result = sshExec(this.connection, `docker service update --force ${svc}`);
      if (result.exitCode !== 0) {
        allSuccess = false;
        results.push(`${svc}: failed - ${result.stderr}`);
      } else {
        results.push(`${svc}: restarted`);
      }
    }

    return {
      success: allSuccess,
      message: allSuccess ? `Restarted ${services.length} services` : 'Some services failed to restart',
      output: results.join('\n'),
    };
  }

  /**
   * Scale a service
   */
  async scale(serviceName: string, replicas: number): Promise<OperationResult> {
    const fullName = `${this.stackName}_${serviceName}`;
    const result = sshExec(this.connection, `docker service scale ${fullName}=${replicas}`);
    
    return {
      success: result.exitCode === 0,
      message: result.exitCode === 0 
        ? `Scaled ${fullName} to ${replicas} replicas` 
        : result.stderr,
      output: result.stdout,
    };
  }

  /**
   * Rollback a service or all services
   */
  async rollback(serviceName?: string): Promise<OperationResult> {
    if (serviceName) {
      const fullName = `${this.stackName}_${serviceName}`;
      const result = sshExec(this.connection, `docker service rollback ${fullName}`);
      return {
        success: result.exitCode === 0,
        message: result.exitCode === 0 ? `Rolled back ${fullName}` : result.stderr,
        output: result.stdout,
      };
    }

    // Rollback all services in parallel
    const services = await this.getFullServiceNames();
    if (services.length === 0) {
      return { success: false, message: 'No services found' };
    }

    const rollbackCmd = services.map(svc => `docker service rollback ${svc} 2>&1`).join(' & ');
    const result = sshExec(this.connection, `${rollbackCmd}; wait`);

    return {
      success: result.exitCode === 0,
      message: result.exitCode === 0 
        ? `Rolled back ${services.length} services` 
        : 'Some rollbacks may have failed',
      output: result.stdout,
    };
  }

  /**
   * Remove the stack
   */
  async remove(): Promise<OperationResult> {
    const result = sshExec(this.connection, `docker stack rm ${this.stackName}`);
    return {
      success: result.exitCode === 0,
      message: result.exitCode === 0 ? `Removed stack ${this.stackName}` : result.stderr,
      output: result.stdout,
    };
  }

  /**
   * Get resource stats for the stack
   */
  async getStats(): Promise<string> {
    const containersResult = await this.getContainers();
    if (!containersResult.success || containersResult.data.length === 0) {
      return 'No running containers';
    }

    const containerIds = containersResult.data.map(c => c.id).join(' ');
    const result = sshExec(this.connection, `docker stats --no-stream ${containerIds}`);
    
    return result.stdout;
  }
}

/**
 * Factory function to create a StackService
 */
export function createStackService(
  connection: SSHKeyConnection,
  stackName: string
): StackService {
  return new StackService(connection, stackName);
}
