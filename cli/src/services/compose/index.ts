/**
 * Compose — template rendering + docker-compose YAML manipulation.
 *
 * Template rendering, YAML load/serialize, image tag updates, Swarm deploy config injection and
 * Traefik label generation. Rendering is in-memory: it returns a Map<relativePath, renderedContent>.
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
