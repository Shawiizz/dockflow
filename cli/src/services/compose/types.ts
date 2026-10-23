/** Compose — the types shared by the compose modules. */

import type { DockflowConfig } from '../../utils/config';

export interface ComposeRenderContext {
  env: string;
  version: string;
  branch: string;
  project_name: string;
  config: DockflowConfig;
  servers?: Record<string, unknown>;
  cluster?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Result of renderTemplates — a Map of relative paths to rendered content.
 * No files are written to disk. Keys use forward slashes.
 */
export type RenderedFiles = Map<string, string>;

export interface ParsedCompose {
  raw: Record<string, unknown>;
  services: Record<string, Record<string, unknown>>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

export interface RenderedComposeResult {
  rendered: RenderedFiles;
  composeContent: string;
  composeDirPath: string;
  projectRoot: string;
  /** The context every file under .dockflow/ was rendered with. */
  renderContext: Record<string, unknown>;
}
