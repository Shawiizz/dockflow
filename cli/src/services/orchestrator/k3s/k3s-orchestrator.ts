/**
 * k3s orchestrator backend.
 *
 * Implements OrchestratorService via SSH + kubectl commands.
 * All operations target the k3s cluster through the dockflow kubeconfig.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { sshExec } from '../../../utils/ssh';
import {
  DOCKFLOW_STACKS_DIR,
  K3S_DOCKFLOW_KUBECONFIG,
  K3S_NAMESPACE_PREFIX,
} from '../../../constants';
import { K8sManifestService } from '../../k8s-manifest-service';
import { ComposeService, type ParsedCompose } from '../../compose-service';
import type { DockflowConfig } from '../../../utils/config';
import type {
  OrchestratorService,
  StackInfo,
  ServiceInfo,
  ConvergenceResult,
  StackMetadata,
} from '../interface';

export class K3sOrchestratorService implements OrchestratorService {
  private readonly kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;

  constructor(private readonly conn: SSHKeyConnection) {}

  prepareDeployContent(
    stackName: string,
    compose: ParsedCompose,
    config: DockflowConfig,
    env: string,
    _options?: { skipDefaults?: boolean },
  ): string {
    // Inject Traefik labels into compose so K8sManifestService can convert them to IngressRoute
    if (config.proxy?.enabled) {
      ComposeService.injectTraefikLabels(compose, config, stackName, env);
    }
    return K8sManifestService.composeToManifests(stackName, compose, config.proxy, {
      useRegistry: config.registry?.enabled === true,
    });
  }

  private ns(stack: string): string {
    return `${K3S_NAMESPACE_PREFIX}-${stack}`;
  }

  async deployStack(
    stackName: string,
    manifests: string,
    _releasePath: string,
  ): Promise<Result<void, DeployError>> {
    const ns = this.ns(stackName);

    // Ensure namespace exists
    await sshExec(
      this.conn,
      `${this.kube} create namespace ${ns} --dry-run=client -o yaml | ${this.kube} apply -f -`,
    );

    // Label the namespace as dockflow-managed
    await sshExec(
      this.conn,
      `${this.kube} label namespace ${ns} app.kubernetes.io/managed-by=dockflow --overwrite`,
    );

    // Apply manifests via stdin
    const encoded = Buffer.from(manifests).toString('base64');
    const result = await sshExec(
      this.conn,
      `echo '${encoded}' | base64 -d | ${this.kube} apply -n ${ns} -f -`,
    );

    if (result.exitCode !== 0) {
      return err(
        new DeployError(
          `kubectl apply failed: ${result.stderr || result.stdout}`,
          ErrorCode.DEPLOY_FAILED,
        ),
      );
    }

    return ok(undefined);
  }

  async deployAccessory(
    name: string,
    content: string,
    _accessoryPath: string,
    _options?: { force?: boolean },
  ): Promise<Result<{ deployed: boolean }, DeployError>> {
    // Apply the accessory manifest; kubectl apply is idempotent
    const encoded = Buffer.from(content).toString('base64');
    const result = await sshExec(
      this.conn,
      `echo '${encoded}' | base64 -d | ${this.kube} apply -f -`,
    );

    if (result.exitCode !== 0) {
      return err(
        new DeployError(
          `Failed to deploy accessory ${name}: ${result.stderr || result.stdout}`,
          ErrorCode.DEPLOY_FAILED,
        ),
      );
    }

    return ok({ deployed: true });
  }

  async waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    _intervalSeconds: number,
  ): Promise<ConvergenceResult> {
    const ns = this.ns(stackName);

    // Get list of deployments
    const deps = await sshExec(
      this.conn,
      `${this.kube} get deployments -n ${ns} -o jsonpath='{.items[*].metadata.name}'`,
    );

    const deployments = deps.stdout.trim().replace(/^'|'$/g, '').split(' ').filter(Boolean);

    for (const dep of deployments) {
      const r = await sshExec(
        this.conn,
        `${this.kube} rollout status deployment/${dep} -n ${ns} --timeout=${timeoutSeconds}s 2>&1`,
      );

      if (r.exitCode !== 0) {
        return { converged: false, rolledBack: false, timedOut: true };
      }
    }

    return { converged: true, rolledBack: false, timedOut: false };
  }

  async removeStack(stackName: string): Promise<void> {
    await sshExec(
      this.conn,
      `${this.kube} delete namespace ${this.ns(stackName)} --ignore-not-found`,
    );
  }

  async listStacks(): Promise<StackInfo[]> {
    const r = await sshExec(
      this.conn,
      `${this.kube} get namespaces -l app.kubernetes.io/managed-by=dockflow ` +
        `-o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo ""`,
    );

    const names = r.stdout.trim().replace(/^'|'$/g, '').split(' ').filter(Boolean);

    return names.map((n) => ({
      name: n.replace(`${K3S_NAMESPACE_PREFIX}-`, ''),
      services: 0,
    }));
  }

  async getServices(stackName: string): Promise<ServiceInfo[]> {
    const ns = this.ns(stackName);
    const r = await sshExec(
      this.conn,
      `${this.kube} get deployments -n ${ns} -o json 2>/dev/null || echo '{"items":[]}'`,
    );

    try {
      const data = JSON.parse(r.stdout.trim()) as {
        items: Array<{
          metadata: { name: string };
          spec: { replicas?: number; template: { spec: { containers: Array<{ image: string }> } } };
          status: { readyReplicas?: number };
        }>;
      };

      return data.items.map((item) => ({
        name: item.metadata.name,
        image: item.spec.template.spec.containers[0]?.image || '',
        replicas: `${item.status.readyReplicas ?? 0}/${item.spec.replicas ?? 0}`,
        ports: '',
      }));
    } catch {
      return [];
    }
  }

  async scaleService(
    stackName: string,
    service: string,
    replicas: number,
  ): Promise<void> {
    const r = await sshExec(
      this.conn,
      `${this.kube} scale deployment/${service} --replicas=${replicas} -n ${this.ns(stackName)}`,
    );

    if (r.exitCode !== 0) {
      throw new DeployError(
        `Failed to scale ${service}: ${r.stderr || r.stdout}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async rollbackService(stackName: string, service: string): Promise<void> {
    const r = await sshExec(
      this.conn,
      `${this.kube} rollout undo deployment/${service} -n ${this.ns(stackName)}`,
    );

    if (r.exitCode !== 0) {
      throw new DeployError(
        `Failed to rollback ${service}: ${r.stderr || r.stdout}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async prepareInfrastructure(_stackName: string, _compose: ParsedCompose): Promise<void> {
    // k3s: namespaces and PVCs are created via kubectl apply — nothing to do here
  }

  async stackExists(stackName: string): Promise<boolean> {
    const r = await sshExec(
      this.conn,
      `${this.kube} get namespace ${this.ns(stackName)} --no-headers 2>/dev/null | wc -l`,
    );
    return r.exitCode === 0 && parseInt(r.stdout.trim(), 10) > 0;
  }

  async restart(stackName: string, service?: string): Promise<void> {
    const ns = this.ns(stackName);

    if (service) {
      const r = await sshExec(
        this.conn,
        `${this.kube} rollout restart deployment/${service} -n ${ns}`,
      );
      if (r.exitCode !== 0) {
        throw new DeployError(
          r.stderr || `Failed to restart ${service}`,
          ErrorCode.DEPLOY_FAILED,
        );
      }
      return;
    }

    const r = await sshExec(this.conn, `${this.kube} rollout restart deployment -n ${ns}`);
    if (r.exitCode !== 0) {
      throw new DeployError(
        r.stderr || 'Failed to restart stack',
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async getMetadata(stackName: string): Promise<StackMetadata | null> {
    const result = await sshExec(
      this.conn,
      `cat '${DOCKFLOW_STACKS_DIR}/${stackName}/current/metadata.json' 2>/dev/null`,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout.trim()) as StackMetadata;
    } catch {
      return null;
    }
  }
}
