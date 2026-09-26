// The k3s distribution (DESIGN-CORE 6.3, D1): the traits the pure pipeline reads and the commands
// the runtime runs on nodes. With commands/setup/k3s, the only code that names k3s paths.

import { DeployError } from '../../../../utils/errors';
import { K8S_IMPORTED_IMAGE_REGISTRY, K8S_STORAGE_CLASS } from '../constants';
import type { K8sDistribution, ReservedHostPort } from '../distribution';
import { K3S_BINARY_PATH, K3S_IMAGE_COMMANDS } from './sudoers';
import { K3S_PIN } from './versions';

export { K3S_BINARY_PATH } from './sudoers';

export const K3S_KUBECTL_COMMAND = `${K3S_BINARY_PATH} kubectl`;
const K3S_DATA_ROOT = '/var/lib/rancher/k3s';
/** where local-path creates volume directories */
const K3S_LOCAL_VOLUME_ROOT = `${K3S_DATA_ROOT}/storage`;
const K3S_IMAGE_STORE_ROOT = `${K3S_DATA_ROOT}/agent/containerd`;
/** the helper image local-path itself uses, part of the k3s image set */
const K3S_HELPER_IMAGE = 'rancher/mirrored-library-busybox:1.37.0';

/**
 * Ports k3s binds on the nodes. The servers.yml SSH ports and nginx plugin ports arrive through
 * `extraReservedHostPorts`, 80/443 of a Dockflow-owned Traefik through `traefikOnCluster` (PD-2).
 */
const K3S_RESERVED_HOST_PORTS: ReservedHostPort[] = [
  { port: 22, protocol: 'TCP', reason: 'SSH' },
  { port: 6443, protocol: 'TCP', reason: 'Kubernetes API' },
  { port: 10250, protocol: 'TCP', reason: 'kubelet' },
  { port: 2379, protocol: 'TCP', reason: 'etcd client' },
  { port: 2380, protocol: 'TCP', reason: 'etcd peer' },
  { port: 8472, protocol: 'UDP', reason: 'flannel VXLAN' },
  { port: 51820, protocol: 'UDP', reason: 'flannel WireGuard' },
  { port: 51821, protocol: 'UDP', reason: 'flannel WireGuard IPv6' },
  { port: 5001, protocol: 'TCP', reason: 'k3s embedded registry' },
];

const IMPORTED_PREFIX = `${K8S_IMPORTED_IMAGE_REGISTRY}/`;
// Reference grammar after the prefix; it leaves no character a shell or ctr would interpret.
const IMPORTED_REST = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

function isImportedRef(ref: string): boolean {
  return ref.startsWith(IMPORTED_PREFIX) && IMPORTED_REST.test(ref.slice(IMPORTED_PREFIX.length));
}

/**
 * Removes images Dockflow imported, and nothing else: the sudoers rule allows any argument to
 * `ctr images rm`, so this is where the `dockflow.invalid/` restriction lives (DV5).
 */
function removeImagesCommand(refs: string[]): string {
  if (refs.length === 0) {
    throw new DeployError('Image removal was called without any image reference');
  }
  const foreign = refs.find((ref) => !isImportedRef(ref));
  if (foreign !== undefined) {
    throw new DeployError(
      `Image ${JSON.stringify(foreign)} is not an image Dockflow imported (${IMPORTED_PREFIX}), so Dockflow does not remove it`,
    );
  }
  // The grammar above excludes quotes, so single quotes make every reference one inert word.
  return [K3S_IMAGE_COMMANDS.remove, ...refs.map((ref) => `'${ref}'`)].join(' ');
}

export const k3sDistribution: K8sDistribution = {
  traits: {
    name: 'k3s',
    defaultStorageClass: K8S_STORAGE_CLASS,
    defaultStorageClassAccessModes: ['ReadWriteOnce', 'ReadWriteOncePod'],
    controlPlaneNodeLabel: { key: 'node-role.kubernetes.io/control-plane', value: 'true' },
    loadBalancerNodePorts: false,
    clusterDnsNameservers: 1,
    helperImage: K3S_HELPER_IMAGE,
    imageStoreRoot: K3S_IMAGE_STORE_ROOT,
    // e2e E-33 on the pinned k3s: a port-less headless Service gets its EndpointSlices and A records
    headlessServiceNeedsPort: false,
    headlessPlaceholderPort: { port: 9, protocol: 'TCP' },
    reservedHostPorts: K3S_RESERVED_HOST_PORTS,
  },
  kubectlCommand: K3S_KUBECTL_COMMAND,
  minimumServerVersion: K3S_PIN.minimumServerVersion,
  importImagesCommand: () => K3S_IMAGE_COMMANDS.import,
  listImagesCommands: () => ({
    byConfigDigest: K3S_IMAGE_COMMANDS.listByConfigDigest,
    byTargetDigest: K3S_IMAGE_COMMANDS.listByTargetDigest,
  }),
  removeImagesCommand,
  pruneImagesCommand: () => K3S_IMAGE_COMMANDS.prune,
  localVolumeRoot: K3S_LOCAL_VOLUME_ROOT,
};
