// Distribution isolation (DESIGN-CORE 6.3, D1). Everything distribution-specific reaches the
// Kubernetes code through these two interfaces; nothing outside `kubernetes/k3s/` and
// `commands/setup/k3s/` names a k3s path.

import type { AccessMode, Protocol } from './model/types';

export interface ReservedHostPort {
  port: number;
  protocol: Protocol;
  /** shown in `ports.reserved-host-port`, e.g. `SSH`, `Dockflow Traefik`, `published by app service web` */
  reason: string;
}

/** Pure traits the normalizer and translator may read. */
export interface DistributionTraits {
  name: 'k3s';
  /** k3s: 'dockflow-local' */
  defaultStorageClass: string;
  /**
   * What the default storage class can actually provision (k3s local-path: ReadWriteOnce and
   * ReadWriteOncePod). The ReadWriteMany refusal reads this instead of assuming local-path.
   */
  defaultStorageClassAccessModes: AccessMode[];
  /** k3s: node-role.kubernetes.io/control-plane = 'true' */
  controlPlaneNodeLabel: { key: string; value: string };
  /** LoadBalancer Services get a node port in addition to the host port; k3s ServiceLB: false */
  loadBalancerNodePorts: boolean;
  /** nameservers the cluster DNS policy already occupies; the pod `dns` limit is 3 minus this (k3s: 1) */
  clusterDnsNameservers: number;
  /** image of backup, restore and volume helper pods, never hard-coded in kubernetes/* */
  helperImage: string;
  /** container image store root, for disk usage and `list images --all` */
  imageStoreRoot: string;
  /** true until e2e proves port-less headless Services get DNS records (D9, C9) */
  headlessServiceNeedsPort: boolean;
  /** dummy port used when headlessServiceNeedsPort (k3s: 9/TCP, named `placeholder`) */
  headlessPlaceholderPort: { port: number; protocol: Protocol };
  /**
   * Ports the distribution itself binds on every node, 22/TCP included. The SSH ports of
   * servers.yml, the nginx plugin ports and the sibling role's published ports arrive through
   * TranslateOptions.extraReservedHostPorts, and 80/443 through traefikOnCluster (PD-2).
   */
  reservedHostPorts: ReservedHostPort[];
}

/** Everything distribution-specific the runtime needs. */
export interface K8sDistribution {
  traits: DistributionTraits;
  /** executable prefix for kubectl on a control-plane node, e.g. '/usr/local/bin/k3s kubectl' */
  kubectlCommand: string;
  /** e.g. 'v1.34.0' */
  minimumServerVersion: string;
  /** shell command reading an image tar stream on stdin (run with sudo -n) */
  importImagesCommand(): string;
  /** JSON listings used for dedupe and `list images --all` */
  listImagesCommands(): { byConfigDigest: string; byTargetDigest: string };
  removeImagesCommand(refs: string[]): string;
  /**
   * Commands (each run with sudo -n, in order) giving an image the node already holds a second
   * name, pinned like an import: an identical rebuild under a new version then travels nowhere.
   */
  tagImageCommands(source: string, target: string): string[];
  pruneImagesCommand(): string;
  /** directory where the distribution stores local volumes (VolumeInfo.hostPath) */
  localVolumeRoot: string;
}
