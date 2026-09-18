// coordination.k8s.io/v1 Lease: the deploy lock and the proxy lock in dockflow-system
// (DESIGN-CORE 6.7, design-03 14.1). The LockData JSON lives in the `P/lock` annotation.

import type { KubeObjectBase } from './meta';

export interface LeaseSpec {
  holderIdentity?: string;
  leaseDurationSeconds?: number;
  /** MicroTime: RFC3339 with exactly six fractional digits */
  acquireTime?: string;
  /** MicroTime */
  renewTime?: string;
  leaseTransitions?: number;
}

export interface Lease extends KubeObjectBase<'coordination.k8s.io/v1', 'Lease'> {
  spec?: LeaseSpec;
}
