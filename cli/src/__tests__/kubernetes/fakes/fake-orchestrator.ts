// FakeOrchestrator (design-07 3.8): an in-memory Orchestrator bundle for flow, command and API tests.
// Every backend method logs an ordered event (`stack.deploy:app`, `releases.create:1.2.0`,
// `lock.release`) and records its arguments; its result is programmable per method, with defaults
// that describe a healthy stack. Releases and locks are small in-memory models, so a flow reads back
// what it wrote. forbidRemoteWork() makes every remote method throw `SSH touched`, which is how
// refusal tests prove nothing reached a node.

import { Readable } from 'stream';
import { capabilitiesFor } from '../../../services/orchestrator/capabilities';
import type {
  BackupBackend,
  ClusterBackend,
  ClusterNodeRef,
  ContainerBackend,
  DeployReceipt,
  HelmBackend,
  HelmChartSource,
  HelmReleaseStatus,
  ImageBackend,
  LockData,
  LockStore,
  Orchestrator,
  OrchestratorCapabilities,
  OrchestratorKind,
  OrchestratorTarget,
  ProxyBackend,
  ProxyStatus,
  ReleaseMetadata,
  ReleaseStore,
  StackArtifact,
  StackBackend,
  StackNaming,
  StackRef,
  StackRole,
  VolumeBackend,
} from '../../../services/orchestrator/interfaces';
import { K8S_REGISTRY_SECRET } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import { err, ok } from '../../../types/result';
import { DeployError, ErrorCode, UnsupportedOperationError } from '../../../utils/errors';
import { FakeClock } from './fake-clock';
import { fakeNode } from './fake-kube-executor';

type AnyMethod = (...args: never[]) => unknown;

/**
 * What a test programs for one method: the result (the resolved value for async methods), an Error
 * to throw or reject with, or an implementation receiving the call's arguments.
 */
export type Programmed<F extends AnyMethod> =
  | Awaited<ReturnType<F>>
  | Error
  | ((...args: Parameters<F>) => ReturnType<F> | Awaited<ReturnType<F>>);

type MethodsOf<P extends string, T> = {
  [K in keyof T & string as T[K] extends AnyMethod ? `${P}.${K}` : never]: T[K] extends AnyMethod ? Programmed<T[K]> : never;
};

/** `<backend>.<method>` of every backend method of the bundle, and of the LockStore it hands out */
export type ProgrammableMethods = MethodsOf<'stack', StackBackend> &
  MethodsOf<'containers', ContainerBackend> &
  MethodsOf<'proxy', ProxyBackend> &
  MethodsOf<'images', ImageBackend> &
  MethodsOf<'cluster', ClusterBackend> &
  MethodsOf<'backups', BackupBackend> &
  MethodsOf<'releases', ReleaseStore> &
  MethodsOf<'volumes', VolumeBackend> &
  MethodsOf<'helm', HelmBackend> &
  MethodsOf<'lock', LockStore>;

export type ProgrammableMethod = keyof ProgrammableMethods;

export interface FakeOrchestratorCall {
  method: ProgrammableMethod;
  /** the event logged for it */
  event: string;
  args: unknown[];
}

export interface FakeOrchestratorOptions {
  capabilities?: Partial<OrchestratorCapabilities>;
  /** default: project `shop`, env `production`, control plane `server_1`, worker `agent_1` */
  target?: Partial<OrchestratorTarget>;
  naming?: Partial<StackNaming>;
  /** timestamps of receipts, releases and locks; default a FakeClock at 2026-01-01 */
  clock?: Clock;
}

/** the release a test seeds or a flow creates */
export interface FakeStoredRelease {
  metadata: ReleaseMetadata;
  compose: string;
  artifact: StackArtifact;
}

interface StackReleases {
  releases: Map<string, FakeStoredRelease>;
  current: string | null;
  accessoriesDigest: string | null;
}

const NOT_PROGRAMMED = Symbol('not programmed');

