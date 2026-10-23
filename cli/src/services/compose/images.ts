/**
 * Compose images — image references, the tags Dockflow gives built images, the registry
 * predicates, and the image lists a release compares.
 */

import { createHash } from 'crypto';
import type { DockflowConfig } from '../../utils/config';
import type { ParsedCompose } from './types';

/**
 * Heuristic: does an image string already contain a registry domain?
 * e.g. "registry.io/ns/myapp" → true, "myapp" → false
 */
function hasRegistryDomain(image: string): boolean {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) return false;
  const prefix = image.substring(0, firstSlash);
  return prefix.includes('.') || prefix.includes(':');
}

/**
 * Split a Docker image reference into name and tag.
 *
 * The tag separator is the last colon AFTER the last slash.
 * This correctly handles registry:port URLs:
 *   "registry:5000/app:v1"  → { name: "registry:5000/app", tag: "v1" }
 *   "myapp:latest"          → { name: "myapp", tag: "latest" }
 *   "myapp"                 → { name: "myapp", tag: undefined }
 *   "registry:5000/app"     → { name: "registry:5000/app", tag: undefined }
 */
export function parseImageRef(image: string): { name: string; tag: string | undefined } {
  const lastSlash = image.lastIndexOf('/');
  const tagSep = image.indexOf(':', lastSlash + 1);
  if (tagSep === -1) {
    return { name: image, tag: undefined };
  }
  return { name: image.substring(0, tagSep), tag: image.substring(tagSep + 1) };
}

function hasBuild(service: Record<string, unknown>): boolean {
  const build = service.build;
  return typeof build === 'string' ? build !== '' : build !== null && typeof build === 'object';
}

/** What a release records, and the server keeps, to tell whether the accessories changed. */
export function accessoriesDigest(serializedCompose: string): string {
  return createHash('sha256').update(serializedCompose).digest('hex');
}

/** `registry.token` is the documented spelling for GHCR and GitLab; either one authenticates. */
export function registryPassword(config: DockflowConfig): string | undefined {
  return config.registry?.password || config.registry?.token || undefined;
}

/** The one registry predicate: images are named for, pushed to and pulled from the registry only when it holds. */
export function usesRegistry(config: DockflowConfig): boolean {
  const registry = config.registry;
  return registry?.enabled === true && !!registry.url && !!registryPassword(config);
}

/** Why the registry is enabled but unused, null when it is used or disabled. */
export function registryWithoutCredentials(config: DockflowConfig): string | null {
  const registry = config.registry;
  if (registry?.enabled !== true || !registry.url || registryPassword(config)) return null;
  return `Registry ${registry.url} is enabled but neither registry.password nor registry.token is set; built images are distributed over SSH instead of pushed`;
}

/**
 * Update the image tags of the services Dockflow builds (those with a `build:` section).
 *
 * If `image_auto_tag` is true (default):
 *   - Strips existing tag: "my-api:old" → "my-api"
 *   - Appends env + version: "my-api" → "my-api-{env}:{version}"
 *
 * If the registry is used (`usesRegistry`):
 *   - Prepends registry prefix (only if image doesn't already contain a registry domain)
 */
export function updateImageTags(
  compose: ParsedCompose,
  config: DockflowConfig,
  env: string,
  version: string,
  servicesFilter?: string,
): void {
  const autoTag = config.options?.image_auto_tag !== false;
  const useRegistry = usesRegistry(config);
  const registryUrl = config.registry?.url ?? '';
  const registryNs = config.registry?.namespace ?? '';
  const registryPrefix = registryNs
    ? `${registryUrl}/${registryNs}`
    : registryUrl;
  const filterSet = servicesFilter
    ? new Set(servicesFilter.split(',').map(s => s.trim()))
    : null;

  for (const [name, svc] of Object.entries(compose.services)) {
    const originalImage = svc.image;
    // an image Dockflow does not build is pulled as written: renamed, it would exist nowhere
    if (typeof originalImage !== 'string' || originalImage === '' || !hasBuild(svc)) continue;
    if (filterSet && !filterSet.has(name)) continue;

    let newImage: string;

    if (autoTag) {
      const imageWithoutTag = parseImageRef(originalImage).name;
      newImage = `${imageWithoutTag}-${env}:${version}`;
    } else {
      newImage = originalImage;
    }

    if (useRegistry && !hasRegistryDomain(parseImageRef(newImage).name)) {
      newImage = `${registryPrefix}/${newImage}`;
    }

    compose.services[name] = { ...svc, image: newImage };
  }

  compose.raw.services = compose.services;
}

/**
 * Build a release compose for a partial deploy (--only).
 *
 * Starts from the local compose (preserves new services, config changes), then
 * for services NOT being deployed that also exist in the server release, replaces
 * their image tag with the one from the server so the release reflects what is
 * actually running for those services.
 *
 * Services only in local  (new, not yet on server) → keep local image tag.
 * Services only in server (removed locally)        → absent from release (correct).
 */
export function syncNonTargetedImageTags(
  local: ParsedCompose,
  server: ParsedCompose,
  targetedServices: string[],
): ParsedCompose {
  const targeted = new Set(targetedServices);
  const services = { ...local.services };

  for (const [name, svc] of Object.entries(services)) {
    if (targeted.has(name)) continue;
    const serverImage = server.services[name]?.image as string | undefined;
    if (serverImage) services[name] = { ...svc, image: serverImage };
  }

  return { ...local, services };
}

/** The distinct image references of all services. */
export function getImages(compose: ParsedCompose): string[] {
  const images = new Set<string>();
  for (const svc of Object.values(compose.services)) {
    const img = svc.image as string | undefined;
    if (img) images.add(img);
  }
  return [...images];
}
