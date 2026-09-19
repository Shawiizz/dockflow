// FakeNodeShell (design-07 3.6): the NodeShell of runtime/node-shell.ts, one per node through
// forNode(), which is the `nodeShell` factory of a bundle. Like the real one it never retries, returns
// non-zero exits instead of throwing and redacts stderr. Each node has an in-memory file system that
// FakeHelmExecutor shares (chart pulls land there), and a small interpreter for plain file commands
// (mkdir, mv, rm, cat, sha256sum, mktemp, ...) that a test can enable instead of scripting them.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PassThrough, type Readable, Writable } from 'stream';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import type { SshChannel } from '../../../services/orchestrator/kubernetes/deps';
import { KubeError, NO_EXIT_CODE } from '../../../services/orchestrator/kubernetes/runtime/errors';
import type { KubectlResult } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import type { NodeShell } from '../../../services/orchestrator/kubernetes/runtime/node-shell';
import type { Redactor } from '../../../utils/redact';

/** `{golden: '<name>'}` stdin expectations of every fake resolve under this directory */
export const STDIN_GOLDEN_ROOT = join(import.meta.dir, '..', 'fixtures', 'stdin');

/** exit status of a channel the caller closed before it answered (as FakeSsh reports it) */
export const CLOSED_CHANNEL_EXIT = -1;

// Turns a call stays open under `concurrencyProbe`, so concurrent callers overlap observably.
const PROBE_TURNS = 5;

export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk);
  return new Uint8Array(Buffer.from(String(chunk), 'utf8'));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

/** the whole stdin a caller handed over, whatever its form */
export async function collectStdin(input: Readable | Uint8Array | string | undefined): Promise<Uint8Array> {
  if (input === undefined) return new Uint8Array();
  if (typeof input === 'string') return new Uint8Array(Buffer.from(input, 'utf8'));
  if (input instanceof Uint8Array) return new Uint8Array(input);
  const parts: Uint8Array[] = [];
  for await (const chunk of input) parts.push(toBytes(chunk));
  return concatBytes(parts);
}

/** reads `<root>/<name>`; names may have subdirectories but never leave the root */
export function readGolden(root: string, name: string): Uint8Array {
  if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`Golden name ${name} must stay inside ${root}`);
  const path = join(root, name);
  if (!existsSync(path)) throw new Error(`Golden stdin file ${path} does not exist`);
  return new Uint8Array(readFileSync(path));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Shell words
// ---------------------------------------------------------------------------

export type ShellToken = { kind: 'word'; value: string } | { kind: 'op'; value: string };

const OPERATORS = ['&&', '||', '>>', '>', '<', ';', '|', '&'] as const;

/**
 * POSIX-ish tokenizer: single and double quotes, backslash escapes, comments, the list and
 * redirection operators (`2>`, `2>>` and `2>&1` included). Enough for every command string Dockflow
 * builds with shellQuote; it throws on an unterminated quote.
 */
export function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let inWord = false;
  const flush = (): void => {
    if (inWord) tokens.push({ kind: 'word', value: word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error(`Unterminated single quote in: ${command}`);
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) {
          word += command[j + 1];
          j += 2;
        } else {
          word += command[j];
          j += 1;
        }
      }
      if (j >= command.length) throw new Error(`Unterminated double quote in: ${command}`);
      inWord = true;
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') {
        word += command[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === ' ' || c === '\t') {
      flush();
      i += 1;
    } else if (c === '\n') {
      flush();
      tokens.push({ kind: 'op', value: ';' });
      i += 1;
    } else if (c === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n') i += 1;
    } else if (c === '2' && !inWord && command[i + 1] === '>') {
      const op = command.startsWith('2>&1', i) ? '2>&1' : command.startsWith('2>>', i) ? '2>>' : '2>';
      tokens.push({ kind: 'op', value: op });
      i += op.length;
    } else {
      const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
      if (op) {
        flush();
        tokens.push({ kind: 'op', value: op });
        i += op.length;
      } else {
        word += c;
        inWord = true;
        i += 1;
      }
    }
  }
  flush();
  return tokens;
}

