/**
 * Plugin manifest schema.
 *
 * A manifest is deliberately a fragment of config.yml: its `uploads` and `hooks`
 * are validated by the very schemas a project uses, so a plugin adds no
 * vocabulary beyond `inputs`. Anything else a project can set — servers,
 * compose, project_name — is rejected, because a plugin must stay readable as
 * "these files, these commands".
 */

import { z } from 'zod';
import { HookEntrySchema, UploadItemSchema } from './config.schema';

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const PluginInputSchema = z.object({
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  /**
   * `file` values are paths. A default resolves from the plugin's own directory,
   * a value the project provides resolves from the project root.
   */
  type: z.enum(['string', 'file']).optional(),
}).strict();

const phase = z.array(HookEntrySchema).optional();

export const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN, 'lowercase letters, digits and hyphens only'),
  description: z.string().optional(),
  inputs: z.record(z.string(), PluginInputSchema).optional(),
  uploads: z.array(UploadItemSchema).optional(),
  hooks: z.object({
    'pre-build': phase,
    'post-build': phase,
    'pre-upload': phase,
    'post-upload': phase,
    'pre-deploy': phase,
    'post-deploy': phase,
    'on-failure': phase,
  }).strict().optional(),
}).strict();

export type PluginInput = z.infer<typeof PluginInputSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
