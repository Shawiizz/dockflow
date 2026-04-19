/**
 * k3s stack backend.
 *
 * Implements StackBackend via SSH + kubectl. All operations target the k3s
 * cluster through the dockflow kubeconfig installed by `dockflow setup`.
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
import * as K8sManifest from '../../k8s-manifest';
import * as Compose from '../../compose';
import type {
  StackBackend,
  StackInfo,
  ServiceInfo,
  ConvergenceResult,
  StackMetadata,
  StackDeployInput,
  AccessoryDeployInput,
  InternalHealthResult,
} from '../interfaces';

export class K3sStackBackend implements StackBackend {
  private readonly kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;

  constructor(private readonly conn: SSHKeyConnection) {}

  private ns(stack: string): string {
    return `${K3S_NAMESPACE_PREFIX}-${stack}`;
  }

  async deploy(input: StackDeployInput): Promise<Result<void, DeployError>> {
    try {
      // Inject Traefik labels so K8sManifest can convert them to IngressRoute
      if (input.proxy?.enabled) {
        Compose.injectTraefikLabels(input.compose, input.proxy, input.stackName, input.env);
      }
      const manifests = K8sManifest.composeToManifests(
        input.stackName,
        input.compose,
        input.proxy,
        { useRegistry: input.useRegistry === true },
      );
      return await this.applyManifests(input.stackName, manifests);
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async deployAccessory(input: AccessoryDeployInput): Promise<Result<{ deployed: boolean }, DeployError>> {
    try {
      const manifests = K8sManifest.composeToManifests(
        input.stackName,
        input.compose,
        input.proxy,
        { useRegistry: input.useRegistry === true },
      );
      const encoded = Buffer.from(manifests).toString('base64');
      const result = await sshExec(
        this.conn,
        `echo '${encoded}' | base64 -d | ${this.kube} apply -f -`,
      );
      if (result.exitCode !== 0) {
        return err(
          new DeployError(
            `Failed to deploy accessories: ${result.stderr || result.stdout}`,
            ErrorCode.DEPLOY_FAILED,
          ),
        );
      }
      return ok({ deployed: true });
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async redeploy(stackName: string, rawContent: string): Promise<Result<void, DeployError>> {
    return this.applyManifests(stackName, rawContent);
  }

  private async applyManifests(stackName: string, manifests: string): Promise<Result<void, DeployError>> {
    const ns = this.ns(stackName);

    await sshExec(
      this.conn,
      `${this.kube} create namespace ${ns} --dry-run=client -o yaml | ${this.kube} apply -f -`,
    );
    await sshExec(
      this.conn,
      `${this.kube} label namespace ${ns} app.kubernetes.io/managed-by=dockflow --overwrite`,
    );

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

  async waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    _intervalSeconds: number,
  ): Promise<ConvergenceResult> {
    const ns = this.ns(stackName);

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

  async checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult> {
    const ns = this.ns(stackName);
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      // CrashLoopBackOff → immediate failure
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

  async scaleService(stackName: string, service: string, replicas: number): Promise<void> {
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

function toDeployError(e: unknown): DeployError {
  if (e instanceof DeployError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new DeployError(msg, ErrorCode.DEPLOY_FAILED);
}
