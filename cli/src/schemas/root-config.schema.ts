/**
 * Schema for dockflow.yml — merges config.yml and servers.yml into a single file
 * Used when a project opts for the simplified rootless layout (no .dockflow/ directory)
 */

import { z } from 'zod';
import { DockflowConfigSchema } from './config.schema';
import { ServersBaseSchema, validateManagerPerTag } from './servers.schema';

export const RootConfigSchema = DockflowConfigSchema.merge(ServersBaseSchema).refine(
  validateManagerPerTag,
  { message: 'Each environment tag must have at least one manager server' }
);

export type RootConfig = z.output<typeof RootConfigSchema>;