/** the words of a command string, operators included as plain strings */
export function shellWords(command: string): string[] {
  return shellTokens(command).map((token) => token.value);
}

// ---------------------------------------------------------------------------
// Node file system
// ---------------------------------------------------------------------------

/** One node's files: content and mode. Paths are absolute POSIX paths; parents are implicit on write. */
export class FakeNodeFs {
  private readonly fileMap = new Map<string, { bytes: Uint8Array; mode: number }>();
  private readonly dirMap = new Map<string, number>([['/', 0o755]]);
  private tempCounter = 0;

  static normalize(path: string): string {
    const parts: string[] = [];
    for (const segment of path.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return `/${parts.join('/')}`;
  }

  write(path: string, content: string | Uint8Array, mode = 0o644): void {
    const target = FakeNodeFs.normalize(path);
    if (this.dirMap.has(target)) throw new Error(`${target} is a directory`);
    this.mkdir(parentOf(target), { parents: true });
    const bytes = typeof content === 'string' ? new Uint8Array(Buffer.from(content, 'utf8')) : new Uint8Array(content);
    this.fileMap.set(target, { bytes, mode });
  }

  append(path: string, content: string | Uint8Array, mode = 0o644): void {
    const existing = this.read(path);
    const added = typeof content === 'string' ? new Uint8Array(Buffer.from(content, 'utf8')) : content;
    this.write(path, existing ? concatBytes([existing, added]) : added, this.mode(path) ?? mode);
  }

  read(path: string): Uint8Array | null {
    const file = this.fileMap.get(FakeNodeFs.normalize(path));
    return file ? new Uint8Array(file.bytes) : null;
  }

  readText(path: string): string | null {
    const bytes = this.read(path);
    return bytes === null ? null : Buffer.from(bytes).toString('utf8');
  }

  isFile(path: string): boolean {
    return this.fileMap.has(FakeNodeFs.normalize(path));
  }

  isDir(path: string): boolean {
    return this.dirMap.has(FakeNodeFs.normalize(path));
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isDir(path);
  }

  /** false when a file is in the way or, without `parents`, the parent is missing */
  mkdir(path: string, options: { parents?: boolean; mode?: number } = {}): boolean {
    const target = FakeNodeFs.normalize(path);
    if (this.fileMap.has(target)) return false;
    if (this.dirMap.has(target)) return true;
    const parent = parentOf(target);
    if (!this.dirMap.has(parent)) {
      if (!options.parents || !this.mkdir(parent, { parents: true })) return false;
    }
    this.dirMap.set(target, options.mode ?? 0o755);
    return true;
  }

  /** removes a file, or a directory with everything under it when `recursive`; false when nothing was removed */
  remove(path: string, options: { recursive?: boolean } = {}): boolean {
    const target = FakeNodeFs.normalize(path);
    if (this.fileMap.delete(target)) return true;
    if (!this.dirMap.has(target) || target === '/') return false;
    const inside = `${target}/`;
    const children = [...this.fileMap.keys(), ...this.dirMap.keys()].some((p) => p.startsWith(inside));
    if (children && !options.recursive) return false;
    for (const file of [...this.fileMap.keys()]) if (file.startsWith(inside)) this.fileMap.delete(file);
    for (const dir of [...this.dirMap.keys()]) if (dir.startsWith(inside)) this.dirMap.delete(dir);
    this.dirMap.delete(target);
    return true;
  }

  /** `mv -f`: into an existing directory, or onto the destination path */
  move(src: string, dest: string): boolean {
    const from = FakeNodeFs.normalize(src);
    let to = FakeNodeFs.normalize(dest);
    if (this.dirMap.has(to)) to = FakeNodeFs.normalize(`${to}/${from.split('/').pop() ?? ''}`);
    if (!this.dirMap.has(parentOf(to))) return false;
    const file = this.fileMap.get(from);
    if (file) {
      this.fileMap.delete(from);
      this.fileMap.set(to, file);
      return true;
    }
    if (!this.dirMap.has(from) || from === '/') return false;
    const prefix = `${from}/`;
    for (const [path, entry] of [...this.fileMap]) {
      if (!path.startsWith(prefix)) continue;
      this.fileMap.delete(path);
      this.fileMap.set(`${to}/${path.slice(prefix.length)}`, entry);
    }
    for (const [path, mode] of [...this.dirMap]) {
      if (path !== from && !path.startsWith(prefix)) continue;
      this.dirMap.delete(path);
      this.dirMap.set(path === from ? to : `${to}/${path.slice(prefix.length)}`, mode);
    }
    return true;
  }

  chmod(path: string, mode: number): boolean {
    const target = FakeNodeFs.normalize(path);
    const file = this.fileMap.get(target);
    if (file) {
      file.mode = mode;
      return true;
    }
    if (!this.dirMap.has(target)) return false;
    this.dirMap.set(target, mode);
    return true;
  }

  mode(path: string): number | null {
    const target = FakeNodeFs.normalize(path);
    return this.fileMap.get(target)?.mode ?? this.dirMap.get(target) ?? null;
  }

  /** lowercase hex, null when the file does not exist */
  sha256(path: string): string | null {
    const bytes = this.read(path);
    return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  }

  /** file paths under `prefix`, sorted */
  files(prefix = '/'): string[] {
    const root = FakeNodeFs.normalize(prefix);
    const inside = root === '/' ? '/' : `${root}/`;
    return [...this.fileMap.keys()].filter((path) => path === root || path.startsWith(inside)).sort();
  }

  /** deterministic replacement for the trailing X's of a mktemp template */
  nextTempSuffix(length: number): string {
    this.tempCounter += 1;
    return this.tempCounter.toString(36).padStart(length, '0').slice(-length);
  }
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

// ---------------------------------------------------------------------------
// File command interpreter
// ---------------------------------------------------------------------------

type Redirect = { op: '>' | '>>' | '2>' | '2>>' | '<'; target: string } | { op: '2>&1' };
type ScriptNode = { kind: 'simple'; words: string[]; redirects: Redirect[] } | { kind: 'group'; list: ListItem[] };
interface ListItem {
  /** operator joining this item to the previous one */
  connector: '&&' | '||' | ';' | null;
  node: ScriptNode;
}

/** commands the interpreter understands; anything else leaves the script to the test's steps */
export const INTERPRETED_COMMANDS: readonly string[] = [
  'true',
  'false',
  ':',
  'umask',
  'mkdir',
  'mv',
  'rm',
  'touch',
  'cat',
  'sha256sum',
  'mktemp',
  'test',
  '[',
  'chmod',
  'find',
  'echo',
];

class ScriptParser {
  private at = 0;

  constructor(private readonly tokens: ShellToken[]) {}

  parse(): ListItem[] | null {
    const list = this.list(false);
    return list !== null && this.at === this.tokens.length ? list : null;
  }

  private list(inGroup: boolean): ListItem[] | null {
    const items: ListItem[] = [];
    let connector: ListItem['connector'] = null;
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at];
      if (token.kind === 'op' && token.value === ';' && connector !== '&&' && connector !== '||') {
        this.at += 1;
        connector = items.length > 0 ? ';' : null;
        continue;
      }
      if (inGroup && token.kind === 'word' && token.value === '}') return items;
      const node = this.command();
      if (node === null) return null;
      items.push({ connector, node });
      const next = this.tokens[this.at];
      if (next === undefined) break;
      if (next.kind === 'op' && (next.value === '&&' || next.value === '||' || next.value === ';')) {
        connector = next.value;
        this.at += 1;
        continue;
      }
      if (inGroup && next.kind === 'word' && next.value === '}') return items;
      return null;
    }
    return inGroup ? null : items;
  }

