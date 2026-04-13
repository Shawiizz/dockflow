/**
 * Abstraction du health check interne à l'orchestrateur.
 * - Swarm : inspecte les tasks via `docker service ps` + UpdateStatus
 * - k3s   : inspecte les pods via `kubectl get pods` + CrashLoopBackOff detection
 *
 * Le check des endpoints HTTP est déjà générique dans HealthCheckService
 * et n'a pas besoin d'être abstrait.
 */
export interface HealthBackend {
  checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult>;
}

export interface InternalHealthResult {
  healthy: boolean;
  rolledBack: boolean;
  failedService?: string;
  message?: string;
}
