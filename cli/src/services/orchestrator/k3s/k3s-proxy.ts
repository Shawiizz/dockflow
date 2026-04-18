import type { SSHKeyConnection } from '../../../types';
import type { ProxyConfig } from '../../../utils/config';
import { K3S_DOCKFLOW_KUBECONFIG, K3S_TRAEFIK_NAMESPACE } from '../../../constants';
import { sshExec } from '../../../utils/ssh';
import { printDebug, printInfo, printSuccess } from '../../../utils/output';
import { stringify } from 'yaml';
import type { TraefikBackend } from '../interfaces';

/**
 * Manages the Traefik instance embedded in k3s.
 * k3s ships Traefik as a Helm chart in kube-system — this service configures
 * Let's Encrypt via HelmChartConfig when proxy.acme is enabled.
 */
export class K3sTraefikBackend implements TraefikBackend {
  private readonly kube: string;

  constructor(private readonly connection: SSHKeyConnection) {
    this.kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;
  }

  /**
   * Ensure Traefik is running and configured in kube-system.
   * If proxy.acme is enabled, applies a HelmChartConfig for Let's Encrypt.
   * Idempotent: skips if already configured.
   */
  async ensureRunning(proxyConfig: ProxyConfig): Promise<void> {
    // Check Traefik is running in kube-system
    const check = await sshExec(this.connection,
      `${this.kube} get deployment traefik -n ${K3S_TRAEFIK_NAMESPACE} -o jsonpath='{.status.readyReplicas}'`,
    );

    if (check.exitCode !== 0) {
      printInfo('Traefik not found in kube-system — waiting for k3s to deploy it...');
      await this.waitForTraefik();
    } else {
      printDebug(`Traefik running in kube-system (replicas: ${check.stdout.trim() || '0'})`);
    }

    // Apply ACME config if enabled
    if (proxyConfig.acme && proxyConfig.email) {
      await this.applyAcmeConfig(proxyConfig.email);
    }
  }

  /**
   * Wait for k3s to deploy Traefik (it auto-deploys on cluster init).
   */
  private async waitForTraefik(): Promise<void> {
    const maxAttempts = 30;
    const intervalMs = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      const result = await sshExec(this.connection,
        `${this.kube} get deployment traefik -n ${K3S_TRAEFIK_NAMESPACE} --no-headers 2>/dev/null`,
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        printSuccess('Traefik deployment found in kube-system');
        return;
      }
      await Bun.sleep(intervalMs);
    }

    printInfo('Traefik deployment not found after waiting — it may appear later');
  }

  /**
   * Apply a HelmChartConfig to configure Let's Encrypt on the k3s-embedded Traefik.
   * This is idempotent — kubectl apply will update if already present.
   */
  private async applyAcmeConfig(email: string): Promise<void> {
    printDebug('Applying Traefik ACME configuration via HelmChartConfig...');

    const helmChartConfig = K3sTraefikBackend.generateHelmChartConfig(email);
    const escaped = helmChartConfig.replace(/'/g, "'\\''");

    const result = await sshExec(this.connection,
      `echo '${escaped}' | ${this.kube} apply -f -`,
    );

    if (result.exitCode !== 0) {
      printDebug(`HelmChartConfig apply stderr: ${result.stderr}`);
      throw new Error(`Failed to apply Traefik HelmChartConfig: ${result.stderr}`);
    }

    // Restart Traefik to pick up the new config
    const restart = await sshExec(this.connection,
      `${this.kube} rollout restart deployment/traefik -n ${K3S_TRAEFIK_NAMESPACE}`,
    );

    if (restart.exitCode === 0) {
      printSuccess('Traefik ACME configuration applied');
    } else {
      printDebug(`Traefik restart stderr: ${restart.stderr}`);
    }
  }

  /**
   * Generate the HelmChartConfig YAML that configures Let's Encrypt on k3s Traefik.
   */
  static generateHelmChartConfig(email: string): string {
    const config = {
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChartConfig',
      metadata: {
        name: 'traefik',
        namespace: K3S_TRAEFIK_NAMESPACE,
      },
      spec: {
        valuesContent: [
          'persistence:',
          '  enabled: true',
          '  size: 128Mi',
          'additionalArguments:',
          `  - "--certificatesresolvers.letsencrypt.acme.email=${email}"`,
          '  - "--certificatesresolvers.letsencrypt.acme.storage=/data/acme.json"',
          '  - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"',
        ].join('\n'),
      },
    };

    return stringify(config, { lineWidth: 0 });
  }
}
