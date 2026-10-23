/**
 * Compose deploy defaults — the Swarm update/rollback/restart settings injected into services,
 * and the removal of the build sections once images are built.
 */

import type { ParsedCompose } from './types';

const DEFAULT_UPDATE_CONFIG: Record<string, unknown> = {
  parallelism: 1,
  delay: '10s',
  failure_action: 'rollback',
  monitor: '30s',
  max_failure_ratio: 0,
  order: 'start-first',
};

const DEFAULT_ROLLBACK_CONFIG: Record<string, unknown> = {
  parallelism: 1,
  delay: '5s',
  monitor: '15s',
  order: 'start-first',
};

const DEFAULT_RESTART_POLICY: Record<string, unknown> = {
  condition: 'on-failure',
  delay: '5s',
  max_attempts: 3,
};

/**
 * Deep merge `source` into `target`.
 * Source values win at leaf level (scalars, arrays).
 * Objects are merged recursively.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/** Swarm modes that run one task per node: `replicas` contradicts them. */
const PER_NODE_MODES = new Set(['global', 'global-job']);

/**
 * Inject Swarm deploy defaults (update_config + rollback_config) into all services.
 * User-provided values take precedence via deep merge.
 */
/**
 * Drop `build` from every service.
 *
 * Dockflow reads that section to know what to build, but `docker stack deploy` cannot build
 * anything and prints "Ignoring unsupported options: build" on every deployment. Removing it
 * once the image is built keeps that noise out of the output.
 */
export function stripBuildSections(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    if (!('build' in svc)) continue;

    const { build: _build, ...rest } = svc as Record<string, unknown>;
    compose.services[name] = rest as typeof svc;
  }
}

export function injectSwarmDefaults(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    const userDeploy = (svc.deploy ?? {}) as Record<string, unknown>;

    const mergedUpdate = deepMerge(
      DEFAULT_UPDATE_CONFIG,
      (userDeploy.update_config ?? {}) as Record<string, unknown>,
    );
    const mergedRollback = deepMerge(
      DEFAULT_ROLLBACK_CONFIG,
      (userDeploy.rollback_config ?? {}) as Record<string, unknown>,
    );

    const mergedDeploy = {
      ...userDeploy,
      update_config: mergedUpdate,
      rollback_config: mergedRollback,
    };

    compose.services[name] = { ...svc, deploy: mergedDeploy };
  }

  compose.raw.services = compose.services;
}

/**
 * Inject accessories-specific deploy config (restart_policy only).
 * User values take precedence.
 */
export function injectAccessoriesDefaults(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
    const userRestart = (deploy.restart_policy ?? {}) as Record<string, unknown>;

    const mergedRestart = deepMerge(DEFAULT_RESTART_POLICY, userRestart);

    const mergedDeploy: Record<string, unknown> = { ...deploy, restart_policy: mergedRestart };
    // docker refuses replicas on a service that runs once per node, and `scale` already says how many
    const perNode = typeof deploy.mode === 'string' && PER_NODE_MODES.has(deploy.mode);
    if (deploy.replicas == null && svc.scale == null && !perNode) mergedDeploy.replicas = 1;

    compose.services[name] = { ...svc, deploy: mergedDeploy };
  }

  compose.raw.services = compose.services;
}