  private command(): ScriptNode | null {
    const first = this.tokens[this.at];
    if (first?.kind === 'word' && first.value === '{') {
      this.at += 1;
      const list = this.list(true);
      if (list === null || this.tokens[this.at]?.value !== '}') return null;
      this.at += 1;
      return { kind: 'group', list };
    }
    const words: string[] = [];
    const redirects: Redirect[] = [];
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at];
      if (token.kind === 'word') {
        words.push(token.value);
        this.at += 1;
        continue;
      }
      if (token.value === '2>&1') {
        redirects.push({ op: '2>&1' });
        this.at += 1;
        continue;
      }
      if (token.value === '>' || token.value === '>>' || token.value === '2>' || token.value === '2>>' || token.value === '<') {
        const target = this.tokens[this.at + 1];
        if (target?.kind !== 'word') return null;
        redirects.push({ op: token.value, target: target.value });
        this.at += 2;
        continue;
      }
      break;
    }
    if (words.length === 0 || !INTERPRETED_COMMANDS.includes(words[0])) return null;
    return { kind: 'simple', words, redirects };
  }
}

function parseScript(script: string): ListItem[] | null {
  let tokens: ShellToken[];
  try {
    tokens = shellTokens(script);
  } catch {
    return null;
  }
  // pipes and background jobs are beyond the interpreter
  if (tokens.some((token) => token.kind === 'op' && (token.value === '|' || token.value === '&'))) return null;
  return new ScriptParser(tokens).parse();
}

