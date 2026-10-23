/**
 * The stack the deploy sends for the app: the compose with the image tags of this deploy, and the
 * input shared by the deploy and the dry-run render.
 */

import * as Compose from '../../services/compose';
import type { ParsedCompose } from '../../services/compose';
import type { StackDeployInput } from '../../services/swarm/types';
import type { DeployContext } from '../deploy-context';

/** The project's compose with the image tags of this deploy. */
export function composeWithImageTags(ctx: DeployContext): ParsedCompose {
  const compose = Compose.loadFromString(ctx.composeContent, 'docker-compose.yml');
  Compose.updateImageTags(compose, ctx.config, ctx.env, ctx.deployVersion, ctx.options.only);
  return compose;
}

/**
 * Under --only, the services left alone keep the image tags of the running release, so the
 * deploy and the release file reflect what runs. Without a release, the compose is unchanged.
 */
export async function keepRunningImageTags(ctx: DeployContext, compose: ParsedCompose): Promise<ParsedCompose> {
  if (!ctx.options.only) return compose;
  const currentContent = await ctx.releases.getCurrentComposeContent(ctx.stackName);
  if (!currentContent) return compose;
  const filter = ctx.options.only.split(',').map((s: string) => s.trim());
  return Compose.syncNonTargetedImageTags(compose, Compose.loadFromString(currentContent), filter);
}

/** What the stack deploy sends for the app: the one input the deploy and the dry-run render share. */
export function appStackInput(ctx: DeployContext, compose: ParsedCompose): StackDeployInput {
  return {
    stackName: ctx.stackName,
    env: ctx.env,
    compose,
    proxy: ctx.config.proxy,
    servicesFilter: ctx.options.only ? ctx.options.only.split(',').map((s: string) => s.trim()) : undefined,
  };
}
