/**
 * Compose — template rendering + docker-compose YAML manipulation.
 *
 * Handles Jinja2/nunjucks template rendering, YAML load/serialize,
 * image tag updates, Swarm deploy config injection, and Traefik label
 * generation — all in pure TypeScript.
 *
 * Template rendering is entirely in-memory — no files are ever
 * written to disk. Returns a Map<relativePath, renderedContent>.
 */

export type { ComposeRenderContext, ParsedCompose, RenderedComposeResult, RenderedFiles } from './types';
export { renderAndResolveCompose, renderTemplates } from './templates';
export { load, loadFromString, serialize } from './yaml';
export {
  accessoriesDigest,
  getImages,
  parseImageRef,
  registryPassword,
  registryWithoutCredentials,
  syncNonTargetedImageTags,
  updateImageTags,
  usesRegistry,
} from './images';
export { injectAccessoriesDefaults, injectSwarmDefaults, stripBuildSections } from './deploy-defaults';
export { checkProxyRoutes, injectTraefikLabels } from './traefik';
export {
  externalNetworksToCreate,
  filterServices,
  getExternalNetworks,
  getExternalVolumes,
  hasServices,
  parseContainerPort,
} from './selection';
