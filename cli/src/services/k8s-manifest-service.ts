import { stringify } from 'yaml';
import type { ParsedCompose } from './compose-service';
import type { ProxyConfig } from '../utils/config';
import { K3S_NAMESPACE_PREFIX } from '../constants';

interface K8sResource {
  apiVersion: string;
  kind: string;
  metadata: Record<string, unknown>;
  spec: Record<string, unknown>;
}

interface TraefikLabels {
  rule?: string;
  tls?: boolean;
  port?: number;
  entrypoints?: string;
}

const MANAGED_BY_LABELS = {
  'app.kubernetes.io/managed-by': 'dockflow',
};

/**
 * Converts a parsed Docker Compose file into Kubernetes manifests (YAML multi-document).
 * Each compose service becomes a Deployment + ClusterIP Service.
 * Named volumes become PVCs, Traefik labels become IngressRoute CRDs.
 */
export class K8sManifestService {
  /**
   * Main entry point: takes a parsed compose and returns a multi-document YAML string
   * with all Kubernetes resources separated by `---`.
   */
  static composeToManifests(
    stackName: string,
    compose: ParsedCompose,
    proxyConfig?: ProxyConfig,
  ): string {
    const namespace = `${K3S_NAMESPACE_PREFIX}-${stackName}`;
    const resources: K8sResource[] = [];

    // Namespace
    resources.push(K8sManifestService.createNamespace(namespace, stackName));

    // PVCs for named volumes
    if (compose.volumes) {
      for (const volumeName of Object.keys(compose.volumes)) {
        resources.push(K8sManifestService.createPVC(volumeName, namespace, stackName));
      }
    }

    // Per-service resources
    for (const [serviceName, serviceConfig] of Object.entries(compose.services)) {
      const config = serviceConfig as Record<string, unknown>;
      const deployment = K8sManifestService.createDeployment(serviceName, config, namespace, stackName, compose.volumes);
      resources.push(deployment);

      const ports = K8sManifestService.extractPorts(config);
      if (ports.length > 0) {
        resources.push(K8sManifestService.createService(serviceName, ports, namespace, stackName));
      }

      // IngressRoute from Traefik labels
      const traefikLabels = K8sManifestService.extractTraefikLabels(serviceName, config);
      if (traefikLabels.rule) {
        const ingressPort = traefikLabels.port ?? (ports.length > 0 ? ports[0].containerPort : 80);
        resources.push(
          K8sManifestService.createIngressRoute(
            serviceName,
            traefikLabels,
            ingressPort,
            namespace,
            stackName,
            proxyConfig,
          ),
        );
      }
    }

    return resources
      .map((r) => stringify(r, { lineWidth: 0 }))
      .join('\n---\n');
  }

