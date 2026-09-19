// The setup-owned `dockflow-local` StorageClass (design-05 11.1) and the patch that takes the
// default annotation away from another class (design-05 11.2, C18). Provisioner, reclaim policy
// and binding mode are immutable once the class exists.

import { K8S_MANAGED_BY, K8S_STORAGE_CLASS, KUBE_KEYS, LABELS, PARTS } from '../constants';
import type { StorageClass } from '../resources/storage';

export const LOCAL_PATH_PROVISIONER = 'rancher.io/local-path';

/** A fresh object on every call: callers may serialise or compare it, never share it. */
export function dockflowStorageClass(): StorageClass {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: K8S_STORAGE_CLASS,
      labels: {
        [LABELS.managedBy]: K8S_MANAGED_BY,
        [LABELS.part]: PARTS.system,
      },
      annotations: {
        // what k3s's own local-path class carries
        defaultVolumeType: 'local',
        [KUBE_KEYS.defaultStorageClass]: 'true',
      },
    },
    provisioner: LOCAL_PATH_PROVISIONER,
    // D7: deleting a claim leaves a Released volume and its data
    reclaimPolicy: 'Retain',
    volumeBindingMode: 'WaitForFirstConsumer',
  };
}

/** JSON merge patch body that takes the default annotation away from a class. */
export function nonDefaultStorageClassPatch(): {
  metadata: { annotations: Record<string, string> };
} {
  return { metadata: { annotations: { [KUBE_KEYS.defaultStorageClass]: 'false' } } };
}