function chartName(chart: HelmChartSource): string {
  if (chart.kind === 'repo') return chart.chart;
  return chart.ref.replace(/^oci:\/\//, '').split('/').pop()?.split(/[:@]/)[0] ?? chart.ref;
}

function defaultNaming(kind: OrchestratorKind): StackNaming {
  const scope = (ref: StackRef): string =>
    kind === 'k3s' ? `dockflow-${ref.project}-${ref.env}` : `${ref.project}-${ref.env}${ref.role === 'accessory' ? '-accessories' : ''}`;
  return {
    scope,
    describe: (ref) =>
      kind === 'k3s' ? `namespace ${scope(ref)}${ref.role === 'accessory' ? ' (accessories)' : ''}` : `stack ${scope(ref)}`,
    serviceNativeName: (ref, service) => (kind === 'k3s' ? service.toLowerCase().replace(/_/g, '-') : `${scope(ref)}_${service}`),
  };
}

export class FakeOrchestrator implements Orchestrator {
  readonly kind: OrchestratorKind;
  readonly target: OrchestratorTarget;
  readonly capabilities: OrchestratorCapabilities;
  readonly naming: StackNaming;
  readonly stack: StackBackend;
  readonly containers: ContainerBackend;
  readonly proxy: ProxyBackend;
  readonly images: ImageBackend;
  readonly cluster: ClusterBackend;
  readonly backups: BackupBackend;
  readonly releases: ReleaseStore;
  readonly volumes: VolumeBackend;
  readonly helm: HelmBackend | null;
  /** ordered event log, e.g. `lock.acquire`, `stack.render:app`, `releases.create:1.2.0`, `stack.deploy:accessory` */
  readonly events: string[] = [];
  /** every call with its arguments, in order */
  readonly calls: FakeOrchestratorCall[] = [];
  /** remote methods called after forbidRemoteWork() */
  readonly forbiddenCalls: ProgrammableMethod[] = [];
  private readonly clock: Clock;
  private readonly programmed = new Map<string, unknown>();
  private readonly queued = new Map<string, unknown[]>();
  private readonly stores = new Map<string, StackReleases>();
  private readonly locks = new Map<string, LockData>();
  private remoteForbidden = false;

  constructor(kind: OrchestratorKind, options: FakeOrchestratorOptions = {}) {
    this.kind = kind;
    this.clock = options.clock ?? new FakeClock();
    this.capabilities = { ...capabilitiesFor(kind), ...options.capabilities };
    const project = options.target?.project ?? 'shop';
    const env = options.target?.env ?? 'production';
    const controlPlane = options.target?.controlPlane ?? fakeNode('server_1');
    this.target = {
      kind,
      project,
      env,
      stackName: `${project}-${env}`,
      controlPlane,
      managers: [controlPlane],
      workers: [fakeNode('agent_1')],
      probes: [],
      ...options.target,
    };
    this.naming = { ...defaultNaming(kind), ...options.naming };
    this.stack = this.stackBackend();
    this.containers = this.containerBackend();
    this.proxy = this.proxyBackend();
    this.images = this.imageBackend();
    this.cluster = this.clusterBackend();
    this.backups = this.backupBackend();
    this.releases = this.releaseStore();
    this.volumes = this.volumeBackend();
    this.helm = this.capabilities.helm ? this.helmBackend() : null;
  }

  /** the result of every later call of `method` (an Error throws, a function computes it) */
  program<M extends ProgrammableMethod>(method: M, result: ProgrammableMethods[M]): void {
    this.programmed.set(method, result);
  }

  /** the result of the next call of `method` only; queued results are used before program()'s */
  programOnce<M extends ProgrammableMethod>(method: M, result: ProgrammableMethods[M]): void {
    this.queued.set(method, [...(this.queued.get(method) ?? []), result]);
  }

  /** any remote call now throws `SSH touched`; render, naming and hookWorkingDir stay local */
  forbidRemoteWork(): void {
    this.remoteForbidden = true;
  }

  /** a remote method was called after forbidRemoteWork() */
  get remoteWorkTripped(): boolean {
    return this.forbiddenCalls.length > 0;
  }

  /** the arguments of every call of one method */
  callsTo(method: ProgrammableMethod): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  /** a release as if deployed earlier; the newest seeded release becomes current unless `current: false` */
  seedRelease(
    stackName: string,
    release: { version: string; epoch?: number; compose?: string; artifact?: Partial<StackArtifact>; metadata?: Partial<ReleaseMetadata> },
    options: { current?: boolean } = {},
  ): FakeStoredRelease {
    const store = this.storeFor(stackName);
    const epoch = release.epoch ?? store.releases.size + 1;
    const stored: FakeStoredRelease = {
      metadata: {
        project_name: this.target.project,
        version: release.version,
        env: this.target.env,
        timestamp: new Date(this.clock.now().getTime() + epoch * 1000).toISOString(),
        epoch,
        performer: 'test',
        branch: 'main',
        orchestrator: this.kind,
        artifact_format: this.capabilities.artifactFormat,
        ...release.metadata,
      },
      compose: release.compose ?? '',
      artifact: { ...this.artifactFor('app', release.version), diagnostics: [], ...release.artifact },
    };
    store.releases.set(release.version, stored);
    if (options.current ?? true) store.current = release.version;
    return stored;
  }

  /** what the in-memory release store holds for one stack */
  storedReleases(stackName: string): { current: string | null; accessoriesDigest: string | null; versions: string[] } {
    const store = this.storeFor(stackName);
    return { current: store.current, accessoriesDigest: store.accessoriesDigest, versions: this.sorted(store).map((r) => r.metadata.version) };
  }

  /** the holder of a lock (stack name or lease name), null when free */
  lockHolder(name: string): LockData | null {
    return this.locks.get(name) ?? null;
  }

  lock(stackName: string, staleThresholdMinutes?: number, leaseName?: string): LockStore {
    const name = leaseName ?? stackName;
    const args = [stackName, staleThresholdMinutes, leaseName];
    return {
      status: () =>
        this.remote('lock.status', 'lock.status', args, () => {
          const data = this.locks.get(name);
          return ok(data ? { locked: true, data, durationMinutes: 0, isStale: false } : { locked: false });
        }),
      acquire: (options) =>
        this.remote('lock.acquire', 'lock.acquire', [...args, options], () => {
          const held = this.locks.get(name);
          if (held && !options?.force) return err(new Error(`Already locked by ${held.performer} since ${held.started_at}`));
          const now = this.clock.now();
          const data: LockData = {
            performer: 'test',
            started_at: now.toISOString(),
            timestamp: now.getTime(),
            version: options?.version ?? '',
            stack: stackName,
            ...(options?.message !== undefined ? { message: options.message } : {}),
          };
          this.locks.set(name, data);
          return ok(data);
        }),
      release: () =>
        this.remote('lock.release', 'lock.release', args, () => {
          this.locks.delete(name);
          return ok(undefined);
        }),
    };
  }

  // ---- dispatch ---------------------------------------------------------------------------------

  private log(method: ProgrammableMethod, event: string, args: readonly unknown[]): void {
    this.events.push(event);
    this.calls.push({ method, event, args: [...args] });
  }

  private next(method: ProgrammableMethod): unknown {
    const queue = this.queued.get(method);
    if (queue !== undefined && queue.length > 0) return queue.shift();
    return this.programmed.has(method) ? this.programmed.get(method) : NOT_PROGRAMMED;
  }

  private resolve(method: ProgrammableMethod, args: readonly unknown[], fallback: () => unknown): unknown {
    const result = this.next(method);
    if (result === NOT_PROGRAMMED) return fallback();
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return (result as (...values: unknown[]) => unknown)(...args);
    return result;
  }

  /** a local, synchronous method (render): logged and programmable, never forbidden */
  private local<T>(method: ProgrammableMethod, event: string, args: readonly unknown[], fallback: () => T): T {
    this.log(method, event, args);
    return this.resolve(method, args, fallback) as T;
  }

  /** a method that would reach a node */
  private async remote<T>(method: ProgrammableMethod, event: string, args: readonly unknown[], fallback: () => T | Promise<T>): Promise<T> {
    this.log(method, event, args);
    if (this.remoteForbidden) {
      this.forbiddenCalls.push(method);
      throw new Error(`SSH touched: ${method}`);
    }
    return (await this.resolve(method, args, fallback)) as T;
  }

  // ---- defaults -------------------------------------------------------------------------------

  private artifactFor(role: StackRole, version: string): StackArtifact {
    return {
      format: this.capabilities.artifactFormat,
      role,
      content: `# fake ${role} artifact ${version}\n`,
      helm: [],
      diagnostics: [],
      digest: `fake-${role}-${version}`,
    };
  }

  private receipt(ref: StackRef, version: string, fields: Partial<DeployReceipt>): DeployReceipt {
    return {
      ref,
      version,
      startedAt: this.clock.now(),
      services: null,
      skipped: false,
      artifactDigest: '',
      changes: [],
      helm: [],
      helmChanges: [],
      helmDeclared: [],
      previousVersion: null,
      ...fields,
    };
  }

  private nodeNames(nodes: readonly ClusterNodeRef[]): string[] {
    return nodes.map((node) => node.name);
  }

  private stackBackend(): StackBackend {
    return {
      render: (input) => this.local('stack.render', `stack.render:${input.ref.role}`, [input], () => this.artifactFor(input.ref.role, input.version)),
      deploy: (input) =>
        this.remote('stack.deploy', `stack.deploy:${input.ref.role}`, [input], () =>
          ok(
            this.receipt(input.ref, input.version, {
              services: input.services,
              artifactDigest: this.artifactFor(input.ref.role, input.version).digest,
              helmDeclared: [...input.helmDeclared],
              previousVersion: input.previousVersion,
            }),
          ),
        ),
      apply: (ref, version, artifact, options) =>
        this.remote('stack.apply', `stack.apply:${ref.role}`, [ref, version, artifact, options], () =>
          ok(this.receipt(ref, version, { services: options.services, artifactDigest: artifact.digest })),
        ),
      waitConvergence: (receipt, options) =>
        this.remote('stack.waitConvergence', `stack.waitConvergence:${receipt.ref.role}`, [receipt, options], () => ({
          status: 'converged' as const,
          failures: [],
        })),
      checkHealth: (receipt, options) =>
        this.remote('stack.checkHealth', `stack.checkHealth:${receipt.ref.role}`, [receipt, options], () => ({
          healthy: true,
          rolledBack: false,
          failures: [],
        })),
      revert: (receipt) =>
        this.remote('stack.revert', `stack.revert:${receipt.ref.role}`, [receipt], () =>
          this.capabilities.revert === 'native'
            ? { status: 'native' as const, services: [] }
            : { status: 'reverted' as const, services: receipt.changes.map((change) => change.service) },
        ),
      finalize: (receipt) => this.remote('stack.finalize', `stack.finalize:${receipt.ref.role}`, [receipt], () => undefined),
      exists: (ref) => this.remote('stack.exists', `stack.exists:${ref.role}`, [ref], () => true),
      getServices: (ref) => this.remote('stack.getServices', `stack.getServices:${ref.role}`, [ref], () => []),
      listInstances: (ref, options) => this.remote('stack.listInstances', `stack.listInstances:${ref.role}`, [ref, options], () => []),
      diagnose: (ref, options) =>
        this.remote('stack.diagnose', `stack.diagnose:${ref.role}`, [ref, options], () => ({ sections: [], issues: [] })),
      scale: (ref, service, replicas, options) =>
        this.remote('stack.scale', `stack.scale:${ref.role}`, [ref, service, replicas, options], () => undefined),
      restart: (ref, service, options) => this.remote('stack.restart', `stack.restart:${ref.role}`, [ref, service, options], () => undefined),
      rollbackService: (ref, service, options) =>
        this.remote('stack.rollbackService', `stack.rollbackService:${ref.role}`, [ref, service, options], () => ({ toVersion: null })),
      stop: (ref, services, options) => this.remote('stack.stop', `stack.stop:${ref.role}`, [ref, services, options], () => undefined),
      remove: (ref, options) => this.remote('stack.remove', `stack.remove:${ref.role}`, [ref, options], () => undefined),
    };
  }

  private containerBackend(): ContainerBackend {
    return {
      exec: (ref, target, request) => this.remote('containers.exec', 'containers.exec', [ref, target, request], () => 0),
      capture: (ref, target, argv) =>
        this.remote('containers.capture', 'containers.capture', [ref, target, argv], () => ({ exitCode: 0, stdout: '', stderr: '' })),
      shell: (ref, target, shell) => this.remote('containers.shell', 'containers.shell', [ref, target, shell], () => 0),
      interactiveCommand: (ref, target, shell) =>
        this.remote('containers.interactiveCommand', 'containers.interactiveCommand', [ref, target, shell], () => ({
          connection: this.target.controlPlane.connection,
          command: shell,
        })),
      streamLogs: (ref, service, options, sink) =>
        this.remote('containers.streamLogs', 'containers.streamLogs', [ref, service, options, sink], () => undefined),
      copyOut: (ref, target, path) => this.remote('containers.copyOut', 'containers.copyOut', [ref, target, path], () => Readable.from([])),
      copyIn: (ref, target, destDir, tar) =>
        this.remote('containers.copyIn', 'containers.copyIn', [ref, target, destDir, tar], () => {
          tar.resume();
        }),
      stats: (ref) => this.remote('containers.stats', 'containers.stats', [ref], () => []),
    };
  }

  private proxyStatus(): ProxyStatus {
    return { installed: false, ready: false, version: null, owner: null, entryPoints: [], acme: false, acmeReclaimPolicy: null };
  }

  private proxyBackend(): ProxyBackend {
    return {
      plan: (proxy, env) =>
        this.remote('proxy.plan', 'proxy.plan', [proxy, env], () => ({
          action: 'unchanged' as const,
          reason: '',
          status: this.proxyStatus(),
          blockers: [],
        })),
      ensure: (proxy, env, events) =>
        this.remote('proxy.ensure', 'proxy.ensure', [proxy, env, events], () => ({ changed: false, action: 'unchanged' as const, version: null })),
      status: () => this.remote('proxy.status', 'proxy.status', [], () => this.proxyStatus()),
    };
  }

  private imageBackend(): ImageBackend {
    return {
      distribute: (images, nodes) => this.remote('images.distribute', 'images.distribute', [images, nodes], () => undefined),
      verifyPresence: (images, nodes) => this.remote('images.verifyPresence', 'images.verifyPresence', [images, nodes], () => []),
      ensurePullSecret: (ref, registry) =>
        this.remote('images.ensurePullSecret', 'images.ensurePullSecret', [ref, registry], () => (this.kind === 'k3s' ? K8S_REGISTRY_SECRET : null)),
      remove: (images, nodes) => this.remote('images.remove', 'images.remove', [images, nodes], () => undefined),
      collectGarbage: (nodes, removed, kept) =>
        this.remote('images.collectGarbage', 'images.collectGarbage', [nodes, removed, kept], () => undefined),
      list: (nodes, options) =>
        this.remote('images.list', 'images.list', [nodes, options], () =>
          this.nodeNames(nodes).map((node) => ({ node, images: [], diskUsage: null })),
        ),
      prune: (nodes, options) =>
        this.remote('images.prune', 'images.prune', [nodes, options], () => this.nodeNames(nodes).map((node) => ({ node, reclaimed: null }))),
      pruneRuntime: (nodes, target) =>
        this.remote('images.pruneRuntime', 'images.pruneRuntime', [nodes, target], () => {
          if (this.kind === 'k3s') {
            throw new UnsupportedOperationError(`dockflow prune --${target} is not supported with orchestrator: k3s`);
          }
          return this.nodeNames(nodes).map((node) => ({ node, reclaimed: null }));
        }),
    };
  }

  private clusterBackend(): ClusterBackend {
    return {
      probe: (node) => this.remote('cluster.probe', 'cluster.probe', [node], () => ({ node: node.name, status: 'ready' as const })),
      preflight: (needs) => this.remote('cluster.preflight', 'cluster.preflight', [needs], () => undefined),
      nodes: () =>
        this.remote('cluster.nodes', 'cluster.nodes', [], () =>
          [...this.target.managers, ...this.target.workers].map((node) => ({
            name: this.kind === 'k3s' ? node.name.toLowerCase().replace(/_/g, '-') : node.name,
            server: node.name,
            role: node.role,
            ready: true,
            schedulable: true,
            version: this.kind === 'k3s' ? K3S_PIN.version : null,
            internalIp: node.privateHost,
            pressure: [],
          })),
        ),
      serverVersion: () => this.remote('cluster.serverVersion', 'cluster.serverVersion', [], () => (this.kind === 'k3s' ? K3S_PIN.version : '27.5.1')),
    };
  }

  private backupBackend(): BackupBackend {
    return {
      dump: (ref, target, script, remotePath, options) =>
        this.remote('backups.dump', 'backups.dump', [ref, target, script, remotePath, options], () => ({ node: this.target.controlPlane, remotePath })),
      restore: (ref, target, script, file, options) =>
        this.remote('backups.restore', 'backups.restore', [ref, target, script, file, options], () => ({ exitCode: 0, stderr: '' })),
      volumes: (ref, service, options) => this.remote('backups.volumes', 'backups.volumes', [ref, service, options], () => []),
      archiveVolumes: (ref, service, volumes, pathPrefix, options) =>
        this.remote('backups.archiveVolumes', 'backups.archiveVolumes', [ref, service, volumes, pathPrefix, options], () =>
          volumes.map((volume) => ({
            node: this.target.controlPlane,
            remotePath: `${pathPrefix}.${volume.name}.tar${options.gzip ? '.gz' : ''}`,
          })),
        ),
      restoreVolumes: (ref, service, archives) =>
        this.remote('backups.restoreVolumes', 'backups.restoreVolumes', [ref, service, archives], () => undefined),
      restartAfterRestore: (ref, service) =>
        this.remote('backups.restartAfterRestore', 'backups.restartAfterRestore', [ref, service], () => undefined),
    };
  }

  private storeFor(stackName: string): StackReleases {
    let store = this.stores.get(stackName);
    if (!store) {
      store = { releases: new Map(), current: null, accessoriesDigest: null };
      this.stores.set(stackName, store);
    }
    return store;
  }

  /** newest first (epoch descending) */
  private sorted(store: StackReleases): FakeStoredRelease[] {
    return [...store.releases.values()].sort((a, b) => b.metadata.epoch - a.metadata.epoch);
  }

  private stored(stackName: string, version: string): FakeStoredRelease {
    const release = this.storeFor(stackName).releases.get(version);
    if (!release) throw new DeployError(`Release ${version} of ${stackName} was not found`, ErrorCode.ROLLBACK_FAILED);
    return release;
  }

  private releaseStore(): ReleaseStore {
    return {
      create: (stackName, release) =>
        this.remote('releases.create', `releases.create:${release.version}`, [stackName, release], () => {
          const store = this.storeFor(stackName);
          const previous = store.current;
          store.releases.set(release.version, {
            metadata: { ...release.metadata },
            compose: release.compose,
            artifact: { ...release.artifact, diagnostics: [] },
          });
          store.current = release.version;
          return { previous };
        }),
      current: (stackName) =>
        this.remote('releases.current', 'releases.current', [stackName], () => {
          const store = this.storeFor(stackName);
          return store.current === null ? null : (store.releases.get(store.current)?.metadata ?? null);
        }),
      currentVersion: (stackName) => this.remote('releases.currentVersion', 'releases.currentVersion', [stackName], () => this.storeFor(stackName).current),
      currentCompose: (stackName) =>
        this.remote('releases.currentCompose', 'releases.currentCompose', [stackName], () => {
          const store = this.storeFor(stackName);
          return store.current === null ? null : (store.releases.get(store.current)?.compose ?? null);
        }),
      list: (stackName) =>
        this.remote('releases.list', 'releases.list', [stackName], () => this.sorted(this.storeFor(stackName)).map((r) => r.metadata)),
      latestVersion: (stackName) =>
        this.remote('releases.latestVersion', 'releases.latestVersion', [stackName], () => this.sorted(this.storeFor(stackName))[0]?.metadata.version ?? null),
      readArtifact: (stackName, version) =>
        this.remote('releases.readArtifact', `releases.readArtifact:${version}`, [stackName, version], () => this.stored(stackName, version).artifact),
      readCompose: (stackName, version) =>
        this.remote('releases.readCompose', `releases.readCompose:${version}`, [stackName, version], () =>
          this.storeFor(stackName).releases.has(version) ? this.stored(stackName, version).compose : null,
        ),
      setCurrent: (stackName, version) =>
        this.remote('releases.setCurrent', `releases.setCurrent:${version ?? 'none'}`, [stackName, version], () => {
          this.storeFor(stackName).current = version;
        }),
      remove: (stackName, version, options) =>
        this.remote('releases.remove', `releases.remove:${version}`, [stackName, version, options], () => {
          const store = this.storeFor(stackName);
          store.releases.delete(version);
          if (store.current === version) store.current = options?.restoreCurrentTo ?? null;
        }),
      prune: (stackName, keep) =>
        this.remote('releases.prune', 'releases.prune', [stackName, keep], () => {
          const store = this.storeFor(stackName);
          const removed = this.sorted(store)
            .filter((release) => release.metadata.version !== store.current)
            .slice(Math.max(0, keep - (store.current === null ? 0 : 1)));
          for (const release of removed) store.releases.delete(release.metadata.version);
          return removed.map((release) => release.metadata);
        }),
      hookWorkingDir: (stackName) =>
        this.kind === 'k3s' ? `/var/lib/dockflow/hooks/${stackName}` : `/var/lib/dockflow/stacks/${stackName}/current`,
      writeAccessoriesDigest: (stackName, digest) =>
        this.remote('releases.writeAccessoriesDigest', 'releases.writeAccessoriesDigest', [stackName, digest], () => {
          this.storeFor(stackName).accessoriesDigest = digest;
        }),
      readState: (stackName) =>
        this.remote('releases.readState', 'releases.readState', [stackName], () => {
          const store = this.storeFor(stackName);
          return { current: store.current, accessoriesDigest: store.accessoriesDigest };
        }),
    };
  }

  private volumeBackend(): VolumeBackend {
    return {
      list: (scope) => this.remote('volumes.list', 'volumes.list', [scope], () => []),
      remove: (scope, names, options) =>
        this.remote('volumes.remove', 'volumes.remove', options === undefined ? [scope, names] : [scope, names, options], () => ({
          deleted: names.map((claim) => ({ claim, volume: null })),
          restored: [],
          restoreFailed: [],
        })),
    };
  }

  private helmStatus(name: string, namespace: string, role: StackRole | null, chart: string, revision: number): HelmReleaseStatus {
    return { name, namespace, role, revision, status: 'deployed', chart, appVersion: null, updated: null };
  }

  private helmBackend(): HelmBackend {
    return {
      upgradeInstall: (release, options) =>
        this.remote('helm.upgradeInstall', `helm.upgradeInstall:${release.name}`, [release, options], () => ({
          ...this.helmStatus(release.name, release.namespace, release.role, `${chartName(release.chart)}-${release.version}`, 1),
          changed: true,
          previousRevision: null,
          chartSha256: release.declaredDigest ?? '',
        })),
      uninstall: (namespace, name, options) => this.remote('helm.uninstall', `helm.uninstall:${name}`, [namespace, name, options], () => undefined),
      rollback: (namespace, name, revision, options) =>
        this.remote('helm.rollback', `helm.rollback:${name}`, [namespace, name, revision, options], () =>
          this.helmStatus(name, namespace, null, name, revision + 1),
        ),
      plan: (releases, stackId, options) =>
        this.remote('helm.plan', 'helm.plan', [releases, stackId, options], () =>
          releases.map((release) => ({ release: release.name, namespace: release.namespace, action: 'installed' as const, reason: 'not installed' })),
        ),
      list: (namespaces, stackId) => this.remote('helm.list', 'helm.list', [namespaces, stackId], () => []),
      listAll: (stackId) => this.remote('helm.listAll', 'helm.listAll', [stackId], () => []),
      status: (namespace, name) => this.remote('helm.status', `helm.status:${name}`, [namespace, name], () => null),
      history: (namespace, name, max) => this.remote('helm.history', `helm.history:${name}`, [namespace, name, max], () => []),
      deployedValues: (namespace, name, revision) =>
        this.remote('helm.deployedValues', `helm.deployedValues:${name}`, [namespace, name, revision], () => null),
      revisionsWithSpec: (namespace, name, specHash) =>
        this.remote('helm.revisionsWithSpec', `helm.revisionsWithSpec:${name}`, [namespace, name, specHash], () => []),
      ownerOf: (namespace, name) => this.remote('helm.ownerOf', `helm.ownerOf:${name}`, [namespace, name], () => null),
      manifestObjects: (namespace, name) => this.remote('helm.manifestObjects', `helm.manifestObjects:${name}`, [namespace, name], () => []),
      pinCharts: (releases, previous, options) => this.remote('helm.pinCharts', 'helm.pinCharts', [releases, previous, options], () => releases),
    };
  }
}
