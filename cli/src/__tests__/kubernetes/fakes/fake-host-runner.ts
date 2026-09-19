// FakeHostRunner (design-07 3.12, design-05 R-S6-05): the HostRunner of every setup node-step test.
// An in-memory file system (content, mode, uid, gid), users and groups, an architecture; explicit
// argv-prefix steps first, then stock handlers for the host commands setup runs; an argv nothing
// answers fails the test with that argv. Every call is recorded as {argv, input, env}. `k3s kubectl`
// argv is forwarded to the FakeKubeExecutor bound to the node, so one cluster state serves both seams.

import { posix } from 'path';
import { DOWNLOAD_CACHE_DIR, K3S_BINARY } from '../../../commands/setup/k3s/constants';
import {
  COMMAND_NOT_FOUND_EXIT,
  type HostFileInfo,
  type HostRunner,
  type HostRunOptions,
  type HostRunResult,
  type HostUser,
  type HostWriteOptions,
} from '../../../commands/setup/k3s/host-runner';
import { HELM_BIN_PATH } from '../../../services/orchestrator/kubernetes/constants';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { sha256Hex } from '../../../utils/hash';
import type { FakeKubeExecutor } from './fake-kube-executor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HostArgMatcher = string | RegExp;

export interface HostCallContext {
  argv: string[];
  /** stdin as text ('' when none) */
  input: string;
  env: Readonly<Record<string, string>> | undefined;
  runner: FakeHostRunner;
}

export type HostRespond =
  | Partial<HostRunResult>
  | ((call: HostCallContext) => Partial<HostRunResult> | Promise<Partial<HostRunResult>>);

export interface HostStep {
  /** printed in failure messages */
  id?: string;
  /** matched against the start of the argv: strings equal, RegExp test */
  argv: HostArgMatcher[];
  respond: HostRespond;
  /** default 1 */
  times?: number | 'any';
  /** never required by assertDone() */
  optional?: boolean;
}

export interface RecordedHostCall {
  argv: string[];
  /** stdin as text ('' when none): exempt from INV-02, it is where secrets travel */
  input: string;
  /** what the caller added to the child environment */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** step id, `stock:<name>` or `kube` */
  handler: string;
  result?: HostRunResult;
}

export interface FakeEntry {
  type: 'file' | 'directory' | 'symlink';
  content: Buffer;
  mode: number;
  uid: number;
  gid: number;
  /** symlinks only */
  target?: string;
  mtimeMs: number;
}

export interface FakeUser extends HostUser {
  password?: string;
  passwordHash?: string;
}

export interface FakeServiceState {
  activeState: string;
  subState: string;
  nRestarts?: number;
  loadState?: string;
}

export interface FakeFirewalldZone {
  interfaces: Set<string>;
  sources: Set<string>;
  richRules: Set<string>;
  ports: Set<string>;
}

export interface FakeFirewalld {
  installed: boolean;
  running: boolean;
  defaultZone: string;
  zones: Map<string, FakeFirewalldZone>;
  ipsets: Map<string, Set<string>>;
  reloads: number;
}

export interface FakeUfw {
  installed: boolean;
  active: boolean;
  /** `ufw show added` lines, `ufw allow ...` form */
  added: string[];
}

export interface FakeHostRunnerOptions {
  /** receives `k3s kubectl ...` argv as KubectlCalls */
  kube?: FakeKubeExecutor;
  /** `uname -m`; default x86_64 */
  machine?: string;
  /** default 0 (the node step runs as root) */
  euid?: number;
  steps?: HostStep[];
  /** stock handlers; default true */
  stock?: boolean;
}

const FIXED_MTIME = Date.parse('2026-01-01T00:00:00Z');
/** what every Linux node has before setup touches it */
const BASE_DIRECTORIES: readonly string[] = [
  '/etc',
  '/etc/sudoers.d',
  '/etc/systemd/system',
  '/home',
  '/root',
  '/run',
  '/tmp',
  '/usr/local/bin',
  '/usr/local/lib',
  '/var/cache',
  '/var/lib',
];
const MUTATING_VERBS = new Set(['apply', 'create', 'replace', 'delete', 'scale', 'patch', 'label', 'annotate', 'cordon', 'uncordon', 'drain', 'taint']);
const UFW_HEADER = "Added user rules (see 'ufw status' for running firewall):";

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

function matches(matcher: HostArgMatcher, arg: string | undefined): boolean {
  if (arg === undefined) return false;
  return typeof matcher === 'string' ? matcher === arg : matcher.test(arg);
}

function result(partial: Partial<HostRunResult> = {}): HostRunResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

/** a fake `.tar.gz` for the tar stock handler: member path -> content */
export function fakeTarball(members: Readonly<Record<string, string>>): Buffer {
  return Buffer.from(JSON.stringify({ fakeTar: members }), 'utf8');
}

/** the content of a fake binary whose `--version` / `version` handler reads `version` back */
export function fakeBinary(name: string, version: string): Buffer {
  return Buffer.from(`#!fake ${name} ${version}\n`, 'utf8');
}

/** the argv line `ufw show added` prints for an `ufw allow` / `ufw delete allow` argument list */
export function ufwShowAddedLine(args: readonly string[], withComment = true): string {
  let proto: string | null = null;
  let from: string | null = null;
  let port: string | null = null;
  let iface: string | null = null;
  let comment: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'proto') proto = args[++i] ?? null;
    else if (arg === 'from') from = args[++i] ?? null;
    else if (arg === 'port') port = args[++i] ?? null;
    else if (arg === 'to') i++;
    else if (arg === 'in' && args[i + 1] === 'on') {
      iface = args[i + 2] ?? null;
      i += 2;
    } else if (arg === 'comment') comment = args[++i] ?? null;
  }
  let line: string;
  if (iface !== null) line = `ufw allow in on ${iface} from ${from ?? 'any'}${port ? ` to any port ${port} proto ${proto}` : ''}`;
  else if (from !== null && port !== null) line = `ufw allow from ${from} to any port ${port}${proto ? ` proto ${proto}` : ''}`;
  else if (port !== null) line = `ufw allow ${port}${proto ? `/${proto}` : ''}`;
  else line = `ufw allow from ${from ?? 'any'}`;
  return withComment && comment !== null ? `${line} comment '${comment}'` : line;
}

