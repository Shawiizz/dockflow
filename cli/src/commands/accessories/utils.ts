/**
 * Shared helper for accessories commands (design-06 3.16). `restart`, `stop` and `remove` act on the
 * whole accessory role when no service is named, so they check the role is deployed up front instead
 * of sending an empty or confusing request to the backend; `list`, `logs` and `exec` degrade on their
 * own (an empty service list, or `resolveService`'s own not-found message) and do not call this.
 */

import type { ServiceInfo } from '../../services/orchestrator/interfaces';
import { CLIError, ErrorCode } from '../../utils/errors';
import type { Day2Context } from '../shared/day2';

export function accessoriesNotDeployed(env: string): CLIError {
  return new CLIError('Accessories not deployed yet', ErrorCode.STACK_NOT_FOUND, `Deploy them with: \`dockflow deploy ${env} --accessories\`.`);
}

/** `exists(accessoryRef)` or `STACK_NOT_FOUND` (today's text); returns the accessory services when deployed. */
export async function requireAccessories(ctx: Day2Context): Promise<ServiceInfo[]> {
  const deployed = await ctx.orchestrator.stack.exists(ctx.accessoryRef);
  if (!deployed) throw accessoriesNotDeployed(ctx.env);
  return ctx.orchestrator.stack.getServices(ctx.accessoryRef);
}
