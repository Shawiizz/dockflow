// SSH host key verification for the setup transport only (design-05 3.5, K60, deviation DV-S4).
// Every other Dockflow SSH connection still accepts any host key (D25, `utils/ssh.ts`
// `hostVerifier: () => true`); this channel carries the k3s server token, the agent token, root
// command execution and, with --password, the bootstrap password itself, so it deviates.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostVerifier } from 'ssh2';
import { getCISecret, serverNameToEnvKey } from '../../../utils/servers/ci-secrets';
import type { SetupProblem } from './messages';
import type { K3sNodeSpec } from './plan';

export interface HostKeyPin {
  /** servers.yml key */
  key: string;
  host: string;
  port: number;
  /** e.g. `ssh-ed25519`, matching the known_hosts algorithm name */
  type: string;
  base64: string;
}

export interface HostKeyDecision {
  key: string;
  fingerprint: string;
  outcome: 'matched' | 'recorded' | 'skipped';
}

/**
 * The surface `transport.ts` and the coordinator (`index.ts`) need from a host-key store: extracted
 * so `T/fakes/fake-host-keys.ts` can stand in for it (design-07 R-S6-07) without a real filesystem or
 * CI-secret environment.
 */
export interface HostKeyVerification {
  readonly decisions: HostKeyDecision[];
  lookup(node: K3sNodeSpec): HostKeyPin | null;
  fileConflictsWithEnv(node: K3sNodeSpec): boolean;
  refusalFor(node: K3sNodeSpec, options: { usesPassword: boolean }): SetupProblem | null;
  takeError(): SetupProblem | null;
  verifierFor(node: K3sNodeSpec, onDecision: (decision: HostKeyDecision) => void): HostVerifier;
  persistRecorded(): void;
}

export interface HostKeyStoreOptions {
  insecureHostKey: boolean;
  requireHostKey: boolean;
  /** stdin and stdout are a terminal: a first-contact key can be confirmed at a prompt */
  interactive: boolean;
  /** default: commands/setup/prompts.ts `confirm` */
  confirm?: (question: string) => Promise<boolean>;
  /** printed for a first-contact TOFU record and for --insecure-host-key */
  onWarning?: (message: string) => void;
}

const KNOWN_HOSTS_MODE = 0o600;
const KNOWN_HOSTS_DIR_MODE = 0o700;

/** `ssh-keygen -lf` format: SHA256 of the raw key blob, base64 without padding. */
export function sshFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** The algorithm name at the head of the wire-format public key blob (`ssh-ed25519`, ...). */
function algorithmOf(key: Buffer): string {
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString('ascii');
}

function fingerprintOfPin(pin: HostKeyPin): string {
  return sshFingerprint(Buffer.from(pin.base64, 'base64'));
}

/** `<servers.yml key> <host> <port> <type> <base64>` (renderLine's own format, 5 whitespace-separated fields). */
function parseLine(line: string): HostKeyPin | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [key, host, portText, type, base64] = parts;
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port)) return null;
  return { key, host, port, type, base64 };
}

function renderLine(pin: HostKeyPin): string {
  return `${pin.key} ${pin.host} ${pin.port} ${pin.type} ${pin.base64}`;
}

/**
 * `.dockflow/known_hosts` (project file, 0600) plus `<ENV>_<KEY>_HOST_KEY` from `.env.dockflow` / CI
 * secrets, which takes precedence over the file (6.1 the CI secret convention already covers it, no
 * `servers.yml` schema change). A mismatch refuses before any other node is touched.
 */
export class HostKeyStore implements HostKeyVerification {
  readonly decisions: HostKeyDecision[] = [];
  private readonly filePath: string;
  private readonly recorded = new Map<string, HostKeyPin>();
  private readonly pending: HostKeyPin[] = [];
  private lastError: SetupProblem | null = null;