/** true when every command of `script` is one the interpreter runs */
export function canInterpret(script: string): boolean {
  return parseScript(script) !== null;
}

interface Output {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

const EMPTY = new Uint8Array();

function fail(stderr: string): Output {
  return { exitCode: 1, stdout: EMPTY, stderr: `${stderr}\n` };
}

function success(stdout: string | Uint8Array = EMPTY): Output {
  return { exitCode: 0, stdout: typeof stdout === 'string' ? new Uint8Array(Buffer.from(stdout, 'utf8')) : stdout, stderr: '' };
}

/** splits `-rf`-style flags from operands, honouring `--` */
function operands(words: readonly string[], valued: readonly string[] = []): { flags: Map<string, string>; args: string[] } {
  const flags = new Map<string, string>();
  const args: string[] = [];
  let options = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (options && word === '--') {
      options = false;
    } else if (options && valued.includes(word)) {
      flags.set(word, words[i + 1] ?? '');
      i += 1;
    } else if (options && /^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) flags.set(`-${letter}`, '');
    } else {
      args.push(word);
    }
  }
  return { flags, args };
}

class FileScript {
  private umask = 0o022;
  private stdinUsed = false;

  constructor(
    private readonly fs: FakeNodeFs,
    private readonly stdin: Uint8Array,
  ) {}

  run(list: readonly ListItem[]): Output {
    const stdout: Uint8Array[] = [];
    let stderr = '';
    let status = 0;
    for (const item of list) {
      if (item.connector === '&&' && status !== 0) continue;
      if (item.connector === '||' && status === 0) continue;
      const out = item.node.kind === 'group' ? this.run(item.node.list) : this.simple(item.node.words, item.node.redirects);
      stdout.push(out.stdout);
      stderr += out.stderr;
      status = out.exitCode;
    }
    return { exitCode: status, stdout: concatBytes(stdout), stderr };
  }

  private simple(words: string[], redirects: Redirect[]): Output {
    let input: Uint8Array | null = null;
    for (const redirect of redirects) {
      if (redirect.op !== '<') continue;
      input = this.fs.read(redirect.target);
      if (input === null) return fail(`sh: ${redirect.target}: No such file or directory`);
    }
    let out = this.builtin(words[0], words.slice(1), input);
    for (const redirect of redirects) {
      if (redirect.op === '2>&1') {
        out = { exitCode: out.exitCode, stdout: concatBytes([out.stdout, Buffer.from(out.stderr, 'utf8')]), stderr: '' };
      } else if (redirect.op === '>' || redirect.op === '>>') {
        if (redirect.target !== '/dev/null') {
          const mode = 0o666 & ~this.umask;
          if (redirect.op === '>') this.fs.write(redirect.target, out.stdout, this.fs.mode(redirect.target) ?? mode);
          else this.fs.append(redirect.target, out.stdout, mode);
        }
        out = { ...out, stdout: EMPTY };
      } else if (redirect.op === '2>' || redirect.op === '2>>') {
        if (redirect.target !== '/dev/null') {
          if (redirect.op === '2>') this.fs.write(redirect.target, out.stderr, 0o666 & ~this.umask);
          else this.fs.append(redirect.target, out.stderr, 0o666 & ~this.umask);
        }
        out = { ...out, stderr: '' };
      }
    }
    return out;
  }

