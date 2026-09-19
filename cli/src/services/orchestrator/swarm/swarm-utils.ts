/**
 * Shared Swarm helpers (design-06 7.1): the SSH seam every Swarm read backend goes through,
 * container lookup raced over the nodes, the query error mapping, and the parsers of
 * `docker stack ps`, `docker stack services` and `docker stats` output.
 */

import { StringDecoder } from 'string_decoder';
import type { Readable, Writable } from 'stream';
import type { SSHKeyConnection } from '../../../types';
import { OrchestratorUnavailableError } from '../../../utils/errors';
import { printDebug } from '../../../utils/output';
import {
  executeInteractiveSSH,
  SSHExitStatusError,
  shellQuote,
  sshExec,
  sshExecChannelUnbuffered,
} from '../../../utils/ssh';
import type {
  ClusterNodeRef,
  ContainerStats,
  InstanceInfo,
  OrchestratorTarget,
  PortInfo,
  ServiceInfo,
  StackRole,
} from '../interfaces';
import { swarmServiceName } from './swarm-naming';

// ---------------------------------------------------------------------------
// SSH seam
// ---------------------------------------------------------------------------

export interface SwarmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** An exec channel whose streams the caller drives; the caller must read both outputs. */
export interface SwarmChannel {
  /** remote stdin; the caller ends it to send EOF */
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** remote exit status; rejects when the connection is lost before one arrived */
  done: Promise<{ exitCode: number }>;
  /** closes the channel; `done` then resolves with SWARM_NO_EXIT_CODE when no status came */
  close(): void;
}

/** Everything the Swarm read backends run remotely goes through this, so tests script it. */
export interface SwarmSsh {
  /** one command with collected output; a lost connection rejects */
  exec(node: ClusterNodeRef, command: string): Promise<SwarmExecResult>;
  channel(node: ClusterNodeRef, command: string): Promise<SwarmChannel>;
  /** PTY session on a dedicated connection; resolves with the remote exit code */
  interactive(node: ClusterNodeRef, command: string): Promise<number>;
}

export const SWARM_NO_EXIT_CODE = -1;

async function openChannel(node: ClusterNodeRef, command: string): Promise<SwarmChannel> {
  const { stream, done: status } = await sshExecChannelUnbuffered(node.connection, command);
  let closedLocally = false;
  const done = status.catch((error: unknown) => {
    if (closedLocally && error instanceof SSHExitStatusError) return { exitCode: SWARM_NO_EXIT_CODE };
    throw error;
  });
  // a caller that abandons the channel must not turn a lost connection into an unhandled rejection
  done.catch(() => {});
  return {
    stdin: stream,
    stdout: stream,
    stderr: stream.stderr,
    done,
    close: () => {
      closedLocally = true;
      stream.close();
    },
  };
}

export const swarmSsh: SwarmSsh = {
  async exec(node, command) {
    const result = await sshExec(node.connection, command, { requireExitStatus: true });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },
  channel: openChannel,
  interactive: (node, command) => executeInteractiveSSH(node.connection, command),
};

