/**
 * Swarm naming (DESIGN-CORE 6.1 `StackNaming`): one stack per role, `<project>-<env>` for the
 * application and `<project>-<env>-accessories` for accessories, services named `<stack>_<svc>`.
 */

import type { StackNaming, StackRef } from '../interfaces';

export const SWARM_ACCESSORIES_SUFFIX = '-accessories';

/** Stack name of a role: `shop-production`, `shop-production-accessories`. */
export function swarmScope(ref: Pick<StackRef, 'project' | 'env' | 'role'>): string {
  const stack = `${ref.project}-${ref.env}`;
  return ref.role === 'accessory' ? `${stack}${SWARM_ACCESSORIES_SUFFIX}` : stack;
}

/** Docker's own name of a stack service: `<stack>_<svc>`. */
export function swarmServiceName(scope: string, composeService: string): string {
  return `${scope}_${composeService}`;
}

export const swarmNaming: StackNaming = {
  scope: swarmScope,
  describe: (ref) => `stack ${swarmScope(ref)}`,
  serviceNativeName: (ref, composeService) => swarmServiceName(swarmScope(ref), composeService),
};
