/**
 * The Swarm orchestrator bundle (DESIGN-CORE 2.3, 6.4): every Swarm backend defaults to the real SSH
 * transport on its own, so assembly here is just construction — no shared executor to bind, unlike
 * the Kubernetes bundle (one manager connection per backend call, D21).
 */

import type { DockflowConfig } from '../../../utils/config';
import { capabilitiesFor } from '../capabilities';
import type { Orchestrator, OrchestratorTarget } from '../interfaces';
import { FileLockStore } from '../stores/file-lock-store';
import { FileReleaseStore, sshStoreShell } from '../stores/file-release-store';
import { swarmNaming } from './swarm-naming';
import { SwarmBackupBackend } from './swarm-backup';
import { SwarmClusterBackend } from './swarm-cluster';
import { SwarmContainerBackend } from './swarm-container';
import { SwarmImageBackend } from './swarm-images';
import { SwarmProxyBackend } from './swarm-proxy';
import { SwarmStackBackend } from './swarm-stack';
import { SwarmVolumeBackend } from './swarm-volumes';

export function createSwarmOrchestrator(target: OrchestratorTarget, config: DockflowConfig): Orchestrator {
  const shell = sshStoreShell(target.controlPlane.connection);
  const releases = new FileReleaseStore(shell);

  return {
    kind: 'swarm',
    target,
    capabilities: capabilitiesFor('swarm'),
    naming: swarmNaming,
    stack: new SwarmStackBackend(target),
    containers: new SwarmContainerBackend(target),
    proxy: new SwarmProxyBackend(target),
    images: new SwarmImageBackend(target, { containerEngine: config.container_engine }),
    cluster: new SwarmClusterBackend(target),
    backups: new SwarmBackupBackend(target, swarmNaming),
    releases,
    volumes: new SwarmVolumeBackend(target),
    helm: null,
    lock: (stackName, staleThresholdMinutes, leaseName) =>
      new FileLockStore(shell, stackName, { staleThresholdMinutes, name: leaseName }),
  };
}
