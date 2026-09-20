// The coordinator's SSH transport over the plan of design-05 3.3/3.5: one dedicated,
// host-key-verified bootstrap connection per node (opened once in prepareNode and kept for the
// whole run), a lazily-opened dedicated deploy-key connection per node for the identity checks of
// 16.3, and the `--k3s-plan` protocol of 3.4. Binary delivery and the node-step wire protocol are
// `remote.ts`'s exported primitives, reused so the cluster coordinator and the single-host remote
// flow speak the same protocol; this file adds only the per-node bookkeeping the coordinator needs
// (the temp dir and connections of one node) and the auth/sudo/arch steps that run once per node,
// before any operation.

import type { ConnectionInfo } from '../../../types';
import { ConnectionError } from '../../../utils/errors';
import { sshExec, sshExecChannelDedicated } from '../../../utils/ssh';
import {
  cleanupTempDir,
  deliverBinary,
  makeTempDir,
  type NodeEvent,
  type NodeStepOutcome,
  runNodeStep as runNodeStepOverSsh,
  verifyDeliveredVersion,
} from '../remote';
import type { HostKeyVerification } from './host-keys';
import { archFromMachine, type NodeBinary } from './install';
import type { K3sNodePlan, K3sNodeSpec, NodeArch } from './plan';