  private static createNamespace(namespace: string, stackName: string): K8sResource {
    return {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: {
          ...MANAGED_BY_LABELS,
          'app.kubernetes.io/part-of': stackName,
        },
      },
      spec: {},
    };
  }

  private static createPVC(name: string, namespace: string, stackName: string): K8sResource {
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name,
        namespace,
        labels: {
          ...MANAGED_BY_LABELS,
          'app.kubernetes.io/part-of': stackName,
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: '1Gi',
          },
        },
      },
    };
  }

  private static createDeployment(
    serviceName: string,
    config: Record<string, unknown>,
    namespace: string,
    stackName: string,
    composeVolumes?: Record<string, unknown>,
  ): K8sResource {
    const deploy = (config.deploy ?? {}) as Record<string, unknown>;
    const replicas = (deploy.replicas as number) ?? 1;
    const image = (config.image as string) ?? serviceName;
    const environment = config.environment as Record<string, string> | string[] | undefined;
    const volumes = config.volumes as string[] | undefined;

    const container: Record<string, unknown> = {
      name: serviceName,
      image,
      imagePullPolicy: 'Never',
    };

    // Environment variables
    const envVars = K8sManifestService.convertEnvironment(environment);
    if (envVars.length > 0) {
      container.env = envVars;
    }

    // Ports
    const ports = K8sManifestService.extractPorts(config);
    if (ports.length > 0) {
      container.ports = ports.map((p) => ({ containerPort: p.containerPort }));
    }

    // Volume mounts & pod volumes
    const { volumeMounts, podVolumes } = K8sManifestService.convertVolumes(volumes, composeVolumes);
    if (volumeMounts.length > 0) {
      container.volumeMounts = volumeMounts;
    }

    // Node selector from placement constraints
    const nodeSelector = K8sManifestService.convertPlacementConstraints(deploy);

    const podSpec: Record<string, unknown> = {
      containers: [container],
    };
    if (podVolumes.length > 0) {
      podSpec.volumes = podVolumes;
    }
    if (Object.keys(nodeSelector).length > 0) {
      podSpec.nodeSelector = nodeSelector;
    }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: serviceName,
        namespace,
        labels: {
          ...MANAGED_BY_LABELS,
          'app.kubernetes.io/part-of': stackName,
        },
      },
      spec: {
        replicas,
        selector: {
          matchLabels: { app: serviceName },
        },
        template: {
          metadata: {
            labels: { app: serviceName },
          },
          spec: podSpec,
        },
      },
    };
  }

  private static createService(
    serviceName: string,
    ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>,
    namespace: string,
    stackName: string,
  ): K8sResource {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace,
        labels: {
          ...MANAGED_BY_LABELS,
          'app.kubernetes.io/part-of': stackName,
        },
      },
      spec: {
        selector: { app: serviceName },
        ports: ports.map((p, i) => ({
          name: `port-${i}`,
          port: p.containerPort,
          targetPort: p.containerPort,
          protocol: (p.protocol ?? 'tcp').toUpperCase(),
        })),
      },
    };
  }

  private static createIngressRoute(
    serviceName: string,
    traefikLabels: TraefikLabels,
    port: number,
    namespace: string,
    stackName: string,
    proxyConfig?: ProxyConfig,
  ): K8sResource {
    const route: Record<string, unknown> = {
      match: traefikLabels.rule!,
      kind: 'Rule',
      services: [{ name: serviceName, port }],
    };

    const spec: Record<string, unknown> = {
      entryPoints: traefikLabels.entrypoints
        ? traefikLabels.entrypoints.split(',').map((ep) => ep.trim())
        : ['websecure'],
      routes: [route],
    };

    // TLS with Let's Encrypt if ACME is enabled
    if (traefikLabels.tls || proxyConfig?.acme) {
      spec.tls = proxyConfig?.acme ? { certResolver: 'letsencrypt' } : {};
    }

    return {
      apiVersion: 'traefik.containo.us/v1alpha1',
      kind: 'IngressRoute',
      metadata: {
        name: serviceName,
        namespace,
        labels: {
          ...MANAGED_BY_LABELS,
          'app.kubernetes.io/part-of': stackName,
        },
      },
      spec,
    };
  }

  /**
   * Convert Docker Compose environment to K8s env array.
   * Supports both object format { KEY: value } and array format ["KEY=value"].
   */
  private static convertEnvironment(
    environment: Record<string, string> | string[] | undefined,
  ): Array<{ name: string; value: string }> {
    if (!environment) return [];

    if (Array.isArray(environment)) {
      return environment.map((entry) => {
        const eqIdx = entry.indexOf('=');
        if (eqIdx === -1) return { name: entry, value: '' };
        return { name: entry.slice(0, eqIdx), value: entry.slice(eqIdx + 1) };
      });
    }

    return Object.entries(environment).map(([name, value]) => ({
      name,
      value: String(value ?? ''),
    }));
  }

  /**
   * Extract container ports from compose service config.
   * Handles formats: "3000", "3000:3000", "8080:3000", "0.0.0.0:8080:3000", "3000/udp"
   */
  private static extractPorts(
    config: Record<string, unknown>,
  ): Array<{ containerPort: number; hostPort?: number; protocol?: string }> {
    const ports = config.ports as Array<string | number | Record<string, unknown>> | undefined;
    if (!ports) return [];

    return ports.map((p) => {
      if (typeof p === 'number') {
        return { containerPort: p };
      }
      if (typeof p === 'object' && p !== null) {
        return {
          containerPort: (p as Record<string, unknown>).target as number,
          hostPort: (p as Record<string, unknown>).published as number | undefined,
          protocol: (p as Record<string, unknown>).protocol as string | undefined,
        };
      }
      // String format
      const str = String(p);
      const [portPart, protocol] = str.split('/');
      const segments = portPart.split(':');
      if (segments.length === 1) {
        return { containerPort: parseInt(segments[0], 10), protocol };
      }
      if (segments.length === 2) {
        return {
          containerPort: parseInt(segments[1], 10),
          hostPort: parseInt(segments[0], 10),
          protocol,
        };
      }
      // ip:host:container
      return {
        containerPort: parseInt(segments[2], 10),
        hostPort: parseInt(segments[1], 10),
        protocol,
      };
    });
  }

  /**
   * Convert compose volume mounts to K8s volumeMounts + pod volumes.
   * Named volumes → PVC references, bind mounts → hostPath.
   */
  private static convertVolumes(
    volumes: string[] | undefined,
    composeVolumes?: Record<string, unknown>,
  ): { volumeMounts: Array<Record<string, unknown>>; podVolumes: Array<Record<string, unknown>> } {
    if (!volumes) return { volumeMounts: [], podVolumes: [] };

    const volumeMounts: Array<Record<string, unknown>> = [];
    const podVolumes: Array<Record<string, unknown>> = [];
    const namedVolumeKeys = composeVolumes ? new Set(Object.keys(composeVolumes)) : new Set<string>();

    for (const vol of volumes) {
      const parts = vol.split(':');
      if (parts.length < 2) continue;

      const source = parts[0];
      const mountPath = parts[1];
      // Sanitize name: replace non-alphanumeric with dashes
      const volName = source.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'vol';

      volumeMounts.push({ name: volName, mountPath });

      if (namedVolumeKeys.has(source)) {
        // Named volume → PVC
        podVolumes.push({
          name: volName,
          persistentVolumeClaim: { claimName: source },
        });
      } else {
        // Bind mount → hostPath
        podVolumes.push({
          name: volName,
          hostPath: { path: source, type: 'DirectoryOrCreate' },
        });
      }
    }

    return { volumeMounts, podVolumes };
  }

  /**
   * Convert Docker Swarm placement constraints to K8s nodeSelector.
   * "node.role == manager"   → { "node-role.kubernetes.io/master": "" }
   * "node.role == worker"    → {} (default scheduler)
   * "node.hostname == X"     → { "kubernetes.io/hostname": "X" }
   */
  private static convertPlacementConstraints(
    deploy: Record<string, unknown>,
  ): Record<string, string> {
    const placement = deploy.placement as Record<string, unknown> | undefined;
    if (!placement) return {};

    const constraints = placement.constraints as string[] | undefined;
    if (!constraints) return {};

    const nodeSelector: Record<string, string> = {};

    for (const constraint of constraints) {
      const match = constraint.match(/^(\S+)\s*==\s*(.+)$/);
      if (!match) continue;

      const [, key, value] = match;
      const trimmedValue = value.trim();

      if (key === 'node.role' && trimmedValue === 'manager') {
        nodeSelector['node-role.kubernetes.io/master'] = '';
      } else if (key === 'node.hostname') {
        nodeSelector['kubernetes.io/hostname'] = trimmedValue;
      }
      // node.role == worker → no constraint needed
    }

    return nodeSelector;
  }

  /**
   * Extract Traefik Docker labels from a compose service and convert to structured data.
   * Looks for: traefik.http.routers.{name}.rule, .tls, .entrypoints
   *            traefik.http.services.{name}.loadbalancer.server.port
   */
  private static extractTraefikLabels(
    serviceName: string,
    config: Record<string, unknown>,
  ): TraefikLabels {
    const labels = config.labels as Record<string, string> | string[] | undefined;
    if (!labels) return {};

    // Normalize labels to key-value map
    const labelMap: Record<string, string> = {};
    if (Array.isArray(labels)) {
      for (const label of labels) {
        const eqIdx = label.indexOf('=');
        if (eqIdx !== -1) {
          labelMap[label.slice(0, eqIdx)] = label.slice(eqIdx + 1);
        }
      }
    } else {
      Object.assign(labelMap, labels);
    }

    const result: TraefikLabels = {};

    // Find the router name — could be any name, not necessarily the service name
    for (const [key, value] of Object.entries(labelMap)) {
      const ruleMatch = key.match(/^traefik\.http\.routers\.([^.]+)\.rule$/);
      if (ruleMatch) {
        result.rule = value;
      }

      const tlsMatch = key.match(/^traefik\.http\.routers\.([^.]+)\.tls$/);
      if (tlsMatch) {
        result.tls = value === 'true';
      }

      const entrypointsMatch = key.match(/^traefik\.http\.routers\.([^.]+)\.entrypoints$/);
      if (entrypointsMatch) {
        result.entrypoints = value;
      }

      const portMatch = key.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/);
      if (portMatch) {
        result.port = parseInt(value, 10);
      }
    }

    return result;
  }
}