  private takeStdin(): Uint8Array {
    if (this.stdinUsed) return EMPTY;
    this.stdinUsed = true;
    return this.stdin;
  }

  private builtin(name: string, words: string[], input: Uint8Array | null): Output {
    switch (name) {
      case 'true':
      case ':':
        return success();
      case 'false':
        return { exitCode: 1, stdout: EMPTY, stderr: '' };
      case 'umask':
        this.umask = Number.parseInt(words[0] ?? '022', 8);
        return success();
      case 'find':
        // cache and temp-dir sweeps: nothing ages in fake time
        return success();
      case 'echo': {
        const newline = words[0] !== '-n';
        return success(`${(newline ? words : words.slice(1)).join(' ')}${newline ? '\n' : ''}`);
      }
      case 'mkdir':
        return this.mkdir(words);
      case 'mv':
        return this.mv(words);
      case 'rm':
        return this.rm(words);
      case 'touch':
        return this.touch(words);
      case 'cat':
        return this.cat(words, input);
      case 'sha256sum':
        return this.sha256sum(words);
      case 'mktemp':
        return this.mktemp(words);
      case 'chmod':
        return this.chmod(words);
      case 'test':
        return this.test(words);
      case '[':
        return words.at(-1) === ']' ? this.test(words.slice(0, -1)) : fail('[: missing ]');
      default:
        return fail(`sh: ${name}: not found`);
    }
  }

  private mkdir(words: string[]): Output {
    const { flags, args } = operands(words, ['-m']);
    const mode = flags.has('-m') ? Number.parseInt(flags.get('-m') ?? '', 8) : 0o777 & ~this.umask;
    for (const path of args) {
      if (this.fs.isDir(path)) {
        if (flags.has('-p')) continue;
        return fail(`mkdir: cannot create directory '${path}': File exists`);
      }
      if (!this.fs.mkdir(path, { parents: flags.has('-p'), mode })) {
        return fail(`mkdir: cannot create directory '${path}': No such file or directory`);
      }
    }
    return success();
  }

  private mv(words: string[]): Output {
    const { args } = operands(words);
    if (args.length !== 2) return fail('mv: expected a source and a destination');
    const [src, dest] = args;
    if (!this.fs.exists(src)) return fail(`mv: cannot stat '${src}': No such file or directory`);
    return this.fs.move(src, dest) ? success() : fail(`mv: cannot move '${src}' to '${dest}': No such file or directory`);
  }

  private rm(words: string[]): Output {
    const { flags, args } = operands(words);
    const recursive = flags.has('-r') || flags.has('-R');
    for (const path of args) {
      if (!this.fs.exists(path)) {
        if (flags.has('-f')) continue;
        return fail(`rm: cannot remove '${path}': No such file or directory`);
      }
      if (this.fs.isDir(path) && !recursive) return fail(`rm: cannot remove '${path}': Is a directory`);
      this.fs.remove(path, { recursive: true });
    }
    return success();
  }

  private touch(words: string[]): Output {
    const { args } = operands(words);
    for (const path of args) {
      if (this.fs.isDir(path)) continue;
      if (!this.fs.isFile(path)) this.fs.write(path, EMPTY, 0o666 & ~this.umask);
    }
    return success();
  }

  private cat(words: string[], input: Uint8Array | null): Output {
    const { args } = operands(words);
    if (args.length === 0 || (args.length === 1 && args[0] === '-')) return success(input ?? this.takeStdin());
    const parts: Uint8Array[] = [];
    for (const path of args) {
      const bytes = this.fs.read(path);
      if (bytes === null) return fail(`cat: ${path}: No such file or directory`);
      parts.push(bytes);
    }
    return success(concatBytes(parts));
  }