  constructor(
    private readonly projectDir: string,
    private readonly env: string,
    private readonly options: HostKeyStoreOptions,
  ) {
    this.filePath = join(projectDir, '.dockflow', 'known_hosts');
    if (existsSync(this.filePath)) {
      for (const line of readFileSync(this.filePath, 'utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const pin = parseLine(line);
        if (pin !== null) this.recorded.set(pin.key, pin);
      }
    }
  }

  private envKeyName(key: string): string {
    return `${this.env.toUpperCase()}_${serverNameToEnvKey(key)}_HOST_KEY`;
  }

  private envPin(node: K3sNodeSpec): HostKeyPin | null {
    const raw = getCISecret(this.env, node.key, 'HOST_KEY');
    if (raw === undefined) return null;
    const at = raw.trim().indexOf(' ');
    if (at === -1) return null;
    return { key: node.key, host: node.ssh.host, port: node.ssh.port, type: raw.slice(0, at).trim(), base64: raw.slice(at + 1).trim() };
  }

  /** The env secret wins over the file; a conflicting file entry is reported by the caller. */
  lookup(node: K3sNodeSpec): HostKeyPin | null {
    return this.envPin(node) ?? this.recorded.get(node.key) ?? null;
  }

  /** Whether the file also holds a pin for `node` that the env secret overrides (HK6). */
  fileConflictsWithEnv(node: K3sNodeSpec): boolean {
    const env = this.envPin(node);
    const file = this.recorded.get(node.key);
    return env !== null && file !== undefined && file.base64 !== env.base64;
  }

  /**
   * Refusals that never need the actual host key, checked before a node is even connected to:
   * `--require-host-key` without a pin, and `--password` on an unverified host outside a terminal.
   */
  refusalFor(node: K3sNodeSpec, options: { usesPassword: boolean }): SetupProblem | null {
    if (this.lookup(node) !== null || this.options.insecureHostKey) return null;
    if (this.options.requireHostKey) {
      return {
        message: `${node.key} has no recorded SSH host key`,
        suggestion: `Record it once with \`dockflow setup k3s ${this.env}\` from a terminal, or set ${this.envKeyName(node.key)} in the CI secrets.`,
      };
    }
    if (options.usesPassword && !this.options.interactive) {
      return {
        message: `Password bootstrap needs a recorded SSH host key for ${node.key} when no terminal can confirm it`,
        suggestion: `Record the host key once from a terminal, set ${this.envKeyName(node.key)}, or pass \`--insecure-host-key\` knowingly.`,
      };
    }
    return null;
  }

  /** The most recent refusal a returned verifier produced (`verify(false)`), for the caller to throw. */
  takeError(): SetupProblem | null {
    const error = this.lastError;
    this.lastError = null;
    return error;
  }

  /** The verifier passed to the SSH layer for one node's bootstrap connection (3.5 table). */
  verifierFor(node: K3sNodeSpec, onDecision: (decision: HostKeyDecision) => void): HostVerifier {
    return (key, verify) => {
      this.decide(node, key, onDecision).then(verify, () => verify(false));
    };
  }

  private record(decision: HostKeyDecision, onDecision: (decision: HostKeyDecision) => void): void {
    this.decisions.push(decision);
    onDecision(decision);
  }

  private async decide(node: K3sNodeSpec, key: Buffer, onDecision: (decision: HostKeyDecision) => void): Promise<boolean> {
    const fingerprint = sshFingerprint(key);
    const pin = this.lookup(node);
    // Setup opens several connections per node: a key first seen earlier in this run is the pin for
    // the rest of it, so a later connection neither warns again nor accepts a different key.
    const firstContact = pin === null ? this.pending.find((pending) => pending.key === node.key) : undefined;
    if (firstContact !== undefined) {
      if (firstContact.base64 === key.toString('base64')) return true;
      this.lastError = {
        message: `The SSH host key of ${node.key} (${node.ssh.host}:${node.ssh.port}) changed during this run`,
        suggestion: `Compare the fingerprints out of band: first contact ${fingerprintOfPin(firstContact)}, now ${fingerprint}. Run setup again once the host is trusted.`,
      };
      return false;
    }
    if (pin !== null) {
      if (pin.base64 === key.toString('base64')) {
        this.record({ key: node.key, fingerprint, outcome: 'matched' }, onDecision);
        return true;
      }
      this.lastError = {
        message: `The SSH host key of ${node.key} (${node.ssh.host}:${node.ssh.port}) changed`,
        suggestion: `Compare the fingerprints out of band: recorded ${fingerprintOfPin(pin)}, offered ${fingerprint}. If the machine was rebuilt, remove its line from .dockflow/known_hosts (or update the ${this.envKeyName(node.key)} secret) and run setup again.`,
      };
      return false;
    }
    if (this.options.insecureHostKey) {
      this.record({ key: node.key, fingerprint, outcome: 'skipped' }, onDecision);
      this.options.onWarning?.(`Host key verification is disabled for ${node.key}`);
      return true;
    }
    if (this.options.requireHostKey) {
      this.lastError = {
        message: `${node.key} has no recorded SSH host key`,
        suggestion: `Record it once with \`dockflow setup k3s ${this.env}\` from a terminal, or set ${this.envKeyName(node.key)} in the CI secrets.`,
      };
      return false;
    }
    const newPin: HostKeyPin = { key: node.key, host: node.ssh.host, port: node.ssh.port, type: algorithmOf(key), base64: key.toString('base64') };
    if (this.options.interactive) {
      const confirm = this.options.confirm ?? defaultConfirm;
      const accepted = await confirm(`Host key of ${node.key} (${node.ssh.host}:${node.ssh.port}) is ${fingerprint}; accept and record it?`);
      if (!accepted) {
        this.lastError = { message: `Host key of ${node.key} was not accepted`, suggestion: 'Run setup again and accept the fingerprint once you have compared it out of band.' };
        return false;
      }
      this.pending.push(newPin);
      this.record({ key: node.key, fingerprint, outcome: 'recorded' }, onDecision);
      return true;
    }
    this.pending.push(newPin);
    this.record({ key: node.key, fingerprint, outcome: 'recorded' }, onDecision);
    this.options.onWarning?.(
      `Recorded the SSH host key of ${node.key} on first contact (${fingerprint}); Dockflow could not verify it`,
    );
    return true;
  }

  /** Appended once per run, after every node was accepted, atomically (0600). */
  persistRecorded(): void {
    if (this.pending.length === 0) return;
    for (const pin of this.pending) this.recorded.set(pin.key, pin);
    this.pending.length = 0;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: KNOWN_HOSTS_DIR_MODE });
    const lines = [...this.recorded.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(renderLine);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: KNOWN_HOSTS_MODE });
    renameSync(tmp, this.filePath);
  }
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { confirm } = await import('../prompts');
  return confirm(question, false);
}
