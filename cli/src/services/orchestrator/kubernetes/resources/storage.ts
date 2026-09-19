// storage.k8s.io/v1 StorageClass: the setup-owned `dockflow-local` class and the default-class
// check (design-05 11). Provisioner, reclaim policy and binding mode are immutable.

import type { KubeObjectBase } from './meta';

export interface StorageClass extends KubeObjectBase<'storage.k8s.io/v1', 'StorageClass'> {
  provisioner: string;
  reclaimPolicy?: 'Retain' | 'Delete';
  volumeBindingMode?: 'Immediate' | 'WaitForFirstConsumer';
  /** read side only (K06): whether a standalone PVC bound to this class may grow (design-03 5.4.2) */
  allowVolumeExpansion?: boolean;
}