  private sha256sum(words: string[]): Output {
    const { args } = operands(words);
    let out = '';
    for (const path of args) {
      const hash = this.fs.sha256(path);
      if (hash === null) return { exitCode: 1, stdout: Buffer.from(out, 'utf8'), stderr: `sha256sum: ${path}: No such file or directory\n` };
      out += `${hash}  ${path}\n`;
    }
    return success(out);
  }

  private mktemp(words: string[]): Output {
    const { flags, args } = operands(words);
    const template = args[0] ?? '/tmp/tmp.XXXXXXXXXX';
    const xs = /X+$/.exec(template)?.[0].length ?? 0;
    if (xs < 3) return fail(`mktemp: too few X's in template '${template}'`);
    const path = `${template.slice(0, -xs)}${this.fs.nextTempSuffix(xs)}`;
    if (flags.has('-d')) {
      if (!this.fs.mkdir(path, { mode: 0o700 })) return fail(`mktemp: failed to create directory via template '${template}'`);
    } else {
      this.fs.write(path, EMPTY, 0o600);
    }
    return success(`${path}\n`);
  }

  private chmod(words: string[]): Output {
    const [mode, ...paths] = words;
    for (const path of paths) {
      if (!this.fs.chmod(path, Number.parseInt(mode ?? '', 8))) return fail(`chmod: cannot access '${path}': No such file or directory`);
    }
    return success();
  }

  private test(words: string[]): Output {
    const [flag, path] = words;
    const holds =
      path !== undefined &&
      ((flag === '-f' && this.fs.isFile(path)) ||
        (flag === '-d' && this.fs.isDir(path)) ||
        (flag === '-e' && this.fs.exists(path)) ||
        (flag === '-s' && (this.fs.read(path)?.length ?? 0) > 0));
    return { exitCode: holds ? 0 : 1, stdout: EMPTY, stderr: '' };
  }
}

/** runs a script of plain file commands against `fs`; null when it uses anything else */
export function interpretFileScript(script: string, stdin: Uint8Array, fs: FakeNodeFs): { exitCode: number; stdout: string; stderr: string } | null {
  const list = parseScript(script);
  if (list === null) return null;
  const out = new FileScript(fs, stdin).run(list);
  return { exitCode: out.exitCode, stdout: Buffer.from(out.stdout).toString('utf8'), stderr: out.stderr };
}

// ---------------------------------------------------------------------------
// FakeNodeShell
// ---------------------------------------------------------------------------

export interface NodeShellResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface NodeShellCall {
  /** ClusterNodeRef.name */
  node: string;
  script: string;
  kind: 'run' | 'channel';
  /** bytes the caller sent (a channel's grow as they are written) */
  stdin: Uint8Array;
  /** id (or `#<index>`) of the step that answered; 'interpreter' for the file interpreter */
  step?: string;
  /** what the call returned (stderr redacted); absent while open or when it threw */
  result?: KubectlResult;
  /** a channel the caller closed before it answered */
  closed?: boolean;
}

export type NodeShellRespond =
  | NodeShellResponse
  | { transportError: true }
  | ((call: NodeShellCall, fs: FakeNodeFs) => NodeShellResponse | Promise<NodeShellResponse>);

export interface NodeShellStep {
  /** printed in failure messages */
  id?: string;
  /** ClusterNodeRef.name; default: any node */
  node?: string;
  script: RegExp | ((script: string) => boolean);
  /** the two methods of NodeShell; default: either */
  kind?: 'run' | 'channel';
  /** asserted when present; gunzipped first when the script starts with `gzip -dc` */
  stdin?: ((bytes: Uint8Array) => void) | { golden: string };
  respond: NodeShellRespond;
  /** default 1 */
  times?: number | 'any';
  /** never required by assertDone() */
  optional?: boolean;
}

export interface FakeNodeShellOptions {
  redactor: Redactor;
  /** keeps every call open a few turns, so the peak of concurrent calls is observable */
  concurrencyProbe?: true;
  /** scripts no step matches run through the file interpreter when it understands them */
  interpretFileCommands?: boolean;
  /** root of `{golden}` stdin files; default fixtures/stdin */
  stdinGoldenRoot?: string;
}

interface StepState {
  step: NodeShellStep;
  index: number;
  used: number;
}