function withoutComment(line: string): string {
  return line.replace(/ comment '[^']*'$/, '');
}

// A small sudoers grammar: comments, aliases, Defaults and user specifications.
const SUDOERS_LINE = [
  /^Cmnd_Alias [A-Z][A-Z0-9_]* = \S.*$/,
  /^Defaults(![A-Z][A-Z0-9_]*)?\s+\S.*$/,
  /^[a-z_%][a-z0-9_-]* ALL=\((ALL|root)(:ALL)?\) (NOPASSWD: )?\S.*$/,
  /^#include(dir)? \S+$/,
];

/** '' when valid, otherwise the visudo-style error */
export function checkSudoersSyntax(path: string, content: string): string {
  const logical: { line: string; number: number }[] = [];
  let buffer = '';
  let start = 0;
  content.split('\n').forEach((raw, index) => {
    if (buffer === '') start = index + 1;
    if (raw.endsWith('\\')) {
      buffer += `${raw.slice(0, -1)} `;
      return;
    }
    logical.push({ line: `${buffer}${raw}`.trim(), number: start });
    buffer = '';
  });
  if (buffer !== '') return `${path}:${start}:1: syntax error (continuation at end of file)`;
  for (const { line, number } of logical) {
    if (line === '' || (line.startsWith('#') && !line.startsWith('#include'))) continue;
    if (!SUDOERS_LINE.some((shape) => shape.test(line))) return `${path}:${number}:1: syntax error`;
    // an unescaped `=` inside a command argument is a syntax error for sudo (F22)
    const commands = line.startsWith('Cmnd_Alias') ? line.slice(line.indexOf('=') + 1) : '';
    if (/(^|[^\\])=/.test(commands)) return `${path}:${number}:1: syntax error (unescaped = in a command)`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// FakeHostRunner
// ---------------------------------------------------------------------------

interface StepState {
  step: HostStep;
  used: number;
}

export class FakeHostRunner implements HostRunner {
  readonly calls: RecordedHostCall[] = [];
  /** argv nothing answered */
  readonly unexpected: string[] = [];
  readonly files = new Map<string, FakeEntry>();
  readonly users = new Map<string, FakeUser>();
  readonly groups = new Map<string, { gid: number; members: Set<string> }>();
  /** curl answers: bytes, or a failure */
  readonly urls = new Map<string, Uint8Array | { exitCode: number; stderr: string }>();
  /** successive `systemctl show` answers per unit; the last one sticks */
  readonly services = new Map<string, FakeServiceState[]>();
  /** `which` answers: command -> absolute path */
  readonly commands = new Map<string, string>();
  /** `journalctl -u <unit>` output */
  readonly journal = new Map<string, string>();
  readonly ufw: FakeUfw = { installed: false, active: false, added: [] };
  readonly firewalld: FakeFirewalld = {
    installed: false,
    running: false,
    defaultZone: 'public',
    zones: new Map(['public', 'trusted', 'internal'].map((zone) => [zone, FakeHostRunner.emptyZone()])),
    ipsets: new Map(),
    reloads: 0,
  };
  /** `ip -o -4 addr show` */
  interfaces: { name: string; address: string; prefix: number }[] = [{ name: 'eth0', address: '10.0.0.10', prefix: 24 }];
  defaultRouteInterface = 'eth0';
  /** `k3s secrets-encrypt status -o json` (design-05 9): secretbox enabled, keys in sync */
  encryptionStatus: unknown = { enable: true, stage: 'start', activekey: 'XSalsa20-POLY1305 secretbox-key', hashmatch: true };
  /** what `sh <install.sh>` answers */
  installScript: Partial<HostRunResult> = { exitCode: 0, stdout: '[INFO]  Skipping k3s download and verify\n' };
  /** `nginx -T` output */
  nginxConfig = 'user www-data;\nworker_processes auto;\n';
  suNeedsTerminal = false;
  setprivInstalled = true;
  /** a visudo verdict to force: path -> error text */
  readonly visudoRejects = new Map<string, string>();
  machineName: string;
  euid: number;
  private readonly kube: FakeKubeExecutor | undefined;
  private readonly steps: StepState[];
  private readonly stockEnabled: boolean;
  private done = false;
  private tempCounter = 0;
  private nextUid = 1000;

  constructor(options: FakeHostRunnerOptions = {}) {
    this.kube = options.kube;
    this.machineName = options.machine ?? 'x86_64';
    this.euid = options.euid ?? 0;
    this.stockEnabled = options.stock ?? true;
    this.steps = (options.steps ?? []).map((step) => ({ step, used: 0 }));
    this.files.set('/', { type: 'directory', content: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0, mtimeMs: FIXED_MTIME });
    for (const dir of BASE_DIRECTORIES) this.seedDir(dir, { mode: dir === '/tmp' ? 0o1777 : dir === '/etc/sudoers.d' ? 0o750 : 0o755 });
    this.users.set('root', { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' });
    this.groups.set('root', { gid: 0, members: new Set() });
  }

  static emptyZone(): FakeFirewalldZone {
    return { interfaces: new Set(), sources: new Set(), richRules: new Set(), ports: new Set() };
  }

  get asserted(): boolean {
    return this.done;
  }

  /** every required step used, no unanswered argv */
  assertDone(): void {
    this.done = true;
    const failures: string[] = [];
    for (const state of this.steps) {
      const times = state.step.times ?? 1;
      const required = state.step.optional || times === 'any' ? 0 : times;
      if (state.used < required) failures.push(`step ${state.step.id ?? state.step.argv.join(' ')} was used ${state.used} of ${required} time(s)`);
    }
    for (const argv of this.unexpected) failures.push(`unexpected command: ${argv}`);
    if (failures.length > 0) throw new Error(`FakeHostRunner:\n${failures.join('\n')}`);
  }

  /** adds an explicit step (answered before the stock handlers) */
  on(argv: HostArgMatcher[], respond: HostRespond, options: Omit<HostStep, 'argv' | 'respond'> = {}): this {
    this.steps.push({ step: { ...options, argv, respond }, used: 0 });
    return this;
  }

  /** argv of the recorded calls whose argv starts with `prefix` */
  commandsStartingWith(...prefix: string[]): string[][] {
    return this.calls.filter((call) => prefix.every((part, i) => call.argv[i] === part)).map((call) => call.argv);
  }

  // ---- seeding ----------------------------------------------------------------------------------

  seedDir(path: string, options: Partial<HostWriteOptions> = {}): this {
    this.ensureParents(path);
    this.files.set(this.norm(path), {
      type: 'directory',
      content: Buffer.alloc(0),
      mode: options.mode ?? 0o755,
      uid: options.uid ?? 0,
      gid: options.gid ?? 0,
      mtimeMs: FIXED_MTIME,
    });
    return this;
  }

  seedFile(path: string, content: string | Uint8Array, options: Partial<HostWriteOptions> = {}): this {
    this.ensureParents(path);
    this.files.set(this.norm(path), {
      type: 'file',
      content: toBuffer(content),
      mode: options.mode ?? 0o644,
      uid: options.uid ?? 0,
      gid: options.gid ?? 0,
      mtimeMs: FIXED_MTIME,
    });
    return this;
  }

  seedSymlink(path: string, target: string): this {
    this.ensureParents(path);
    this.files.set(this.norm(path), { type: 'symlink', content: Buffer.alloc(0), mode: 0o777, uid: 0, gid: 0, target, mtimeMs: FIXED_MTIME });
    return this;
  }

  /** the verified download cache of DESIGN-CORE 8.7, pre-seeded like the e2e images do */
  seedCache(content: string | Uint8Array): string {
    const bytes = toBuffer(content);
    const path = `${DOWNLOAD_CACHE_DIR}/${sha256Hex(bytes)}`;
    this.seedDir('/var/cache/dockflow', { mode: 0o700 }).seedDir(DOWNLOAD_CACHE_DIR, { mode: 0o700 });
    this.seedFile(path, bytes, { mode: 0o600 });
    return path;
  }

  addUser(name: string, options: { uid?: number; gid?: number; home?: string; password?: string } = {}): FakeUser {
    const uid = options.uid ?? this.nextUid++;
    const user: FakeUser = { name, uid, gid: options.gid ?? uid, home: options.home ?? `/home/${name}`, shell: '/bin/bash', password: options.password };
    this.users.set(name, user);
    if (!this.groups.has(name)) this.groups.set(name, { gid: user.gid, members: new Set() });
    if (!this.files.has(user.home)) this.seedDir(user.home, { mode: 0o750, uid: user.uid, gid: user.gid });
    return user;
  }

  addGroup(name: string, gid?: number): this {
    this.groups.set(name, { gid: gid ?? this.nextUid++, members: new Set() });
    return this;
  }

  text(path: string): string | null {
    const entry = this.files.get(this.norm(path));
    return entry?.type === 'file' ? entry.content.toString('utf8') : null;
  }

  // ---- HostRunner --------------------------------------------------------------------------------

  async run(argv: readonly string[], options: HostRunOptions = {}): Promise<HostRunResult> {
    const input = options.input === undefined ? '' : toBuffer(options.input).toString('utf8');
    const recorded: RecordedHostCall = {
      argv: [...argv],
      input,
      ...(options.env !== undefined ? { env: { ...options.env } } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      handler: '',
    };
    this.calls.push(recorded);
    const context: HostCallContext = { argv: [...argv], input, env: options.env, runner: this };
    const step = this.steps.find((state) => {
      const times = state.step.times ?? 1;
      return (times === 'any' || state.used < times) && state.step.argv.every((matcher, i) => matches(matcher, argv[i]));
    });
    let answer: HostRunResult | null;
    if (step !== undefined) {
      step.used += 1;
      recorded.handler = step.step.id ?? `step:${step.step.argv.join(' ')}`;
      const respond = step.step.respond;
      answer = result(typeof respond === 'function' ? await respond(context) : respond);
    } else if (argv[0] === K3S_BINARY && argv[1] === 'kubectl') {
      recorded.handler = 'kube';
      answer = await this.forwardKubectl([...argv], input);
    } else {
      answer = this.stockEnabled ? await this.stock(context, recorded) : null;
    }
    if (answer === null) {
      const line = argv.join(' ');
      this.unexpected.push(line);
      throw new Error(`Unexpected host command: ${line}`);
    }
    recorded.result = answer;
    return answer;
  }

  async readFile(path: string): Promise<Buffer | null> {
    const entry = this.resolve(path);
    if (entry === null) return null;
    if (entry.type === 'directory') throw fsError('EISDIR', `illegal operation on a directory, read '${path}'`);
    return Buffer.from(entry.content);
  }

  async writeFile(path: string, data: string | Uint8Array, options: HostWriteOptions): Promise<void> {
    this.requireParent(path);
    this.refuseSymlink(path);
    const existing = this.files.get(this.norm(path));
    if (existing?.type === 'directory') throw fsError('EISDIR', `illegal operation on a directory, open '${path}'`);
    this.files.set(this.norm(path), {
      type: 'file',
      content: toBuffer(data),
      mode: options.mode,
      uid: options.uid ?? existing?.uid ?? 0,
      gid: options.gid ?? existing?.gid ?? 0,
      mtimeMs: FIXED_MTIME,
    });
  }

  async createExclusive(path: string, data: string | Uint8Array, mode: number): Promise<boolean> {
    this.requireParent(path);
    if (this.files.has(this.norm(path))) return false;
    this.files.set(this.norm(path), { type: 'file', content: toBuffer(data), mode, uid: 0, gid: 0, mtimeMs: FIXED_MTIME });
    return true;
  }

  async stat(path: string): Promise<HostFileInfo | null> {
    const entry = this.files.get(this.norm(path));
    if (entry === undefined) return null;
    return { type: entry.type, mode: entry.mode, uid: entry.uid, gid: entry.gid, size: entry.content.length, mtimeMs: entry.mtimeMs };
  }

  async readLink(path: string): Promise<string | null> {
    const entry = this.files.get(this.norm(path));
    return entry?.type === 'symlink' ? (entry.target ?? null) : null;
  }

  async mkdir(path: string, options: HostWriteOptions): Promise<void> {
    const target = this.norm(path);
    this.refuseSymlink(target);
    const existing = this.files.get(target);
    if (existing !== undefined && existing.type !== 'directory') throw fsError('EEXIST', `file already exists, mkdir '${path}'`);
    this.ensureParents(target);
    this.files.set(target, {
      type: 'directory',
      content: Buffer.alloc(0),
      mode: options.mode,
      uid: options.uid ?? existing?.uid ?? 0,
      gid: options.gid ?? existing?.gid ?? 0,
      mtimeMs: FIXED_MTIME,
    });
  }

  async readDir(path: string): Promise<string[] | null> {
    const dir = this.norm(path);
    const entry = this.files.get(dir);
    if (entry?.type !== 'directory') return null;
    return this.children(dir).map((child) => posix.basename(child));
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.norm(from);
    const target = this.norm(to);
    const entry = this.files.get(source);
    if (entry === undefined) throw fsError('ENOENT', `no such file or directory, rename '${from}' -> '${to}'`);
    this.requireParent(target);
    const moved = [source, ...this.descendants(source)];
    for (const path of moved) {
      const item = this.files.get(path) as FakeEntry;
      this.files.delete(path);
      this.files.set(target + path.slice(source.length), item);
    }
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.norm(path);
    const entry = this.files.get(target);
    if (entry === undefined) return;
    const descendants = this.descendants(target);
    if (entry.type === 'directory' && descendants.length > 0 && !options.recursive) {
      throw fsError('ENOTEMPTY', `directory not empty, rmdir '${path}'`);
    }
    for (const child of descendants) this.files.delete(child);
    this.files.delete(target);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.refuseSymlink(path);
    this.entry(path).mode = mode;
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    this.refuseSymlink(path);
    const entry = this.entry(path);
    if (uid !== -1) entry.uid = uid;
    if (gid !== -1) entry.gid = gid;
  }

  async lookupUser(name: string): Promise<HostUser | null> {
    const user = this.users.get(name);
    return user === undefined ? null : { name: user.name, uid: user.uid, gid: user.gid, home: user.home, shell: user.shell };
  }

  effectiveUid(): number {
    return this.euid;
  }

  async machine(): Promise<string> {
    return this.machineName;
  }

  pid(): number {
    return 4242;
  }

  // ---- file system helpers -----------------------------------------------------------------------

  private norm(path: string): string {
    const normalized = posix.normalize(path);
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  }

  /** as the real runner: never write, chmod or chown through a symlink */
  private refuseSymlink(path: string): void {
    if (this.files.get(this.norm(path))?.type === 'symlink') throw fsError('ELOOP', `Refusing to follow the symbolic link ${path}`);
  }

  private entry(path: string): FakeEntry {
    const entry = this.files.get(this.norm(path));
    if (entry === undefined) throw fsError('ENOENT', `no such file or directory, '${path}'`);
    return entry;
  }

  private resolve(path: string): FakeEntry | null {
    let entry = this.files.get(this.norm(path));
    for (let hops = 0; entry?.type === 'symlink' && hops < 8; hops++) {
      const target = entry.target ?? '';
      entry = this.files.get(this.norm(target.startsWith('/') ? target : posix.join(posix.dirname(this.norm(path)), target)));
    }
    return entry === undefined || entry.type === 'symlink' ? null : entry;
  }

  private children(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.files.keys()].filter((path) => path !== dir && path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).sort();
  }

  private descendants(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.files.keys()].filter((path) => path !== dir && path.startsWith(prefix));
  }

  private requireParent(path: string): void {
    const parent = posix.dirname(this.norm(path));
    if (this.files.get(parent)?.type !== 'directory') throw fsError('ENOENT', `no such file or directory, open '${path}'`);
  }

  private ensureParents(path: string): void {
    const parts = this.norm(path).split('/').filter((part) => part.length > 0);
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      if (!this.files.has(current)) {
        this.files.set(current, { type: 'directory', content: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0, mtimeMs: FIXED_MTIME });
      }
    }
  }

  private idOf(name: string | undefined, kind: 'user' | 'group'): number | undefined {
    if (name === undefined) return undefined;
    if (/^\d+$/.test(name)) return Number(name);
    return kind === 'user' ? this.users.get(name)?.uid : this.groups.get(name)?.gid;
  }

  // ---- kubectl forwarding ------------------------------------------------------------------------

  private async forwardKubectl(argv: string[], input: string): Promise<HostRunResult | null> {
    if (this.kube === undefined) return null;
    let i = 2;
    let namespace: string | undefined;
    let requestTimeoutS: number | null = null;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg.startsWith('--kubeconfig=')) {
        i += 1;
      } else if (arg.startsWith('--request-timeout=')) {
        requestTimeoutS = Number(arg.slice('--request-timeout='.length).replace(/s$/, ''));
        i += 1;
      } else if (arg === '-n') {
        namespace = argv[i + 1];
        i += 2;
      } else {
        break;
      }
    }
    const args = argv.slice(i);
    const verb = args[0] ?? '';
    const mutating = MUTATING_VERBS.has(verb) || (verb === 'rollout' && (args[1] === 'undo' || args[1] === 'restart'));
    try {
      const answer = await this.kube.run({
        args,
        namespace,
        stdin: input === '' ? undefined : input,
        mutating,
        requestTimeoutS,
        allowFailure: true,
      });
      return result({ exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr });
    } catch (error) {
      if (!(error instanceof KubeError)) throw error;
      const timedOut = error.reason === 'Timeout';
      return result({ exitCode: timedOut ? 124 : 1, stderr: error.message, timedOut });
    }
  }

  // ---- stock handlers ----------------------------------------------------------------------------

  private async stock(context: HostCallContext, recorded: RecordedHostCall): Promise<HostRunResult | null> {
    const { argv } = context;
    const name = argv[0] ?? '';
    const handled = (id: string, answer: HostRunResult | null): HostRunResult | null => {
      if (answer !== null) recorded.handler = `stock:${id}`;
      return answer;
    };
    if (name === K3S_BINARY) return handled('k3s', this.k3s(argv));
    if (name === HELM_BIN_PATH) return handled('helm', this.helm(argv));
    if (name === '/usr/local/bin/k3s-uninstall.sh' || name === '/usr/local/bin/k3s-agent-uninstall.sh' || name === '/usr/local/bin/k3s-killall.sh') {
      return handled('k3s-scripts', await this.k3sScript(argv));
    }
    const nginx = this.commands.get('nginx');
    if (nginx !== undefined && name === nginx && argv[1] === '-T') return handled('nginx', result({ stdout: this.nginxConfig }));
    switch (name) {
      case 'sh':
        return handled('install.sh', this.installSh(context));
      case 'systemctl':
        return handled('systemctl', this.systemctl(argv));
      case 'journalctl':
        return handled('journalctl', result({ stdout: this.journal.get(argv[argv.indexOf('-u') + 1] ?? '') ?? '' }));
      case 'ufw':
        return handled('ufw', this.ufwCommand(argv));
      case 'firewall-cmd':
        return handled('firewall-cmd', this.firewallCmd(argv));
      case 'visudo':
        return handled('visudo', this.visudo(argv));
      case 'curl':
        return handled('curl', this.curl(argv));
      case 'sha256sum':
        return handled('sha256sum', this.sha256sum(argv, context.input));
      case 'setpriv':
        if (!this.setprivInstalled) return handled('setpriv', result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: 'setpriv: command not found' }));
        return handled('setpriv', this.su(argv.slice(argv.indexOf('--') + 1), context.input));
      case 'su':
        return handled('su', this.su(argv, context.input));
      case 'install':
        return handled('install', this.install(argv));
      case 'mv':
        return handled('mv', await this.mv(argv));
      case 'rm':
        return handled('rm', await this.rm(argv));
      case 'mkdir':
      case 'chown':
      case 'chmod':
      case 'chgrp':
        return handled(name, await this.fileCommand(argv));
      case 'mktemp':
        return handled('mktemp', this.mktemp(argv));
      case 'tar':
        return handled('tar', this.tar(argv));
      case 'getent':
        return handled('getent', this.getent(argv));
      case 'useradd':
        return handled('useradd', this.useradd(argv));
      case 'usermod':
        return handled('usermod', this.usermod(argv));
      case 'chpasswd':
        return handled('chpasswd', this.chpasswd(context.input));
      case 'which': {
        const path = this.whichPath(argv[1] ?? '');
        return handled('which', path === undefined ? result({ exitCode: 1 }) : result({ stdout: `${path}\n` }));
      }
      case 'uname':
        return handled('uname', result({ stdout: `${this.machineName}\n` }));
      case 'id':
        return handled('id', argv[1] === '-u' ? result({ stdout: `${this.euid}\n` }) : null);
      case 'ip':
        return handled('ip', this.ip(argv));
      default:
        return null;
    }
  }

  private whichPath(command: string): string | undefined {
    if (command === 'ufw' && this.ufw.installed) return '/usr/sbin/ufw';
    if (command === 'firewall-cmd' && this.firewalld.installed) return '/usr/bin/firewall-cmd';
    return this.commands.get(command);
  }

  private versionOf(path: string): string | null {
    const content = this.text(path);
    if (content === null) return null;
    return /v\d+\.\d+\.\d+(\+k3s\d+)?/.exec(content)?.[0] ?? null;
  }

  private k3s(argv: string[]): HostRunResult | null {
    if (!this.files.has(K3S_BINARY)) return result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: `${K3S_BINARY}: No such file or directory` });
    if (argv[1] === '--version') {
      const version = this.versionOf(K3S_BINARY) ?? 'v0.0.0';
      return result({ stdout: `k3s version ${version} (fake)\ngo version go1.25\n` });
    }
    if (argv[1] === 'secrets-encrypt' && argv[2] === 'status') return result({ stdout: JSON.stringify(this.encryptionStatus) });
    return null;
  }

  private helm(argv: string[]): HostRunResult | null {
    if (!this.files.has(HELM_BIN_PATH)) return result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: `${HELM_BIN_PATH}: No such file or directory` });
    if (argv[1] === 'version') return result({ stdout: this.versionOf(HELM_BIN_PATH) ?? 'broken' });
    return null;
  }

  private async k3sScript(argv: string[]): Promise<HostRunResult> {
    if (!this.files.has(argv[0])) return result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: `${argv[0]}: No such file or directory` });
    if (argv[0].endsWith('killall.sh')) return result();
    // the uninstall scripts delete /etc/rancher/k3s and the whole data directory (F6)
    for (const path of ['/etc/rancher/k3s', '/var/lib/rancher/k3s', K3S_BINARY, '/etc/systemd/system/k3s.service', '/etc/systemd/system/k3s-agent.service']) {
      await this.remove(path, { recursive: true });
    }
    for (const script of ['/usr/local/bin/k3s-uninstall.sh', '/usr/local/bin/k3s-agent-uninstall.sh', '/usr/local/bin/k3s-killall.sh']) {
      await this.remove(script);
    }
    return result({ stdout: '+ systemctl stop k3s\n' });
  }

  private installSh(context: HostCallContext): HostRunResult | null {
    const script = context.argv[1];
    if (context.argv.length !== 2 || script === undefined) return null;
    if (!this.files.has(this.norm(script))) return result({ exitCode: 127, stderr: `sh: 0: cannot open ${script}: No such file` });
    const answer = result(this.installScript);
    if (answer.exitCode !== 0) return answer;
    const agent = context.env?.INSTALL_K3S_EXEC === 'agent';
    this.seedFile(agent ? '/etc/systemd/system/k3s-agent.service' : '/etc/systemd/system/k3s.service', '[Unit]\nDescription=fake k3s\n');
    this.seedFile(agent ? '/usr/local/bin/k3s-agent-uninstall.sh' : '/usr/local/bin/k3s-uninstall.sh', '#!/bin/sh\n', { mode: 0o755 });
    this.seedFile('/usr/local/bin/k3s-killall.sh', '#!/bin/sh\n', { mode: 0o755 });
    return answer;
  }

  private serviceState(unit: string, consume: boolean): FakeServiceState | null {
    const states = this.services.get(unit);
    if (states === undefined || states.length === 0) return null;
    const state = states[0];
    if (consume && states.length > 1) states.shift();
    return state;
  }

  private systemctl(argv: string[]): HostRunResult | null {
    const verb = argv[1];
    const unit = argv[2] ?? '';
    if (verb === 'show') {
      const props = (argv[argv.indexOf('-p') + 1] ?? 'ActiveState,SubState,NRestarts').split(',');
      const state = this.serviceState(unit, true);
      const values: Record<string, string> = {
        LoadState: state?.loadState ?? (state === null ? 'not-found' : 'loaded'),
        ActiveState: state?.activeState ?? 'inactive',
        SubState: state?.subState ?? 'dead',
        NRestarts: String(state?.nRestarts ?? 0),
      };
      return result({ stdout: `${props.map((prop) => `${prop}=${values[prop] ?? ''}`).join('\n')}\n` });
    }
    if (verb === 'is-active') {
      const active = unit === 'firewalld' ? this.firewalld.installed && this.firewalld.running : this.serviceState(unit, false)?.activeState === 'active';
      return active ? result({ stdout: 'active\n' }) : result({ exitCode: 3, stdout: 'inactive\n' });
    }
    if (verb === 'is-enabled') return result({ exitCode: 1, stdout: 'disabled\n' });
    if (['start', 'restart', 'stop', 'enable', 'disable', 'daemon-reload'].includes(verb ?? '')) return result();
    return null;
  }

  private ufwCommand(argv: string[]): HostRunResult | null {
    if (!this.ufw.installed) return result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: 'ufw: command not found' });
    const verb = argv[1];
    if (verb === 'status') return result({ stdout: `Status: ${this.ufw.active ? 'active' : 'inactive'}\n` });
    if (verb === 'show' && argv[2] === 'added') {
      const lines = this.ufw.added.length > 0 ? this.ufw.added : ['(None)'];
      return result({ stdout: `${UFW_HEADER}\n${lines.join('\n')}\n` });
    }
    if (verb === 'allow') {
      const line = ufwShowAddedLine(argv.slice(2));
      if (this.ufw.added.some((existing) => withoutComment(existing) === withoutComment(line))) return result({ stdout: 'Skipping adding existing rule\n' });
      this.ufw.added.push(line);
      return result({ stdout: 'Rule added\n' });
    }
    if (verb === 'delete' && argv[2] === 'allow') {
      const line = ufwShowAddedLine(argv.slice(3), false);
      const index = this.ufw.added.findIndex((existing) => withoutComment(existing) === line);
      if (index === -1) return result({ stdout: 'Could not delete non-existent rule\n' });
      this.ufw.added.splice(index, 1);
      return result({ stdout: 'Rule deleted\n' });
    }
    if (verb === 'enable' || verb === 'disable' || verb === 'reload') {
      this.ufw.active = verb !== 'disable';
      return result({ stdout: `Firewall ${verb}d\n` });
    }
    return null;
  }

  private zone(name: string): FakeFirewalldZone | null {
    return this.firewalld.zones.get(name) ?? null;
  }

  private firewallCmd(argv: string[]): HostRunResult | null {
    const fw = this.firewalld;
    if (!fw.installed) return result({ exitCode: COMMAND_NOT_FOUND_EXIT, stderr: 'firewall-cmd: command not found' });
    const args = argv.slice(1).filter((arg) => arg !== '--permanent');
    const option = (prefix: string): string | undefined => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (args[0] === '--version') return result({ stdout: '2.1.0\n' });
    if (args[0] === '--state') return fw.running ? result({ stdout: 'running\n' }) : result({ exitCode: 252, stdout: 'not running\n' });
    if (!fw.running) return result({ exitCode: 252, stderr: 'FirewallD is not running' });
    if (args[0] === '--reload') {
      fw.reloads += 1;
      return result({ stdout: 'success\n' });
    }
    if (args[0] === '--get-default-zone') return result({ stdout: `${fw.defaultZone}\n` });
    const ofInterface = option('--get-zone-of-interface=');
    if (ofInterface !== undefined) {
      const owner = [...fw.zones].find(([, zone]) => zone.interfaces.has(ofInterface))?.[0];
      return owner === undefined ? result({ exitCode: 2, stdout: 'no zone\n' }) : result({ stdout: `${owner}\n` });
    }
    if (args[0] === '--get-ipsets') return result({ stdout: `${[...fw.ipsets.keys()].join(' ')}\n` });
    const newIpset = option('--new-ipset=');
    if (newIpset !== undefined) {
      if (fw.ipsets.has(newIpset)) return result({ exitCode: 26, stderr: `Error: NAME_CONFLICT: new_ipset(): '${newIpset}'` });
      fw.ipsets.set(newIpset, new Set());
      return result({ stdout: 'success\n' });
    }
    const deleteIpset = option('--delete-ipset=');
    if (deleteIpset !== undefined) {
      if (!fw.ipsets.delete(deleteIpset)) return result({ exitCode: 118, stderr: `Error: INVALID_IPSET: ${deleteIpset}` });
      return result({ stdout: 'success\n' });
    }
    const ipsetName = option('--ipset=');
    if (ipsetName !== undefined) {
      const ipset = fw.ipsets.get(ipsetName);
      if (ipset === undefined) return result({ exitCode: 118, stderr: `Error: INVALID_IPSET: ${ipsetName}` });
      if (args.includes('--get-entries')) return result({ stdout: [...ipset].map((entry) => `${entry}\n`).join('') });
      const add = option('--add-entry=');
      if (add !== undefined) ipset.add(add);
      const remove = option('--remove-entry=');
      if (remove !== undefined) ipset.delete(remove);
      return add !== undefined || remove !== undefined ? result({ stdout: 'success\n' }) : null;
    }
    const zoneName = option('--zone=') ?? fw.defaultZone;
    const zone = this.zone(zoneName);
    if (zone === null) return result({ exitCode: 112, stderr: `Error: INVALID_ZONE: ${zoneName}` });
    const kinds: [string, Set<string>][] = [
      ['rich-rule', zone.richRules],
      ['port', zone.ports],
      ['interface', zone.interfaces],
      ['source', zone.sources],
    ];
    for (const [kind, set] of kinds) {
      const query = option(`--query-${kind}=`);
      if (query !== undefined) return set.has(query) ? result({ stdout: 'yes\n' }) : result({ exitCode: 1, stdout: 'no\n' });
      const add = option(`--add-${kind}=`);
      if (add !== undefined) {
        if (kind === 'interface') for (const other of fw.zones.values()) other.interfaces.delete(add);
        set.add(add);
        return result({ stdout: 'success\n' });
      }
      const remove = option(`--remove-${kind}=`);
      if (remove !== undefined) {
        set.delete(remove);
        return result({ stdout: 'success\n' });
      }
    }
    return null;
  }

  private visudo(argv: string[]): HostRunResult | null {
    const check = (path: string): string => {
      const forced = this.visudoRejects.get(path);
      if (forced !== undefined) return forced;
      const content = this.text(path);
      return content === null ? `visudo: unable to open ${path}: No such file or directory` : checkSudoersSyntax(path, content);
    };
    if (argv[1] === '-cf' && argv[2] !== undefined) {
      const problem = check(argv[2]);
      return problem === '' ? result({ stdout: `${argv[2]}: parsed OK\n` }) : result({ exitCode: 1, stderr: `${problem}\n` });
    }
    if (argv[1] === '-c' && argv.length === 2) {
      const paths = [...(this.files.has('/etc/sudoers') ? ['/etc/sudoers'] : []), ...this.children('/etc/sudoers.d')];
      for (const path of paths) {
        if (posix.basename(path).includes('.')) continue;
        const problem = check(path);
        if (problem !== '') return result({ exitCode: 1, stderr: `${problem}\n` });
      }
      return result({ stdout: 'parsed OK\n' });
    }
    return null;
  }

  private curl(argv: string[]): HostRunResult {
    const output = argv[argv.indexOf('-o') + 1];
    const url = argv[argv.length - 1];
    const answer = this.urls.get(url);
    if (answer === undefined) return result({ exitCode: 22, stderr: 'curl: (22) The requested URL returned error: 404\n' });
    if (!(answer instanceof Uint8Array)) return result({ exitCode: answer.exitCode, stderr: answer.stderr });
    if (output === undefined || this.files.get(posix.dirname(this.norm(output)))?.type !== 'directory') {
      return result({ exitCode: 23, stderr: 'curl: (23) Failure writing output to destination\n' });
    }
    this.files.set(this.norm(output), { type: 'file', content: Buffer.from(answer), mode: 0o644, uid: 0, gid: 0, mtimeMs: FIXED_MTIME });
    return result();
  }

  private sha256sum(argv: string[], input: string): HostRunResult {
    if (argv[1] === '-c') {
      const lines = input.split('\n').filter((line) => line.trim() !== '');
      const ok = lines.length > 0 && lines.every((line) => {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
        const content = match ? this.resolve(match[2]) : null;
        return match !== null && content !== null && content.type === 'file' && sha256Hex(content.content) === match[1];
      });
      return ok ? result() : result({ exitCode: 1 });
    }
    const path = argv[argv.length - 1];
    const entry = this.resolve(path);
    if (entry === null || entry.type !== 'file') return result({ exitCode: 1, stderr: `sha256sum: ${path}: No such file or directory\n` });
    return result({ stdout: `${sha256Hex(entry.content)}  ${path}\n` });
  }

  private su(argv: string[], input: string): HostRunResult | null {
    if (argv[0] !== 'su') return null;
    if (this.suNeedsTerminal) return result({ exitCode: 1, stderr: 'su: must be run from a terminal\n' });
    const user = this.users.get(argv[argv.length - 1] ?? '');
    const password = input.endsWith('\n') ? input.slice(0, -1) : input;
    if (user?.password !== undefined && user.password === password) return result();
    return result({ exitCode: 1, stderr: 'su: Authentication failure\n' });
  }

  private options(argv: string[], flags: readonly string[]): { values: Map<string, string>; rest: string[]; switches: Set<string> } {
    const values = new Map<string, string>();
    const switches = new Set<string>();
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--') {
        rest.push(...argv.slice(i + 1));
        break;
      }
      if (flags.includes(arg)) values.set(arg, argv[++i] ?? '');
      else if (arg.startsWith('-') && arg.length > 1) switches.add(arg);
      else rest.push(arg);
    }
    return { values, rest, switches };
  }

  private install(argv: string[]): HostRunResult {
    const { values, rest, switches } = this.options(argv, ['-o', '-g', '-m']);
    const mode = Number.parseInt(values.get('-m') ?? '755', 8);
    const uid = this.idOf(values.get('-o'), 'user') ?? 0;
    const gid = this.idOf(values.get('-g'), 'group') ?? 0;
    if (switches.has('-d')) {
      for (const dir of rest) {
        this.ensureParents(dir);
        this.files.set(this.norm(dir), { type: 'directory', content: Buffer.alloc(0), mode, uid, gid, mtimeMs: FIXED_MTIME });
      }
      return result();
    }
    const [source, dest] = rest;
    const entry = source === undefined ? null : this.resolve(source);
    if (entry === null || entry.type !== 'file' || dest === undefined) {
      return result({ exitCode: 1, stderr: `install: cannot stat '${source}': No such file or directory\n` });
    }
    if (this.files.get(posix.dirname(this.norm(dest)))?.type !== 'directory') {
      return result({ exitCode: 1, stderr: `install: cannot create regular file '${dest}': No such file or directory\n` });
    }
    this.files.set(this.norm(dest), { type: 'file', content: Buffer.from(entry.content), mode, uid, gid, mtimeMs: FIXED_MTIME });
    return result();
  }

  private async mv(argv: string[]): Promise<HostRunResult> {
    const { rest } = this.options(argv, []);
    const [source, dest] = rest;
    if (source === undefined || dest === undefined || !this.files.has(this.norm(source))) {
      return result({ exitCode: 1, stderr: `mv: cannot stat '${source}': No such file or directory\n` });
    }
    await this.remove(dest, { recursive: true });
    await this.rename(source, dest);
    return result();
  }

  private async rm(argv: string[]): Promise<HostRunResult> {
    const { rest, switches } = this.options(argv, []);
    const recursive = [...switches].some((flag) => flag.includes('r'));
    for (const path of rest) await this.remove(path, { recursive });
    return result();
  }

  private async fileCommand(argv: string[]): Promise<HostRunResult> {
    const { rest, switches } = this.options(argv, []);
    if (argv[0] === 'mkdir') {
      for (const dir of rest) if (!this.files.has(this.norm(dir))) await this.mkdir(dir, { mode: 0o755 });
      return result();
    }
    if (switches.has('-R')) return result();
    const [spec, path] = rest;
    if (spec === undefined || path === undefined || !this.files.has(this.norm(path))) {
      return result({ exitCode: 1, stderr: `${argv[0]}: cannot access '${path}': No such file or directory\n` });
    }
    if (argv[0] === 'chmod') {
      await this.chmod(path, Number.parseInt(spec, 8));
    } else if (argv[0] === 'chown') {
      const [owner, group] = spec.split(':');
      const uid = this.idOf(owner, 'user');
      const gid = this.idOf(group === undefined || group === '' ? owner : group, 'group');
      if (uid === undefined || gid === undefined) return result({ exitCode: 1, stderr: `chown: invalid user: '${spec}'\n` });
      await this.chown(path, uid, gid);
    }
    return result();
  }

  private mktemp(argv: string[]): HostRunResult | null {
    if (argv[1] !== '-d' || argv[2] === undefined) return null;
    this.tempCounter += 1;
    const path = argv[2].replace(/X+$/, (xs) => String(this.tempCounter).padStart(xs.length, '0'));
    if (this.files.get(posix.dirname(path))?.type !== 'directory') {
      return result({ exitCode: 1, stderr: `mktemp: failed to create directory via template '${argv[2]}'\n` });
    }
    this.files.set(path, { type: 'directory', content: Buffer.alloc(0), mode: 0o700, uid: this.euid, gid: this.euid, mtimeMs: FIXED_MTIME });
    return result({ stdout: `${path}\n` });
  }

  private tar(argv: string[]): HostRunResult | null {
    if (argv[1] !== '-xzf') return null;
    const archive = this.resolve(argv[2] ?? '');
    const dir = argv[argv.indexOf('-C') + 1];
    const wanted = argv.slice(argv.indexOf('-C') + 2).filter((arg) => !arg.startsWith('-'));
    let members: Record<string, string>;
    try {
      members = (JSON.parse(archive?.content.toString('utf8') ?? '') as { fakeTar: Record<string, string> }).fakeTar;
    } catch {
      return result({ exitCode: 2, stderr: 'gzip: stdin: not in gzip format\ntar: Error is not recoverable: exiting now\n' });
    }
    for (const member of wanted.length > 0 ? wanted : Object.keys(members)) {
      const content = members[member];
      if (content === undefined) return result({ exitCode: 2, stderr: `tar: ${member}: Not found in archive\n` });
      this.seedFile(`${dir}/${member}`, content, { mode: 0o755 });
    }
    return result();
  }

  private getent(argv: string[]): HostRunResult | null {
    if (argv[1] === 'passwd') {
      const user = this.users.get(argv[2] ?? '');
      return user === undefined ? result({ exitCode: 2 }) : result({ stdout: `${user.name}:x:${user.uid}:${user.gid}::${user.home}:${user.shell}\n` });
    }
    if (argv[1] === 'group') {
      const group = this.groups.get(argv[2] ?? '');
      return group === undefined ? result({ exitCode: 2 }) : result({ stdout: `${argv[2]}:x:${group.gid}:${[...group.members].join(',')}\n` });
    }
    return null;
  }

  private useradd(argv: string[]): HostRunResult {
    const name = argv[argv.length - 1] ?? '';
    if (this.users.has(name)) return result({ exitCode: 9, stderr: `useradd: user '${name}' already exists\n` });
    this.addUser(name);
    return result();
  }

  private usermod(argv: string[]): HostRunResult | null {
    const name = argv[argv.length - 1] ?? '';
    const user = this.users.get(name);
    if (user === undefined) return result({ exitCode: 6, stderr: `usermod: user '${name}' does not exist\n` });
    if (argv[1] === '-p') {
      user.passwordHash = argv[2];
      user.password = undefined;
      return result();
    }
    if (argv[1] === '-aG') {
      const group = this.groups.get(argv[2] ?? '');
      if (group === undefined) return result({ exitCode: 6, stderr: `usermod: group '${argv[2]}' does not exist\n` });
      group.members.add(name);
      return result();
    }
    return null;
  }

  private chpasswd(input: string): HostRunResult {
    for (const line of input.split('\n').filter((l) => l.includes(':'))) {
      const at = line.indexOf(':');
      const user = this.users.get(line.slice(0, at));
      if (user === undefined) return result({ exitCode: 1, stderr: 'chpasswd: line 1: user does not exist\n' });
      user.password = line.slice(at + 1);
    }
    return result();
  }

  private ip(argv: string[]): HostRunResult | null {
    if (argv.join(' ') === 'ip -o -4 addr show') {
      const lines = this.interfaces.map(
        (iface, index) => `${index + 2}: ${iface.name}    inet ${iface.address}/${iface.prefix} brd 10.0.0.255 scope global ${iface.name}\\       valid_lft forever preferred_lft forever`,
      );
      return result({ stdout: `${lines.join('\n')}\n` });
    }
    if (argv[1] === '-4' && argv[2] === 'route' && argv[3] === 'get') {
      const iface = this.interfaces.find((candidate) => candidate.name === this.defaultRouteInterface);
      return result({ stdout: `${argv[4]} via 10.0.0.1 dev ${this.defaultRouteInterface} src ${iface?.address ?? '10.0.0.10'} uid 0\n` });
    }
    return null;
  }
}
