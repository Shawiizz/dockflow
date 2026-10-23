/** Schema of the flat layout's dockflow.yml: config.yml and servers.yml in one file. */

import { z } from 'zod';
import { DockflowConfigSchema } from './config.schema';
import { ServersBaseSchema, validateManagerPerTag } from './servers.schema';

export const RootConfigSchema = DockflowConfigSchema.merge(ServersBaseSchema).refine(
  validateManagerPerTag,
  { message: 'Each environment tag must have at least one manager server' }
);

export type RootConfig = z.output<typeof RootConfigSchema>;