function stepLabel(state: StepState): string {
  return state.step.id ?? `#${state.index}`;
}

function exhausted(state: StepState): boolean {
  const times = state.step.times ?? 1;
  return times !== 'any' && state.used >= times;
}

export class FakeNodeShell {
  readonly calls: NodeShellCall[] = [];
  /** scripts no step matched, as `[kind on node] script` */
  readonly unexpected: string[] = [];
  /** stdin assertion failures */
  readonly problems: string[] = [];
  readonly redactor: Redactor;
  private readonly states: StepState[];
  private readonly filesystems = new Map<string, FakeNodeFs>();
  private open = 0;
  private peak = 0;
  private done = false;

  constructor(
    steps: NodeShellStep[],
    private readonly options: FakeNodeShellOptions,
  ) {
    this.redactor = options.redactor;
    this.states = steps.map((step, index) => ({ step, index, used: 0 }));
  }

  /** the `nodeShell` factory injected into the bundle: one NodeShell per node, all recorded here */
  readonly forNode = (node: ClusterNodeRef): NodeShell => ({
    node,
    run: (script, options) => this.run(node, script, options.stdin),
    channel: (script) => this.channel(node, script),
  });

  /** highest number of calls open at the same time (image import concurrency) */
  get peakConcurrency(): number {
    return this.peak;
  }

  /** assertDone() was called */
  get asserted(): boolean {
    return this.done;
  }

  /** the file system of one node, shared with a FakeHelmExecutor bound to that node */
  fs(node: string | ClusterNodeRef): FakeNodeFs {
    const name = typeof node === 'string' ? node : node.name;
    let fs = this.filesystems.get(name);
    if (!fs) {
      fs = new FakeNodeFs();
      this.filesystems.set(name, fs);
    }
    return fs;
  }

  assertDone(): void {
    this.done = true;
    const failures: string[] = [];
    for (const state of this.states) {
      const times = state.step.times ?? 1;
      if (state.step.optional || times === 'any' || state.used >= times) continue;
      failures.push(`step ${stepLabel(state)} (${String(state.step.script)}) was used ${state.used} of ${times} time(s)`);
    }
    for (const call of this.unexpected) failures.push(`unexpected node command: ${call}`);
    failures.push(...this.problems);
    if (failures.length > 0) throw new Error(`FakeNodeShell:\n${failures.join('\n')}`);
  }

  private match(node: string, script: string, kind: 'run' | 'channel'): StepState | null {
    return (
      this.states.find(
        (state) =>
          !exhausted(state) &&
          (state.step.node === undefined || state.step.node === node) &&
          (state.step.kind === undefined || state.step.kind === kind) &&
          (typeof state.step.script === 'function' ? state.step.script(script) : state.step.script.test(script)),
      ) ?? null
    );
  }

  /** a step, the interpreter, or an unexpected-call error */
  private resolve(call: NodeShellCall): StepState | 'interpreter' {
    const state = this.match(call.node, call.script, call.kind);
    if (state) {
      state.used += 1;
      call.step = stepLabel(state);
      return state;
    }
    if (this.options.interpretFileCommands && canInterpret(call.script)) {
      call.step = 'interpreter';
      return 'interpreter';
    }
    const line = `[${call.kind} on ${call.node}] ${call.script}`;
    this.unexpected.push(line);
    const known = this.states.map((s) => `  ${stepLabel(s)} ${String(s.step.script)} (used ${s.used})`);
    throw new Error([`Unexpected node command ${line}`, 'steps:', ...known].join('\n'));
  }

  private checkStdin(state: StepState, call: NodeShellCall): void {
    const expected = state.step.stdin;
    if (expected === undefined) return;
    let bytes = call.stdin;
    if (call.script.trimStart().startsWith('gzip -dc')) {
      try {
        bytes = new Uint8Array(gunzipSync(bytes));
      } catch (error) {
        this.problem(`step ${stepLabel(state)}: stdin of \`${call.script}\` is not gzip data: ${describeError(error)}`);
      }
    }
    if (typeof expected === 'function') {
      try {
        expected(bytes);
      } catch (error) {
        this.problem(`step ${stepLabel(state)}: stdin assertion failed: ${describeError(error)}`);
      }
      return;
    }
    const golden = readGolden(this.options.stdinGoldenRoot ?? STDIN_GOLDEN_ROOT, expected.golden);
    if (!sameBytes(golden, bytes)) {
      this.problem(`step ${stepLabel(state)}: stdin differs from golden ${expected.golden} (${bytes.length} bytes, golden ${golden.length})`);
    }
  }

