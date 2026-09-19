// The translator entry point (design-02 1.1): CanonicalStack -> Kubernetes objects. The modules
// never import each other (only pod.ts imports probes.ts); this file composes them and hands one
// module's result to the next: the env Secret to the pod template, the StatefulSet claim templates
// of storage.ts to the workload. The sink is options.sink, the one render() created and already
// passed to the normalizer (DESIGN-CORE 8.2); the translator never creates one and never reads
// what the normalizer reported.
// Pure (T2): no clock, no randomness, no environment.

import type { CanonicalStack } from '../model/types';
import type { ManifestObject } from '../resources/registry';
import { buildEnvSecret, buildFileObjects } from './config-objects';
import { createContext, type TranslateOptions, type TranslateResult, translatorBug } from './context';
import { buildIngress } from './ingress';
import { buildPodTemplate } from './pod';
import { buildServices, checkPublishedPorts } from './services';
import { buildClaims, buildClaimTemplates } from './storage';
import { buildWorkload } from './workloads';

export type { TranslateOptions, TranslateResult } from './context';
export { TRANSLATOR_CODES, TRANSLATOR_CODES as TRANSLATE_CODES } from './diagnostics';

export function translateStack(stack: CanonicalStack, options: TranslateOptions): TranslateResult {
  const ctx = createContext(stack, options);
  const objects: ManifestObject[] = [];

  objects.push(...buildFileObjects(ctx));
  objects.push(...buildClaims(ctx));
  checkPublishedPorts(ctx);

  for (const svc of stack.services) {
    const env = buildEnvSecret(svc, ctx);
    if (env !== null) objects.push(env.secret);
    const template = buildPodTemplate(svc, env, ctx);
    const workload = buildWorkload(svc, template, buildClaimTemplates(svc, ctx), ctx);
    // null: a Job with 0 replicas is not created (deploy.job-zero-replicas)
    if (workload !== null) objects.push(workload);
    objects.push(...buildServices(svc, ctx));
  }

  objects.push(...buildIngress(ctx));
  assertUniqueObjectKeys(objects);
  return { objects };
}

/**
 * Every object of a render is applied by (kind, name) into one namespace: two with one key would
 * silently overwrite each other. The normalizer's name checks make it unreachable from user input,
 * so a duplicate is a translator bug (T6).
 */
export function assertUniqueObjectKeys(objects: readonly ManifestObject[]): void {
  const seen = new Set<string>();
  for (const object of objects) {
    const key = `${object.kind}/${object.metadata.name}`;
    if (seen.has(key)) translatorBug(`The render produced ${key} twice`);
    seen.add(key);
  }
}