/** The identity used to open every bootstrap connection of one run (design-05 1.2, 3.3). */
export interface BootstrapIdentity {
  sshUser: string;
  privateKey?: string;
  password?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SetupTransport {
  /** SSH auth test, `id -u`, sudo check, `uname -m`, binary delivery into a private temp dir */
  prepareNode(node: K3sNodeSpec): Promise<void>;
  /** the architecture prepareNode found (`uname -m`), needed to pick correct pins for later plans */
  archOf(node: string): NodeArch;
  /** runs `<prefix> <dir>/dockflow setup --orchestrator k3s --k3s-plan -` with the plan JSON on stdin */
  runNodeStep(node: string, plan: K3sNodePlan, handlers: { onEvent(e: NodeEvent): void }, guardS: number): Promise<NodeStepOutcome>;
  /** deploy-user SSH (deploy key), used only for identity checks (16.3) */
  execAsDeployUser(node: string, command: string, guardS: number): Promise<ExecResult>;
  /** root SSH over the bootstrap connection: the reset coordinator's own cordon/drain/delete (18.3) */
  execAsRoot(node: string, command: string, guardS: number): Promise<ExecResult>;
  cleanup(): Promise<void>;
}

interface NodeState {
  spec: K3sNodeSpec;
  conn: ConnectionInfo;
  dir: string;
  root: boolean;
  arch: NodeArch;
}

async function execDedicated(conn: ConnectionInfo, command: string, guardS: number): Promise<ExecResult> {
  const channel = await sshExecChannelDedicated(conn, command);
  channel.stream.end();
  const timer = setTimeout(() => channel.close(), guardS * 1000);
  try {
    return await channel.done;
  } finally {
    clearTimeout(timer);
    channel.close();
  }
}

/** `arch` resolved lazily and cached: release mode already has every hash, --binary/--dev hash or build once per architecture. */
export type BinaryResolver = (arch: NodeArch) => Promise<NodeBinary>;

export interface CreateSetupTransportOptions {
  /** deploy private key per servers.yml key, for the 16.3 identity connection */
  deployKeys: Readonly<Record<string, string | undefined>>;
}

/**
 * The `SetupTransport` over real SSH connections. Every bootstrap connection is dedicated and
 * host-key-verified (3.5, never the pool); binary delivery and the node-step protocol are
 * `remote.ts`'s exported primitives.
 */
export function createSshSetupTransport(
  bootstrap: BootstrapIdentity,
  resolveBinary: BinaryResolver,
  hostKeys: HostKeyVerification,
  options: CreateSetupTransportOptions,
): SetupTransport {
  const nodes = new Map<string, NodeState>();

  function bootstrapConnectionFor(node: K3sNodeSpec): ConnectionInfo {
    const verifier = hostKeys.verifierFor(node, () => {});
    if (bootstrap.privateKey !== undefined) {
      return {
        host: node.ssh.host,
        port: node.ssh.port,
        user: bootstrap.sshUser,
        privateKey: bootstrap.privateKey,
        ...(bootstrap.password !== undefined ? { password: bootstrap.password } : {}),
        hostVerifier: verifier,
      };
    }
    return { host: node.ssh.host, port: node.ssh.port, user: bootstrap.sshUser, password: bootstrap.password ?? '', hostVerifier: verifier };
  }

  function deployConnectionFor(node: K3sNodeSpec): ConnectionInfo {
    const privateKey = options.deployKeys[node.key];
    if (privateKey === undefined) throw new Error(`No deploy key resolved for ${node.key}`);
    return { host: node.ssh.host, port: node.ssh.port, user: node.deployUser, privateKey, hostVerifier: hostKeys.verifierFor(node, () => {}) };
  }

  function stateFor(nodeKey: string): NodeState {
    const state = nodes.get(nodeKey);
    if (state === undefined) throw new Error(`${nodeKey} was never prepared`);
    return state;
  }

  return {
    async prepareNode(node) {
      const refusal = hostKeys.refusalFor(node, { usesPassword: bootstrap.privateKey === undefined });
      if (refusal !== null) throw new ConnectionError(refusal.message, refusal.suggestion);

      const conn = bootstrapConnectionFor(node);
      let auth: ExecResult;
      try {
        auth = await sshExec(conn, 'echo dockflow-ok');
      } catch (error) {
        const hostKeyError = hostKeys.takeError();
        if (hostKeyError !== null) throw new ConnectionError(hostKeyError.message, hostKeyError.suggestion);
        throw new ConnectionError(`${node.key}: ${error instanceof Error ? error.message : String(error)}`, 'Check the bootstrap host, port and credentials of this node.');
      }
      const hostKeyError = hostKeys.takeError();
      if (hostKeyError !== null) throw new ConnectionError(hostKeyError.message, hostKeyError.suggestion);
      if (auth.exitCode !== 0 || !auth.stdout.includes('dockflow-ok')) {
        throw new ConnectionError(`${node.key}: connected but the bootstrap command failed`, 'Check that the bootstrap user has shell access.');
      }

      const idResult = await sshExec(conn, 'id -u');
      const uid = Number.parseInt(idResult.stdout.trim(), 10);
      const root = uid === 0;
      if (!root) {
        const sudoResult = await sshExec(conn, 'sudo -n true');
        if (sudoResult.exitCode !== 0) {
          throw new ConnectionError(
            `Bootstrap user ${bootstrap.sshUser} on ${node.key} cannot use sudo without a password`,
            `Connect as root with --ssh-user root, or grant ${bootstrap.sshUser} passwordless sudo for the duration of setup.`,
          );
        }
      }

      const archResult = await sshExec(conn, 'uname -m');
      const arch = archFromMachine(archResult.stdout);
      if (arch === null) {
        throw new ConnectionError(
          `Unsupported architecture ${archResult.stdout.trim()} on ${node.key}; k3s nodes must be amd64 or arm64`,
          'Use an amd64 (x86_64) or arm64 (aarch64) machine.',
        );
      }

      const dir = await makeTempDir(conn);
      const binary = await resolveBinary(arch);
      await deliverBinary(conn, dir, binary, node.key);
      await verifyDeliveredVersion(conn, dir, node.key);

      nodes.set(node.key, { spec: node, conn, dir, root, arch });
    },

    archOf(nodeKey) {
      return stateFor(nodeKey).arch;
    },

    runNodeStep(nodeKey, plan, handlers, guardS) {
      const state = stateFor(nodeKey);
      return runNodeStepOverSsh(state.conn, state.dir, plan, handlers, guardS);
    },

    execAsDeployUser(nodeKey, command, guardS) {
      const state = stateFor(nodeKey);
      return execDedicated(deployConnectionFor(state.spec), command, guardS);
    },

    execAsRoot(nodeKey, command, guardS) {
      const state = stateFor(nodeKey);
      const escaped = command.replace(/'/g, "'\\''");
      const prefixed = state.root ? command : `sudo -n -- sh -c '${escaped}'`;
      return execDedicated(state.conn, prefixed, guardS);
    },

    async cleanup() {
      for (const state of nodes.values()) await cleanupTempDir(state.conn, state.dir);
    },
  };
}