/** Resolves once `stream` delivered its last chunk (or failed); never rejects. */
export function endOf(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', finish);
      resolve();
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

/** Text of a channel output, decoded across chunk boundaries. */
export function onText(stream: Readable, handler: (text: string) => void): void {
  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk)
      ? decoder.write(chunk)
      : chunk instanceof Uint8Array
        ? decoder.write(Buffer.from(chunk))
        : String(chunk);
    if (text) handler(text);
  });
  stream.on('end', () => {
    const rest = decoder.end();
    if (rest) handler(rest);
  });
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** first non-empty line, for error messages */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Control plane first, then managers and workers, one entry per SSH endpoint. */
export function swarmNodes(target: OrchestratorTarget): ClusterNodeRef[] {
  const seen = new Set<string>();
  const nodes: ClusterNodeRef[] = [];
  for (const node of [target.controlPlane, ...target.managers, ...target.workers]) {
    const key = `${node.connection.host}:${node.connection.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }
  return nodes;
}

/**
 * Swarm node hostname -> servers.yml key. A hostname maps when it equals a server key or its SSH
 * host; `setup` does not rename hosts, so an unmapped hostname is shown as Docker reports it.
 */
export function swarmNodeToServer(target: OrchestratorTarget): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of [target.controlPlane, ...target.managers, ...target.workers]) {
    if (!map.has(node.host)) map.set(node.host, node.name);
  }
  for (const node of [target.controlPlane, ...target.managers, ...target.workers]) map.set(node.name, node.name);
  return map;
}

// ---------------------------------------------------------------------------
// Queries and their errors
// ---------------------------------------------------------------------------

const NOTHING_FOUND = /nothing found in stack/i;

function checkDockerSuggestion(node: ClusterNodeRef, env: string): string {
  return `Check Docker on ${node.name} with \`dockflow ssh ${env}\`.`;
}

/** A failed docker read as the `OrchestratorUnavailableError` of design-06 7.1. */
export function swarmQueryError(
  node: ClusterNodeRef,
  env: string,
  result: SwarmExecResult,
  what: string,
): OrchestratorUnavailableError {
  const text = `${result.stderr}\n${result.stdout}`;
  const suggestion = checkDockerSuggestion(node, env);
  if (/Cannot connect to the Docker daemon/i.test(text)) {
    return new OrchestratorUnavailableError(`Docker is not running on ${node.name}`, suggestion);
  }
  if (result.exitCode === 127 || /docker: (command )?not found/i.test(text)) {
    return new OrchestratorUnavailableError(`Docker is not installed on ${node.name}`, suggestion);
  }
  if (/not a swarm manager/i.test(text)) {
    return new OrchestratorUnavailableError(`${node.name} is not a Swarm manager`, suggestion);
  }
  if (/permission denied.*docker/i.test(text)) {
    return new OrchestratorUnavailableError(`The SSH user of ${node.name} is not allowed to use Docker`, suggestion);
  }
  const detail = firstLine(text) || `exit ${result.exitCode}`;
  return new OrchestratorUnavailableError(`${what} failed on ${node.name}: ${detail}`, suggestion);
}

export function swarmTransportError(node: ClusterNodeRef, env: string, error: unknown): OrchestratorUnavailableError {
  return new OrchestratorUnavailableError(
    `${node.name} did not answer over SSH: ${errorText(error)}`,
    checkDockerSuggestion(node, env),
    error instanceof Error ? error : undefined,
  );
}

/** Runs a read-only docker command; `null` when docker says the stack holds nothing. */
export async function runSwarmQuery(
  ssh: SwarmSsh,
  node: ClusterNodeRef,
  env: string,
  command: string,
  what: string,
): Promise<string | null> {
  let result: SwarmExecResult;
  try {
    result = await ssh.exec(node, command);
  } catch (error) {
    throw swarmTransportError(node, env, error);
  }
  if (NOTHING_FOUND.test(result.stderr) || NOTHING_FOUND.test(result.stdout)) return null;
  if (result.exitCode !== 0) throw swarmQueryError(node, env, result, what);
  return result.stdout;
}

function outputLines(stdout: string | null): string[] {
  if (stdout === null) return [];
  return stdout.split('\n').filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Container lookup
// ---------------------------------------------------------------------------

export interface LocatedContainer {
  containerId: string;
  node: ClusterNodeRef;
}

function containerSearchCommand(labelFilter: string, includeStopped: boolean): string {
  const all = includeStopped ? ' -a' : '';
  return `docker ps${all} --filter ${shellQuote(labelFilter)} --format '{{.ID}}' | head -n1`;
}

/** Races every node for the first container matching `labelFilter`; a node that fails is skipped. */
async function raceContainerSearch<N>(
  nodes: readonly N[],
  run: (node: N, command: string) => Promise<{ stdout: string }>,
  labelFilter: string,
  includeStopped: boolean,
): Promise<{ containerId: string; node: N } | null> {
  const command = containerSearchCommand(labelFilter, includeStopped);
  const searches = nodes.map(async (node) => {
    const result = await run(node, command);
    const containerId = result.stdout.trim();
    if (!containerId) throw new Error('not found');
    return { containerId, node };
  });
  if (searches.length === 0) return null;
  try {
    return await Promise.any(searches);
  } catch {
    return null;
  }
}

/** A running container of the Swarm service `nativeName` (`<stack>_<svc>`), on any node. */
export function locateServiceContainer(
  ssh: SwarmSsh,
  nodes: readonly ClusterNodeRef[],
  nativeName: string,
): Promise<LocatedContainer | null> {
  return raceContainerSearch(nodes, (node, command) => ssh.exec(node, command), `label=com.docker.swarm.service.name=${nativeName}`, false);
}

/** The container (stopped ones included) behind one Swarm task, on any node. */
export function locateTaskContainer(
  ssh: SwarmSsh,
  nodes: readonly ClusterNodeRef[],
  taskId: string,
): Promise<LocatedContainer | null> {
  return raceContainerSearch(nodes, (node, command) => ssh.exec(node, command), `label=com.docker.swarm.task.id=${taskId}`, true);
}

function qualifyServiceName(stackName: string, serviceName: string): string {
  return serviceName.includes('_') ? serviceName : swarmServiceName(stackName, serviceName);
}

async function legacySearch(
  labelFilter: string,
  conns: SSHKeyConnection[],
  includeStopped: boolean,
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  const seen = new Set<string>();
  const unique = conns.filter((c) => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found = await raceContainerSearch(unique, (connection, command) => sshExec(connection, command), labelFilter, includeStopped);
  if (!found) {
    printDebug(`Container not found for ${labelFilter}`);
    return null;
  }
  return { containerId: found.containerId, connection: found.node };
}

/** Connection-based lookup kept for callers that do not hold an Orchestrator bundle. */
export function findContainerForTask(
  taskId: string,
  conns: SSHKeyConnection[],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  return legacySearch(`label=com.docker.swarm.task.id=${taskId}`, conns, true);
}

/** Connection-based lookup kept for callers that do not hold an Orchestrator bundle. */
export function findSwarmContainer(
  stackName: string,
  serviceName: string,
  conn: SSHKeyConnection,
  allConnections: SSHKeyConnection[] = [],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  return legacySearch(
    `label=com.docker.swarm.service.name=${qualifyServiceName(stackName, serviceName)}`,
    [conn, ...allConnections],
    false,
  );
}

// ---------------------------------------------------------------------------
// docker stack ps -> InstanceInfo
// ---------------------------------------------------------------------------

export const STACK_PS_FORMAT = '{{.ID}}|{{.Name}}|{{.Image}}|{{.Node}}|{{.DesiredState}}|{{.CurrentState}}|{{.Error}}';

const STACK_PS_FIELDS = 7;

export interface InstanceQueryOptions {
  service?: string;
  includeTerminated?: boolean;
}

/** `docker stack ps`; the name filter is a prefix filter, so rows are filtered again after parsing. */
export function stackPsCommand(scope: string, options: InstanceQueryOptions = {}): string {
  const parts = ['docker stack ps', shellQuote(scope), '--no-trunc'];
  if (!options.includeTerminated) parts.push('--filter', shellQuote('desired-state=running'));
  if (options.service !== undefined) parts.push('--filter', shellQuote(`name=${swarmServiceName(scope, options.service)}`));
  parts.push('--format', shellQuote(STACK_PS_FORMAT));
  return parts.join(' ');
}

/**
 * `<stack>_<svc>.<slot>` -> service and slot. Service names may contain dots, so the slot is the
 * last segment; a global task's slot is its node id.
 */
export function splitTaskName(name: string, scope: string): { service: string; slot: string } | null {
  const prefix = `${scope}_`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { service: rest.slice(0, dot), slot: rest.slice(dot + 1) };
}

/** `web.2`; a global task's node id is cut to the 12 characters docker itself shows. */
export function taskLabel(service: string, slot: string): string {
  return /^\d+$/.test(slot) ? `${service}.${slot}` : `${service}.${slot.slice(0, 12)}`;
}

function unquote(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function taskSeverity(currentState: string): InstanceInfo['severity'] {
  if (/^running\b/i.test(currentState)) return 'ok';
  if (isFailedTaskState(currentState)) return 'error';
  return 'warning';
}

/** A task that will not come up on its own, as opposed to one still converging. */
export function isFailedTaskState(currentState: string): boolean {
  return /^(failed|rejected)\b/i.test(currentState.trim());
}

/**
 * One `docker stack ps` row (STACK_PS_FORMAT). Swarm reports neither restarts nor a start time
 * per task, so both are null (printed `-`), never a fabricated 0.
 */
export function parseStackPsLine(line: string, scope: string, nodeToServer?: ReadonlyMap<string, string>): InstanceInfo | null {
  const parts = line.trim().split('|');
  if (parts.length < STACK_PS_FIELDS) return null;
  const [id, rawName, , rawNode, desiredState, currentState] = parts.map((part) => part.trim());
  // the table format indents history rows with ` \_ `; a custom format should not, but be lenient
  const name = rawName.replace(/^\\_\s*/, '');
  const task = splitTaskName(name, scope);
  if (!id || !task) return null;
  const error = unquote(parts.slice(STACK_PS_FIELDS - 1).join('|').trim());
  const node = rawNode ? (nodeToServer?.get(rawNode) ?? rawNode) : null;
  return {
    id,
    label: taskLabel(task.service, task.slot),
    service: task.service,
    node,
    status: currentState,
    severity: taskSeverity(currentState),
    ready: /^running\b/i.test(currentState),
    restarts: null,
    current: desiredState.toLowerCase() === 'running',
    startedAt: null,
    error: error === '' ? null : error,
    containers: [],
  };
}

/** Rows of one `docker stack ps` output, filtered exactly on `service` when given. */
export function parseStackPsOutput(
  stdout: string,
  scope: string,
  options: { service?: string; nodeToServer?: ReadonlyMap<string, string> } = {},
): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  for (const line of outputLines(stdout)) {
    const info = parseStackPsLine(line, scope, options.nodeToServer);
    if (!info) continue;
    if (options.service !== undefined && info.service !== options.service) continue;
    out.push(info);
  }
  return out;
}

/** `StackBackend.listInstances` on Swarm: tasks of every node, read on the control plane. */
export async function listSwarmInstances(
  ssh: SwarmSsh,
  controlPlane: ClusterNodeRef,
  env: string,
  scope: string,
  options: InstanceQueryOptions & { nodeToServer?: ReadonlyMap<string, string> } = {},
): Promise<InstanceInfo[]> {
  const stdout = await runSwarmQuery(ssh, controlPlane, env, stackPsCommand(scope, options), 'docker stack ps');
  if (stdout === null) return [];
  return parseStackPsOutput(stdout, scope, { service: options.service, nodeToServer: options.nodeToServer });
}

// ---------------------------------------------------------------------------
// docker stack services -> ServiceInfo
// ---------------------------------------------------------------------------

export const STACK_SERVICES_FORMAT = '{{.Name}}|{{.Mode}}|{{.Image}}|{{.Replicas}}|{{.Ports}}';

export function stackServicesCommand(scope: string): string {
  return `docker stack services ${shellQuote(scope)} --format ${shellQuote(STACK_SERVICES_FORMAT)}`;
}

function serviceMode(text: string): ServiceInfo['mode'] {
  if (/job/i.test(text)) return 'job';
  return /global/i.test(text) ? 'global' : 'replicated';
}

/**
 * `2/3`, `3/3` (global), `1/2 (max 1 per node)`; a job's `0/1 (1/1 completed)` counts completed
 * tasks against the total, so a finished job reads 1/1.
 */
export function parseSwarmReplicas(text: string, mode: ServiceInfo['mode']): ServiceInfo['replicas'] {
  if (mode === 'job') {
    const completed = /\((\d+)\/(\d+) completed\)/.exec(text);
    if (completed) return { running: Number(completed[1]), desired: Number(completed[2]) };
  }
  const counts = /^\s*(\d+)\/(\d+)/.exec(text);
  if (!counts) return { running: 0, desired: 0 };
  return { running: Number(counts[1]), desired: Number(counts[2]) };
}

const PORT_TOKEN = /^(?:\*:(\d+)(?:-(\d+))?->)?(\d+)(?:-(\d+))?\/(tcp|udp|sctp)$/i;

function portRange(first: string, last: string | undefined): [number, number] {
  const start = Number(first);
  return [start, last === undefined ? start : Number(last)];
}

/**
 * Inverse of `formatPorts` on docker's `{{.Ports}}` text: `*:8080->80/tcp` (ingress),
 * `*:30000-30002->30000-30002/tcp` expanded port by port, `5432/tcp` (not published).
 */
export function parseSwarmPorts(text: string): PortInfo[] {
  const ports: PortInfo[] = [];
  for (const token of text.split(',')) {
    const match = PORT_TOKEN.exec(token.trim());
    if (!match) continue;
    const protocol = match[5].toLowerCase() as PortInfo['protocol'];
    const [targetStart, targetEnd] = portRange(match[3], match[4]);
    if (targetEnd < targetStart) continue;
    if (match[1] === undefined) {
      for (let target = targetStart; target <= targetEnd; target++) {
        ports.push({ target, published: null, protocol, mode: 'cluster' });
      }
      continue;
    }
    const [publishedStart, publishedEnd] = portRange(match[1], match[2]);
    if (publishedEnd < publishedStart) continue;
    const count = Math.max(publishedEnd - publishedStart, targetEnd - targetStart) + 1;
    for (let i = 0; i < count; i++) {
      ports.push({
        target: Math.min(targetStart + i, targetEnd),
        published: Math.min(publishedStart + i, publishedEnd),
        protocol,
        mode: 'ingress',
      });
    }
  }
  return ports;
}

/**
 * `stopped` when nothing is desired, `running` once every replica runs; otherwise the running
 * tasks decide: a failed or rejected one is `degraded`, anything else still `converging`.
 * `taskStates` null: not inspected yet.
 */
export function swarmServiceState(
  replicas: ServiceInfo['replicas'],
  taskStates: readonly string[] | null,
): ServiceInfo['state'] {
  if (replicas.desired === 0) return 'stopped';
  if (replicas.running >= replicas.desired) return 'running';
  if (taskStates === null) return 'converging';
  return taskStates.some(isFailedTaskState) ? 'degraded' : 'converging';
}

/** One `docker stack services` row (STACK_SERVICES_FORMAT); `state` still needs the task check. */
export function parseStackServicesLine(line: string, scope: string, role: StackRole): ServiceInfo | null {
  const parts = line.trim().split('|');
  if (parts.length < 5) return null;
  const [nativeName, modeText, image, replicasText] = parts.map((part) => part.trim());
  if (!nativeName) return null;
  const prefix = `${scope}_`;
  const name = nativeName.startsWith(prefix) ? nativeName.slice(prefix.length) : nativeName;
  const mode = serviceMode(modeText);
  const replicas = parseSwarmReplicas(replicasText, mode);
  return {
    name,
    nativeName,
    kind: 'service',
    role,
    mode,
    image,
    replicas,
    ports: parseSwarmPorts(parts.slice(4).join('|')),
    state: swarmServiceState(replicas, null),
  };
}

/** Services of a stack as docker lists them, without the task check. */
export async function readSwarmServices(
  ssh: SwarmSsh,
  controlPlane: ClusterNodeRef,
  env: string,
  scope: string,
  role: StackRole,
): Promise<ServiceInfo[]> {
  const stdout = await runSwarmQuery(ssh, controlPlane, env, stackServicesCommand(scope), 'docker stack services');
  const services: ServiceInfo[] = [];
  for (const line of outputLines(stdout)) {
    const info = parseStackServicesLine(line, scope, role);
    if (info) services.push(info);
  }
  return services;
}

export function runningTaskStatesCommand(nativeName: string): string {
  return `docker service ps ${shellQuote(nativeName)} --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null`;
}

/**
 * `StackBackend.getServices` on Swarm: a partial replica count is the normal shape of a service
 * still converging as much as of one crashing, so the running tasks of those services are read to
 * tell them apart (the API's logic before the rewrite).
 */
export async function listSwarmServices(
  ssh: SwarmSsh,
  controlPlane: ClusterNodeRef,
  env: string,
  scope: string,
  role: StackRole,
): Promise<ServiceInfo[]> {
  const services = await readSwarmServices(ssh, controlPlane, env, scope, role);
  await Promise.all(
    services
      .filter((service) => service.state === 'converging')
      .map(async (service) => {
        let states: string[] = [];
        try {
          const result = await ssh.exec(controlPlane, runningTaskStatesCommand(service.nativeName));
          states = outputLines(result.stdout);
        } catch (error) {
          throw swarmTransportError(controlPlane, env, error);
        }
        service.state = swarmServiceState(service.replicas, states);
      }),
  );
  return services;
}

// ---------------------------------------------------------------------------
// docker stats -> ContainerStats
// ---------------------------------------------------------------------------

/** Every container of the stack on the node; `docker stats` without ids would read them all. */
export function dockerStatsCommand(scope: string): string {
  const filter = shellQuote(`label=com.docker.stack.namespace=${scope}`);
  return `ids=$(docker ps -q --filter ${filter}); [ -z "$ids" ] || docker stats --no-stream --format '{{json .}}' $ids`;
}

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/** `45.2MiB`, `1.2kB`, `0B` -> bytes; null when docker printed no figure (`--`). */
export function parseByteSize(text: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?i?b)$/i.exec(text.trim());
  if (!match) return null;
  const factor = BYTE_UNITS[match[2].toLowerCase()];
  return factor === undefined ? null : Math.round(Number(match[1]) * factor);
}

/** `1.23%` of one core -> 12.3 millicores */
function cpuMilliOf(text: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(text.trim());
  if (!match) return null;
  return Math.round(Number(match[1]) * 1000) / 100;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/** `<stack>_<svc>.<slot>.<task id>`: the task id and slot are the last two segments. */
export function splitContainerName(name: string, scope: string): { service: string; slot: string; taskId: string } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const task = splitTaskName(name.slice(0, dot), scope);
  if (!task) return null;
  return { service: task.service, slot: task.slot, taskId: name.slice(dot + 1) };
}

/** One `docker stats --format '{{json .}}'` row; null for containers of another stack. */
export function parseDockerStatsLine(
  line: string,
  context: { scope: string; role: StackRole; node: string | null },
): ContainerStats | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const name = stringField(record, 'Name');
  if (name === null) return null;
  const parsed = splitContainerName(name, context.scope);
  if (!parsed) return null;
  const [usage, limit] = (stringField(record, 'MemUsage') ?? '').split('/').map((part) => part.trim());
  const memoryLimitBytes = limit === undefined ? null : parseByteSize(limit);
  return {
    service: parsed.service,
    role: context.role,
    instance: parsed.taskId,
    container: name,
    node: context.node,
    cpuMilli: cpuMilliOf(stringField(record, 'CPUPerc') ?? ''),
    memoryBytes: usage ? parseByteSize(usage) : null,
    memoryLimitBytes: memoryLimitBytes === 0 ? null : memoryLimitBytes,
    netIO: stringField(record, 'NetIO'),
    blockIO: stringField(record, 'BlockIO'),
  };
}
