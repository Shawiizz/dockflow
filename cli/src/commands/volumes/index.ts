// `dockflow volumes` command group (design-06 3.17, D7): persistent volumes on Kubernetes.

import type { Command } from 'commander';
import { registerVolumesListCommand } from './list';
import { registerVolumesRemoveCommand } from './remove';

export function registerVolumesCommands(program: Command): void {
  const volumes = program.command('volumes').description('Manage persistent volumes (orchestrator: k3s)').helpGroup('Resources');

  registerVolumesListCommand(volumes);
  registerVolumesRemoveCommand(volumes);
}
