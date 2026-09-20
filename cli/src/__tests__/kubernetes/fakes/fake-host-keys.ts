// FakeHostKeys (design-05 3.5, design-07 R-S6-07): a scriptable stand-in for `HostKeyStore` used by
// coordinator tests that need host-key outcomes (matched, recorded, mismatched, skipped) without a
// project directory, a CI-secret environment or real ssh2 key bytes. `FakeSetupTransport` is the
// only caller: it plays the SSH layer's part by offering each node's key to `verifierFor`, exactly
// as the real transport does over an actual connection (host-keys.ts `decide`).

import { createHash } from 'node:crypto';
import type { HostVerifier } from 'ssh2';
import type { HostKeyDecision, HostKeyPin, HostKeyVerification } from '../../../commands/setup/k3s/host-keys';
import { sshFingerprint } from '../../../commands/setup/k3s/host-keys';
import type { SetupProblem } from '../../../commands/setup/k3s/messages';
import type { K3sNodeSpec } from '../../../commands/setup/k3s/plan';

export interface FakeHostKeyScript {
  /** a pin already on file / in a CI secret; omit to simulate first contact (TOFU) */
  pin?: Buffer;
  /** forces `refusalFor` before any key is offered (mirrors `--require-host-key` / password-on-unverified-host) */
  refuse?: SetupProblem;
}

/**
 * Deterministic, ed25519-shaped key bytes distinct per seed. Never a real key — `HostKeyStore` only
 * hashes and compares them, so any byte string of plausible shape (4-byte length prefix, algorithm
 * name, body) works.
 */
export function fakeHostKey(seed: string): Buffer {
  const type = Buffer.from('ssh-ed25519', 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  const body = createHash('sha256').update(seed).digest();
  return Buffer.concat([length, type, body]);
}

export class FakeHostKeys implements HostKeyVerification {
  readonly decisions: HostKeyDecision[] = [];
  /** pins accepted this run (would be written to `.dockflow/known_hosts` for real), key -> bytes */
  readonly persisted = new Map<string, Buffer>();
  /** incremented on every `persistRecorded()` call, for "written once per run" assertions */
  persistCalls = 0;
  private lastError: SetupProblem | null = null;
  private readonly scripts = new Map<string, FakeHostKeyScript>();

  constructor(private readonly options: { insecureHostKey?: boolean; requireHostKey?: boolean } = {}) {}

  /** configures node `key`'s pin and/or refusal before the run; chainable */
  script(key: string, script: FakeHostKeyScript): this {
    this.scripts.set(key, script);
    return this;
  }

  lookup(node: K3sNodeSpec): HostKeyPin | null {
    const pin = this.scripts.get(node.key)?.pin;
    return pin === undefined ? null : { key: node.key, host: node.ssh.host, port: node.ssh.port, type: 'ssh-ed25519', base64: pin.toString('base64') };
  }

  fileConflictsWithEnv(): boolean {
    return false;
  }

  refusalFor(node: K3sNodeSpec, options: { usesPassword: boolean }): SetupProblem | null {
    const scripted = this.scripts.get(node.key)?.refuse;
    if (scripted !== undefined) return scripted;
    if (this.options.insecureHostKey) return null;
    if (this.lookup(node) !== null) return null;
    if (this.options.requireHostKey) {
      return { message: `${node.key} has no recorded SSH host key`, suggestion: `Record it once with dockflow setup k3s, or set the CI secret.` };
    }
    if (options.usesPassword) {
      return { message: `Password bootstrap needs a recorded SSH host key for ${node.key} when no terminal can confirm it`, suggestion: 'Record the host key once, or pass --insecure-host-key knowingly.' };
    }
    return null;
  }

  takeError(): SetupProblem | null {
    const error = this.lastError;
    this.lastError = null;
    return error;
  }

  /** offered `key` is decided against the node's scripted pin, exactly as host-keys.ts's `decide` would. */
  verifierFor(node: K3sNodeSpec, onDecision: (decision: HostKeyDecision) => void): HostVerifier {
    return (key, verify) => {
      const fingerprint = sshFingerprint(key);
      const record = (decision: HostKeyDecision): void => {
        this.decisions.push(decision);
        onDecision(decision);
      };
      const pin = this.scripts.get(node.key)?.pin;
      if (pin !== undefined) {
        if (pin.equals(key)) {
          record({ key: node.key, fingerprint, outcome: 'matched' });
          verify(true);
          return;
        }
        this.lastError = {
          message: `The SSH host key of ${node.key} (${node.ssh.host}:${node.ssh.port}) changed`,
          suggestion: `Compare the fingerprints out of band: recorded ${sshFingerprint(pin)}, offered ${fingerprint}.`,
        };
        verify(false);
        return;
      }
      if (this.options.insecureHostKey) {
        record({ key: node.key, fingerprint, outcome: 'skipped' });
        verify(true);
        return;
      }
      if (this.options.requireHostKey) {
        this.lastError = { message: `${node.key} has no recorded SSH host key`, suggestion: 'Record it once, or set the CI secret.' };
        verify(false);
        return;
      }
      record({ key: node.key, fingerprint, outcome: 'recorded' });
      this.persisted.set(node.key, key);
      verify(true);
    };
  }

  /** the fake keeps recorded pins in `persisted`/`decisions`; nothing is written to disk. */
  persistRecorded(): void {
    this.persistCalls += 1;
  }
}
