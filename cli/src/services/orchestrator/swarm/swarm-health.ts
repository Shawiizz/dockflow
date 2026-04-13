/**
 * Swarm health backend.
 *
 * Thin wrapper that implements HealthBackend by delegating to
 * HealthCheckService.checkSwarmHealth. No health-check logic lives here.
 */

import type { SSHKeyConnection } from '../../../types';
import { HealthCheckService } from '../../health-check-service';
import { DeployError } from '../../../utils/errors';
import type { HealthBackend, InternalHealthResult } from '../health-interface';

export class SwarmHealthBackend implements HealthBackend {
  private readonly inner: HealthCheckService;

  constructor(conn: SSHKeyConnection) {
    this.inner = new HealthCheckService(conn);
  }

  async checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult> {
    try {
      const result = await this.inner.checkSwarmHealth(stackName, undefined, {
        enabled: true,
        timeout: timeoutSeconds,
        interval: intervalSeconds,
      });

      if (result.rolledBack.length > 0) {
        return {
          healthy: false,
          rolledBack: true,
          failedService: result.rolledBack[0],
          message: `Swarm auto-rolled back: ${result.rolledBack.join(', ')}`,
        };
      }

      if (result.unhealthy.length > 0) {
        return {
          healthy: false,
          rolledBack: false,
          failedService: result.unhealthy[0],
          message: `Unhealthy services: ${result.unhealthy.join(', ')}`,
        };
      }

      return { healthy: true, rolledBack: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rolledBack = e instanceof DeployError && /rolled back|rollback/i.test(msg);
      return { healthy: false, rolledBack, message: msg };
    }
  }
}
