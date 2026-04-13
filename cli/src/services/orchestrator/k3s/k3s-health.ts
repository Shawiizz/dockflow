/**
 * k3s health backend.
 *
 * Implements HealthBackend by checking pod status via kubectl.
 * Detects CrashLoopBackOff as immediate failure and polls until
 * all pods are Running or timeout is reached.
 */

import type { SSHKeyConnection } from '../../../types';
import { sshExec } from '../../../utils/ssh';
import { K3S_DOCKFLOW_KUBECONFIG, K3S_NAMESPACE_PREFIX } from '../../../constants';
import type { HealthBackend, InternalHealthResult } from '../health-interface';

export class K3sHealthBackend implements HealthBackend {
  private readonly kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;

  constructor(private readonly conn: SSHKeyConnection) {}

  async checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult> {
    const ns = `${K3S_NAMESPACE_PREFIX}-${stackName}`;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      // Check for CrashLoopBackOff — signal failure immediately
      const crash = await sshExec(
        this.conn,
        `${this.kube} get pods -n ${ns} -o jsonpath=` +
          `'{.items[?(@.status.containerStatuses[0].state.waiting.reason=="CrashLoopBackOff")].metadata.name}' 2>/dev/null`,
      );

      const crashedPods = crash.stdout.trim().replace(/^'|'$/g, '');
      if (crashedPods) {
        return {
          healthy: false,
          rolledBack: false,
          failedService: crashedPods.split(' ')[0],
          message: `CrashLoopBackOff detected: ${crashedPods}`,
        };
      }

      // Check for pods not yet Running
      const notReady = await sshExec(
        this.conn,
        `${this.kube} get pods -n ${ns} --field-selector=status.phase!=Running,status.phase!=Succeeded ` +
          `-o jsonpath='{.items[*].metadata.name}' 2>/dev/null`,
      );

      const notReadyPods = notReady.stdout.trim().replace(/^'|'$/g, '');
      if (!notReadyPods) {
        return { healthy: true, rolledBack: false };
      }

      await Bun.sleep(intervalSeconds * 1000);
    }

    return {
      healthy: false,
      rolledBack: false,
      message: 'Timeout waiting for pods to be Ready',
    };
  }
}