  private problem(message: string): never {
    this.problems.push(message);
    throw new Error(message);
  }

  private async answer(source: StepState | 'interpreter', call: NodeShellCall, node: ClusterNodeRef): Promise<NodeShellResponse> {
    if (source === 'interpreter') {
      const out = interpretFileScript(call.script, call.stdin, this.fs(node));
      if (out === null) throw new Error(`The file interpreter cannot run: ${call.script}`);
      return out;
    }
    this.checkStdin(source, call);
    const respond = source.step.respond;
    if (typeof respond === 'function') return respond(call, this.fs(node));
    if ('transportError' in respond) {
      throw new KubeError('Unreachable', `Lost the SSH connection to ${node.name} during a node command: read ECONNRESET`, node.name, NO_EXIT_CODE, '');
    }
    return respond;
  }

  private enter(): void {
    this.open += 1;
    this.peak = Math.max(this.peak, this.open);
  }

  private async run(node: ClusterNodeRef, script: string, stdin: Readable | Uint8Array | string | undefined): Promise<KubectlResult> {
    const call: NodeShellCall = { node: node.name, script, kind: 'run', stdin: new Uint8Array() };
    this.calls.push(call);
    const source = this.resolve(call);
    this.enter();
    try {
      call.stdin = await collectStdin(stdin);
      if (this.options.concurrencyProbe) for (let i = 0; i < PROBE_TURNS; i++) await turn();
      const response = await this.answer(source, call, node);
      const result: KubectlResult = {
        exitCode: response.exitCode,
        stdout: response.stdout ?? '',
        stderr: this.redactor.redact(response.stderr ?? ''),
      };
      call.result = result;
      return result;
    } finally {
      this.open -= 1;
    }
  }

  private async channel(node: ClusterNodeRef, script: string): Promise<SshChannel> {
    const call: NodeShellCall = { node: node.name, script, kind: 'channel', stdin: new Uint8Array() };
    this.calls.push(call);
    const source = this.resolve(call);
    this.enter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Uint8Array[] = [];
    let settle: (value: { exitCode: number }) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const done = new Promise<{ exitCode: number }>((resolve, rejectDone) => {
      settle = resolve;
      reject = rejectDone;
    });
    done.catch(() => {});
    let finished = false;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      this.open -= 1;
      stdout.end();
      stderr.end();
      void turn().then(() => settle({ exitCode }));
    };
    const respond = async (): Promise<void> => {
      await turn();
      if (finished) return;
      if (this.options.concurrencyProbe) for (let i = 0; i < PROBE_TURNS; i++) await turn();
      try {
        const response = await this.answer(source, call, node);
        if (finished) return;
        const result: KubectlResult = {
          exitCode: response.exitCode,
          stdout: response.stdout ?? '',
          stderr: this.redactor.redact(response.stderr ?? ''),
        };
        call.result = result;
        if (result.stdout) stdout.write(result.stdout);
        if (result.stderr) stderr.write(result.stderr);
        finish(result.exitCode);
      } catch (error) {
        if (finished) return;
        finished = true;
        this.open -= 1;
        stdout.end();
        stderr.end();
        reject(error);
      }
    };
    const stdin = new Writable({
      write(chunk: unknown, _encoding, callback) {
        received.push(toBytes(chunk));
        call.stdin = concatBytes(received);
        callback();
      },
      final(callback) {
        callback();
        void respond();
      },
    });
    return {
      stdin,
      stdout,
      stderr,
      done,
      close: () => {
        if (finished) return;
        call.closed = true;
        finish(CLOSED_CHANNEL_EXIT);
      },
    };
  }
}
