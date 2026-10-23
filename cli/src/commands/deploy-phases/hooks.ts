/**
 * The hooks of a deploy: they receive the stack, the environment and the version it deploys.
 */

import * as Hook from '../../services/hook';
import type { DeployContext } from '../deploy-context';

export function runDeployHook(ctx: DeployContext, phase: Hook.HookPhase, env: Record<string, string> = {}): Promise<void> {
  return Hook.runHook(phase, ctx.projectRoot, ctx.config, ctx.rendered, { connection: ctx.cluster.manager.connection, stackName: ctx.stackName }, {
    env: { DOCKFLOW_STACK: ctx.stackName, DOCKFLOW_ENV: ctx.env, DOCKFLOW_VERSION: ctx.deployVersion, ...env },
  });
}
