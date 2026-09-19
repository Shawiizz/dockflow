/**
 * Swarm StackBackend (DESIGN-CORE 6.1, 6.9): today's docker commands and outputs behind the
 * receipt-based contract. Deploy mechanics live in SwarmStackOps; inspection goes through the
 * shared parsers of swarm-utils.
 */

import { ok, err, type Result } from '../../../types/result';
import { CLIError, DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { createTimedSpinner, printDebug, printInfo, printWarning } from '../../../utils/output';
import { shellQuote } from '../../../utils/ssh';
import * as Compose from '../../compose';
import { formatReplicas } from '../format';
import type {
  ApplyOptions,
  ControlOptions,
  ConvergenceResult,
  DeployReceipt,
  DiagnosticIssue,
  DiagnosticLineLevel,
  DiagnosticReport,
  HealthOptions,
  InstanceInfo,
  InternalHealthResult,
  OrchestratorTarget,
  RevertResult,
  ServiceFailure,
  ServiceInfo,
  StackArtifact,
  StackArtifactFormat,
  StackBackend,
  StackDeployInput,
  StackNaming,
  StackRef,
  StackRole,
  WaitOptions,
} from '../interfaces';
import { analyzeError } from '../kubernetes/status/diagnose';
import { swarmNaming } from './swarm-naming';
import { SwarmStackOps, type SwarmClock, swarmClock, type SwarmServiceProblem } from './swarm-stack-ops';
import {
  errorText,
  listSwarmInstances,
  listSwarmServices,
  parseStackPsLine,
  readSwarmServices,
  runningTaskStatesCommand,
  runSwarmQuery,
  stackPsCommand,
  type SwarmSsh,
  swarmNodeToServer,
  swarmSsh,
} from './swarm-utils';

const q = shellQuote;

export const SWARM_ARTIFACT_FORMAT: StackArtifactFormat = 'swarm-compose/1';
/** First line of every Swarm artifact; a YAML comment, so `docker stack deploy -c -` reads past it. */
export const SWARM_ARTIFACT_HEADER = `# dockflow-artifact: ${SWARM_ARTIFACT_FORMAT}`;

export interface SwarmStackBackendOptions {
  /** default: the real SSH transport */
  ssh?: SwarmSsh;
  naming?: StackNaming;
  clock?: SwarmClock;
}

function withHeader(composeYaml: string): string {
  return `${SWARM_ARTIFACT_HEADER}\n${composeYaml}`;
}

/** `<project>-<env>`: names the accessories hash directory and the Traefik routers. */
function stackNameOf(ref: StackRef): string {
  return `${ref.project}-${ref.env}`;
}

/** The `--only` filter; an empty list filters nothing. */
function activeFilter(services: string[] | null): string[] | null {
  return services && services.length > 0 ? services : null;
}

/** An artifact reduced to some services; networks and volumes stay declared. */
function filteredContent(content: string, services: string[]): string {
  return withHeader(Compose.serialize(Compose.filterServices(Compose.loadFromString(content), services)));
}

function composeNameOf(scope: string, nativeName: string): string {
  return nativeName.startsWith(`${scope}_`) ? nativeName.slice(scope.length + 1) : nativeName;
}

function toDeployError(error: unknown): DeployError {
  if (error instanceof DeployError) return error;
  if (error instanceof CLIError) return new DeployError(error.message, error.code, error.suggestion);
  return new DeployError(errorText(error), ErrorCode.DEPLOY_FAILED);
}

// ---------------------------------------------------------------------------
// diagnose (pure): the sections and texts `dockflow diagnose` printed on Swarm
// ---------------------------------------------------------------------------

export interface SwarmDiagnoseTask {
  /** task name as docker prints it: `<stack>_<svc>.<slot>` */
  name: string;
  service: string;
  state: string;
  error: string | null;
}

export interface SwarmDiagnoseFacts {
  env: string;
  role: StackRole;
  exists: boolean;
  services: ServiceInfo[];
  tasks: SwarmDiagnoseTask[];
  /** recent container deaths; undefined when not read (not verbose), null when the read failed */
  events?: string | null;
  /** `df` use column of `/` (`42%`); null when it could not be read */
  disk: { text: string; percent: number } | null;
  /** used memory in percent; null when it could not be read */
  memoryPercent: number | null;
}

type Line = { text: string; level: DiagnosticLineLevel };

const MAX_TASK_ERRORS = 10;

export function buildSwarmDiagnosticReport(facts: SwarmDiagnoseFacts): DiagnosticReport {
  const { env } = facts;
  const issues: DiagnosticIssue[] = [];
  const sections: DiagnosticReport['sections'] = [];
  const section = (title: string, lines: Line[]): void => {
    sections.push({ title, lines });
  };

  if (!facts.exists) {
    const deploy = facts.role === 'accessory' ? `dockflow deploy ${env} --accessories` : `dockflow deploy ${env}`;
    section('Stack Status', [{ text: 'Stack does not exist', level: 'error' }]);
    issues.push({
      severity: 'error',
      category: 'Stack',
      message: 'Stack not found',
      suggestion: `Run '${deploy}' to deploy the stack`,
    });
    return { sections, issues };
  }
  section('Stack Status', [{ text: 'Stack exists', level: 'ok' }]);

  const serviceLines: Line[] = [];
  for (const service of facts.services) {
    const { running, desired } = service.replicas;
    const text = `${service.name}: ${formatReplicas(service)} replicas`;
    if (running === 0 && desired > 0) {
      serviceLines.push({ text, level: 'error' });
      issues.push({
        severity: 'error',
        category: 'Replicas',
        message: `Service '${service.name}' has 0/${desired} replicas`,
        suggestion: 'Check task errors below',
      });
    } else if (running < desired) {
      serviceLines.push({ text, level: 'warning' });
      issues.push({
        severity: 'warning',
        category: 'Replicas',
        message: `Service '${service.name}' has ${running}/${desired} replicas`,
      });
    } else {
      serviceLines.push({ text, level: 'ok' });
    }
  }
  section('Services', serviceLines);

  const failed = facts.tasks.filter((task) => task.error || task.state.includes('Failed')).slice(0, MAX_TASK_ERRORS);
  const taskLines: Line[] = [];
  if (failed.length === 0) taskLines.push({ text: 'No task errors found', level: 'ok' });
  for (const task of failed) {
    taskLines.push({ text: task.name, level: 'error' });
    taskLines.push({ text: `  State: ${task.state}`, level: 'plain' });
    if (task.error) {
      taskLines.push({ text: `  Error: ${task.error}`, level: 'plain' });
      issues.push({
        severity: 'error',
        category: 'Task',
        message: `${task.name}: ${task.error}`,
        suggestion: analyzeError(task.error, { source: 'swarm', env, service: task.service }),
      });
    }
    taskLines.push({ text: '', level: 'plain' });
  }
  section('Task Errors', taskLines);

  const pending = facts.tasks.filter(
    (task) => task.state.includes('Pending') || task.state.includes('Preparing') || task.state.includes('Starting'),
  );
  section(
    'Pending Tasks',
    pending.length === 0
      ? [{ text: 'No pending tasks', level: 'plain' }]
      : pending.map((task) => ({ text: `${task.name}: ${task.state}`, level: 'pending' })),
  );
  if (pending.some((task) => task.state.includes('Pending'))) {
    issues.push({
      severity: 'warning',
      category: 'Scheduling',
      message: 'Some tasks are pending',
      suggestion: 'May indicate resource constraints or scheduling issues',
    });
  }

  if (facts.events !== undefined) {
    const events = facts.events;
    section(
      'Recent Docker Events',
      events === null
        ? [{ text: 'Could not retrieve Docker events', level: 'plain' }]
        : events.trim() === ''
          ? [{ text: 'No recent container deaths', level: 'plain' }]
          : events
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .map((line) => ({ text: line, level: 'plain' })),
    );
  }

  const resources: Line[] = [];
  const { disk } = facts;
  if (disk === null) {
    resources.push({ text: 'Could not check disk space', level: 'plain' });
  } else if (disk.percent >= 90) {
    resources.push({ text: `Disk usage: ${disk.text}`, level: 'warning' });
    issues.push({
      severity: 'error',
      category: 'System',
      message: `Disk at ${disk.percent}%`,
      suggestion: `Run 'dockflow prune ${env}'`,
    });
  } else if (disk.percent >= 80) {
    resources.push({ text: `Disk usage: ${disk.text}`, level: 'warning' });
    issues.push({ severity: 'warning', category: 'System', message: `Disk at ${disk.percent}%` });
  } else {
    resources.push({ text: `Disk usage: ${disk.text}`, level: 'plain' });
  }

  const memory = facts.memoryPercent;
  if (memory === null) {
    resources.push({ text: 'Could not check memory usage', level: 'plain' });
  } else if (memory >= 90) {
    resources.push({ text: `Memory usage: ${memory}%`, level: 'error' });
    issues.push({
      severity: 'warning',
      category: 'System',
      message: `Memory at ${memory}%`,
      suggestion: 'High usage may prevent containers from starting',
    });
  } else {
    resources.push({ text: `Memory usage: ${memory}%`, level: memory >= 80 ? 'warning' : 'plain' });
  }
  section('System Resources', resources);

  return { sections, issues };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class SwarmStackBackend implements StackBackend {
  private readonly ssh: SwarmSsh;
  private readonly naming: StackNaming;
  private readonly clock: SwarmClock;
  private readonly ops: SwarmStackOps;
  /** render is called by the deploy phase and again by deploy(); rendering twice would warn twice */
  private readonly renders = new Map<string, StackArtifact>();
  /** accessories hash each deploy receipt writes in finalize(); receipts of apply() have none */
  private readonly pendingHashes = new WeakMap<DeployReceipt, { stackName: string; hash: string }>();

  constructor(
    private readonly target: OrchestratorTarget,
    options: SwarmStackBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
    this.naming = options.naming ?? swarmNaming;
    this.clock = options.clock ?? swarmClock;
    this.ops = new SwarmStackOps(this.ssh, target.controlPlane, target.env, this.clock);
  }

  // -------------------------------------------------------------------------
  // Render and deploy
  // -------------------------------------------------------------------------

  /**
   * The compose file Swarm receives, whole even under `--only` (the release stores it and a
   * rollback restores every service). Applications get build sections removed, the Swarm update
   * defaults and the Traefik labels; accessories arrive with their defaults already injected.
   */
  render(input: StackDeployInput): StackArtifact {
    const key = sha256Hex(
      canonicalJson({ ref: input.ref, compose: Compose.serialize(input.compose), proxy: input.proxy ?? null }),
    );
    const cached = this.renders.get(key);
    if (cached) return cached;

    const body = input.ref.role === 'accessory' ? Compose.serialize(input.compose) : this.renderApplication(input);
    const content = withHeader(body);
    const artifact: StackArtifact = {
      format: SWARM_ARTIFACT_FORMAT,
      role: input.ref.role,
      content,
      helm: [],
      diagnostics: [],
      digest: sha256Hex(`${content}\n${canonicalJson([])}`),
    };
    this.renders.set(key, artifact);
    return artifact;
  }

  private renderApplication(input: StackDeployInput): string {
    const compose = Compose.loadFromString(Compose.serialize(input.compose));
    Compose.stripBuildSections(compose);
    Compose.injectSwarmDefaults(compose);
    if (input.proxy?.enabled) {
      Compose.injectTraefikLabels(compose, input.proxy, stackNameOf(input.ref), input.ref.env);
    }
    return Compose.serialize(compose);
  }

  async deploy(input: StackDeployInput): Promise<Result<DeployReceipt, DeployError>> {
    const startedAt = new Date(this.clock.now());
    try {
      const artifact = this.render(input);
      const scope = this.naming.scope(input.ref);
      const onStarted = (): void => input.onApplyProgress?.({ kind: 'started' });
      const stackName = stackNameOf(input.ref);

      if (
        input.ref.role === 'accessory' &&
        !input.force &&
        (await this.ops.readAccessoriesHash(stackName)) === artifact.digest
      ) {
        return ok(this.receipt(input, artifact, startedAt, true));
      }

      // always from the full compose: a filtered deploy may still need them
      await this.ops.createExternalResources(
        Compose.getExternalNetworks(input.compose),
        Compose.getExternalVolumes(input.compose),
      );

      if (input.ref.role === 'accessory') {
        printInfo('Deploying accessories...');
        await this.ops.pullImages(artifact.content);
        await this.ops.deployStack(scope, artifact.content, { prune: true, withRegistryAuth: true, onStarted });
        const receipt = this.receipt(input, artifact, startedAt, false);
        this.pendingHashes.set(receipt, { stackName, hash: artifact.digest });
        return ok(receipt);
      }

      // `--only`: the other services keep running what they run, so nothing is pruned
      const filter = activeFilter(input.services);
      const content = filter ? filteredContent(artifact.content, filter) : artifact.content;
      await this.ops.deployStack(scope, content, { prune: filter === null, withRegistryAuth: true, onStarted });
      return ok(this.receipt(input, artifact, startedAt, false));
    } catch (error) {
      return err(toDeployError(error));
    }
  }

  private receipt(input: StackDeployInput, artifact: StackArtifact, startedAt: Date, skipped: boolean): DeployReceipt {
    return {
      ref: input.ref,
      version: input.version,
      startedAt,
      services: input.services,
      skipped,
      artifactDigest: artifact.digest,
      changes: [],
      helm: [],
      helmChanges: [],
      helmDeclared: input.helmDeclared,
      previousVersion: input.previousVersion,
    };
  }

  async apply(
    ref: StackRef,
    version: string,
    artifact: StackArtifact,
    options: ApplyOptions,
  ): Promise<Result<DeployReceipt, DeployError>> {
    const startedAt = new Date(this.clock.now());
    if (artifact.format !== SWARM_ARTIFACT_FORMAT) {
      return err(
        new DeployError(
          `Release ${version} was produced for ${artifact.format} and cannot be applied with orchestrator: swarm`,
          ErrorCode.ROLLBACK_FAILED,
        ),
      );
    }
    try {
      const filter = activeFilter(options.services);
      const content = filter ? filteredContent(artifact.content, filter) : artifact.content;
      await this.ops.deployStack(this.naming.scope(ref), content, {
        prune: options.prune && filter === null,
        withRegistryAuth: true,
      });
      return ok({
        ref,
        version,
        startedAt,
        services: options.services,
        skipped: false,
        artifactDigest: artifact.digest,
        changes: [],
        helm: [],
        helmChanges: [],
        helmDeclared: [],
        previousVersion: null,
      });
    } catch (error) {
      return err(toDeployError(error));
    }
  }

  /** Today's wait; a Swarm rollback maps to `reverted`. Never throws. */
  async waitConvergence(receipt: DeployReceipt, options: WaitOptions): Promise<ConvergenceResult> {
    const scope = this.naming.scope(receipt.ref);
    try {
      const outcome = await this.ops.waitConvergence(scope, {
        timeoutS: options.timeoutS,
        intervalS: options.intervalS,
        context: receipt.ref.role === 'accessory' ? 'accessories' : 'deployment',
        servicesFilter: activeFilter(receipt.services),
      });
      if (outcome.status === 'converged') return { status: 'converged', failures: [] };
      return {
        status: outcome.status,
        failures: outcome.services.map((problem) => this.failureOf(scope, problem)),
        message: outcome.message,
        suggestion: outcome.suggestion,
      };
    } catch (error) {
      return { status: 'failed', failures: [], message: errorText(error) };
    }
  }

  private failureOf(scope: string, problem: SwarmServiceProblem): ServiceFailure {
    return { service: composeNameOf(scope, problem.nativeName), reason: problem.reason, message: problem.detail };
  }

  /**
   * Every running task must be Running and no service may have been rolled back since the deploy
   * started; a `rollback_completed` older than the deploy belongs to an earlier one. Never throws.
   */
  async checkHealth(receipt: DeployReceipt, options: HealthOptions): Promise<InternalHealthResult> {
    const scope = this.naming.scope(receipt.ref);
    const filter = activeFilter(receipt.services);
    const deadline = this.clock.now() + options.timeoutS * 1000;
    const spinner = createTimedSpinner();
    spinner.start(`Checking Swarm health (timeout: ${options.timeoutS}s)...`);

    let lastUnhealthy: string[] = [];
    try {
      while (this.clock.now() < deadline) {
        const result = await this.pollHealth(scope, filter, receipt.startedAt);

        if (result.rolledBack.length > 0) {
          const message = `Swarm auto-rolled back: ${result.rolledBack.join(', ')}`;
          spinner.fail(message);
          return {
            healthy: false,
            rolledBack: true,
            failures: result.rolledBack.map((nativeName) =>
              this.failureOf(scope, { nativeName, reason: 'TaskFailed', detail: `Swarm rolled back ${nativeName}` }),
            ),
            message,
          };
        }

        if (result.unhealthy.length === 0) {
          spinner.succeed(`All services healthy: ${result.healthy.join(', ')}`);
          return { healthy: true, rolledBack: false, failures: [] };
        }

        lastUnhealthy = result.unhealthy;
        printDebug(`Health: healthy=[${result.healthy.join(', ')}] unhealthy=[${result.unhealthy.join(', ')}]`);
        spinner.update(`Checking Swarm health: ${result.unhealthy.length} unhealthy`);
        await this.clock.sleep(options.intervalS * 1000);
      }
    } catch (error) {
      const message = errorText(error);
      spinner.fail(message);
      return { healthy: false, rolledBack: false, failures: [], message };
    }

    spinner.fail(`Health check timeout after ${options.timeoutS}s`);
    if (lastUnhealthy.length === 0) return { healthy: true, rolledBack: false, failures: [] };
    return {
      healthy: false,
      rolledBack: false,
      failures: lastUnhealthy.map((nativeName) =>
        this.failureOf(scope, {
          nativeName,
          reason: 'Timeout',
          detail: `${nativeName} did not become healthy within ${options.timeoutS}s`,
        }),
      ),
      message: `Health check timeout after ${options.timeoutS}s. Unhealthy services: ${lastUnhealthy.join(', ')}`,
    };
  }

  private async pollHealth(
    scope: string,
    filter: string[] | null,
    deployStartedAt: Date,
  ): Promise<{ healthy: string[]; unhealthy: string[]; rolledBack: string[] }> {
    const listed = await this.ops.run(`docker stack services ${q(scope)} --format '{{.Name}}' 2>/dev/null || echo ""`);
    let services = listed.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (filter) {
      const wanted = new Set(filter.map((service) => `${scope}_${service}`));
      services = services.filter((service) => wanted.has(service));
    }

    const results = await Promise.all(services.map((service) => this.serviceHealth(service, deployStartedAt)));
    const healthy: string[] = [];
    const unhealthy: string[] = [];
    const rolledBack: string[] = [];
    for (const { name, status } of results) {
      if (status === 'healthy') healthy.push(name);
      else if (status === 'rolled_back') rolledBack.push(name);
      else unhealthy.push(name);
    }
    return { healthy, unhealthy, rolledBack };
  }

  private async serviceHealth(
    nativeName: string,
    deployStartedAt: Date,
  ): Promise<{ name: string; status: 'healthy' | 'unhealthy' | 'rolled_back' }> {
    const inspected = await this.ops.run(
      `docker service inspect ${q(nativeName)} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}|{{.UpdateStatus.CompletedAt}}{{end}}' 2>/dev/null`,
    );
    const raw = inspected.stdout.trim();
    if (raw) {
      const [state = '', completedAtText = ''] = raw.split('|');
      const updateState = state.trim().toLowerCase();
      if (updateState === 'rollback_started') return { name: nativeName, status: 'rolled_back' };
      if (updateState === 'rollback_completed') {
        const completedAt = completedAtText.trim() ? new Date(completedAtText.trim()) : null;
        if (!completedAt || Number.isNaN(completedAt.getTime()) || completedAt >= deployStartedAt) {
          return { name: nativeName, status: 'rolled_back' };
        }
      }
    }

    const tasks = await this.ops.run(runningTaskStatesCommand(nativeName));
    const states = tasks.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    if (states.length === 0) return { name: nativeName, status: 'unhealthy' };
    const allRunning = states.every((state) => state.trim().toLowerCase().startsWith('running'));
    return { name: nativeName, status: allRunning ? 'healthy' : 'unhealthy' };
  }

  /** Swarm reverts a failed update itself (`failure_action: rollback`). */
  async revert(_receipt: DeployReceipt): Promise<RevertResult> {
    return { status: 'native', services: [] };
  }

  /**
   * Records the accessories hash of an accessories deploy, now that it converged. Receipts of an
   * application deploy or of `apply()` (rollbacks) have nothing to record, so no remote call is
   * made. Never throws.
   */
  async finalize(receipt: DeployReceipt): Promise<void> {
    const pending = this.pendingHashes.get(receipt);
    if (!pending) return;
    this.pendingHashes.delete(receipt);
    try {
      await this.ops.writeAccessoriesHash(pending.stackName, pending.hash);
    } catch (error) {
      printWarning(`${errorText(error)}; the next deploy redeploys the accessories`);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async exists(ref: StackRef): Promise<boolean> {
    const scope = this.naming.scope(ref);
    const stdout = await runSwarmQuery(
      this.ssh,
      this.target.controlPlane,
      this.target.env,
      "docker stack ls --format '{{.Name}}'",
      'docker stack ls',
    );
    return (stdout ?? '').split('\n').some((line) => line.trim() === scope);
  }

  getServices(ref: StackRef): Promise<ServiceInfo[]> {
    return listSwarmServices(this.ssh, this.target.controlPlane, this.target.env, this.naming.scope(ref), ref.role);
  }

  listInstances(ref: StackRef, options: { service?: string; includeTerminated?: boolean } = {}): Promise<InstanceInfo[]> {
    return listSwarmInstances(this.ssh, this.target.controlPlane, this.target.env, this.naming.scope(ref), {
      service: options.service,
      includeTerminated: options.includeTerminated,
      nodeToServer: swarmNodeToServer(this.target),
    });
  }

  async diagnose(ref: StackRef, options: { verbose: boolean }): Promise<DiagnosticReport> {
    const facts: SwarmDiagnoseFacts = {
      env: this.target.env,
      role: ref.role,
      exists: await this.exists(ref),
      services: [],
      tasks: [],
      disk: null,
      memoryPercent: null,
    };
    if (!facts.exists) return buildSwarmDiagnosticReport(facts);

    const scope = this.naming.scope(ref);
    facts.services = await readSwarmServices(this.ssh, this.target.controlPlane, this.target.env, scope, ref.role);
    facts.tasks = await this.diagnoseTasks(scope);
    if (options.verbose) facts.events = await this.recentContainerDeaths();
    facts.disk = await this.diskUsage();
    facts.memoryPercent = await this.memoryUsage();
    return buildSwarmDiagnosticReport(facts);
  }

  /** Every task of the stack, history included, with the task name docker prints. */
  private async diagnoseTasks(scope: string): Promise<SwarmDiagnoseTask[]> {
    const stdout = await runSwarmQuery(
      this.ssh,
      this.target.controlPlane,
      this.target.env,
      stackPsCommand(scope, { includeTerminated: true }),
      'docker stack ps',
    );
    const tasks: SwarmDiagnoseTask[] = [];
    for (const line of (stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      const info = parseStackPsLine(line, scope);
      if (!info) continue;
      const name = (line.split('|')[1] ?? '').trim().replace(/^\\_\s*/, '');
      tasks.push({ name, service: info.service, state: info.status, error: info.error });
    }
    return tasks;
  }

  private async recentContainerDeaths(): Promise<string | null> {
    try {
      const result = await this.ops.run(
        `docker events --since 5m --until 0s --filter "type=container" --filter "event=die" --filter "event=oom" --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' 2>/dev/null | tail -10`,
      );
      return result.stdout;
    } catch {
      return null;
    }
  }

  private async diskUsage(): Promise<SwarmDiagnoseFacts['disk']> {
    try {
      const result = await this.ops.run(`df -h / | tail -1 | awk '{print $5}'`);
      const text = result.stdout.trim();
      const percent = Number.parseInt(text.replace('%', ''), 10);
      return Number.isNaN(percent) ? null : { text, percent };
    } catch {
      return null;
    }
  }

  private async memoryUsage(): Promise<number | null> {
    try {
      const result = await this.ops.run(`free -m | awk 'NR==2{printf "%.0f", $3*100/$2}'`);
      const percent = Number.parseInt(result.stdout.trim(), 10);
      return Number.isNaN(percent) ? null : percent;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** `docker service <verb> [--detach] ...`: without `--detach` docker waits for the service. */
  private serviceCommand(verb: string, options: ControlOptions, argument: string): string {
    return ['docker service', verb, ...(options.wait ? [] : ['--detach']), q(argument)].join(' ');
  }

  private async mutate(command: string, failure: string): Promise<void> {
    const result = await this.ops.run(command);
    if (result.exitCode !== 0) {
      throw new DeployError(result.stderr.trim() || failure, ErrorCode.DEPLOY_FAILED);
    }
  }

  async scale(ref: StackRef, service: string, replicas: number, options: ControlOptions): Promise<void> {
    const nativeName = this.naming.serviceNativeName(ref, service);
    await this.mutate(this.serviceCommand('scale', options, `${nativeName}=${replicas}`), `Failed to scale ${service}`);
  }

  async restart(ref: StackRef, service: string | null, options: ControlOptions): Promise<void> {
    if (service !== null) {
      const nativeName = this.naming.serviceNativeName(ref, service);
      await this.mutate(this.serviceCommand('update --force', options, nativeName), `Failed to restart ${service}`);
      return;
    }

    const scope = this.naming.scope(ref);
    const services = await readSwarmServices(this.ssh, this.target.controlPlane, this.target.env, scope, ref.role);
    if (services.length === 0) throw new DeployError('No services found', ErrorCode.STACK_NOT_FOUND);
    const command = services
      .map((info) => this.serviceCommand('update --force', options, info.nativeName))
      .join(' && ');
    await this.mutate(command, 'Some services failed to restart');
  }

  /** `docker service rollback` restores the previous spec without knowing its release. */
  async rollbackService(ref: StackRef, service: string, options: ControlOptions): Promise<{ toVersion: string | null }> {
    const nativeName = this.naming.serviceNativeName(ref, service);
    await this.mutate(this.serviceCommand('rollback', options, nativeName), `Failed to rollback ${service}`);
    return { toVersion: null };
  }

  /** Scales each service to 0, one at a time; failures are collected into one error. */
  async stop(ref: StackRef, services: string[] | null, options: ControlOptions): Promise<void> {
    const scope = this.naming.scope(ref);
    const names =
      services ??
      (await readSwarmServices(this.ssh, this.target.controlPlane, this.target.env, scope, ref.role)).map(
        (info) => info.name,
      );
    const failures: string[] = [];
    for (const name of names) {
      const nativeName = this.naming.serviceNativeName(ref, name);
      const result = await this.ops.run(this.serviceCommand('scale', options, `${nativeName}=0`));
      if (result.exitCode !== 0) failures.push(`${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    if (failures.length > 0) {
      throw new DeployError(`Some services failed to stop: ${failures.join('; ')}`, ErrorCode.DEPLOY_FAILED);
    }
  }

  /**
   * Removes the role's stack. Volumes go only with `delete`. Removing the accessories also
   * forgets their hash, otherwise the next deploy would skip them as unchanged.
   */
  async remove(ref: StackRef, options: { volumes: 'retain' | 'delete' }): Promise<void> {
    const scope = this.naming.scope(ref);
    if (ref.role === 'accessory') await this.ops.removeStackAndDrain(scope);
    else await this.ops.removeStackAndWait(scope);

    if (options.volumes === 'delete') await this.ops.removeStackVolumes(scope);
    if (ref.role === 'accessory') await this.ops.clearAccessoriesHash(stackNameOf(ref));
  }
}
