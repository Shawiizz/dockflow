// Cluster tokens (design-05 6, DESIGN-CORE C15): the agent token Dockflow generates, fingerprints for
// drift, the handoff rule (a joining server gets the server AND the agent token, an agent only the
// agent token) and the refusal when both tokens are one credential. Tokens never leave these
// structures for argv, environment, logs or messages.

import { randomBytes } from 'crypto';
import { err, ok, type Result } from '../../../types/result';
import { sha256Hex } from '../../../utils/hash';
import {
  AGENT_TOKEN_BYTES,
  K3S_AGENT_TOKEN_FILE,
  K3S_DOCKFLOW_DIR,
  K3S_DOCKFLOW_DIR_MODE,
  K3S_SECRET_FILE_MODE,
  K3S_TOKEN_FILE,
} from './constants';
import { type SetupProblem, setupMessages } from './messages';
import type { K3sNodeRole } from './plan';

/** The pair read from the first server: `server/token` and `server/agent-token`. */
export interface ClusterTokens {
  server: string;
  agent: string;
}

/** What one node's install plan carries (K3sNodePlan.tokens). */
export interface NodeTokens {
  server: string | null;
  agent: string | null;
}

export const NO_TOKENS: NodeTokens = Object.freeze({ server: null, agent: null });

const SECURE_PREFIX = 'K10';
const SERVER_MARKER = '::server:';
const NODE_MARKER = '::node:';

/** 32 random bytes, hex (64 characters); `random` is injectable for tests. */
export function generateAgentToken(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(AGENT_TOKEN_BYTES);
  if (bytes.length !== AGENT_TOKEN_BYTES) throw new Error(`Expected ${AGENT_TOKEN_BYTES} random bytes, got ${bytes.length}`);
  return Buffer.from(bytes).toString('hex');
}

/** The password part of a k3s secure token (`K10<ca>::server:<p>` / `::node:<p>`), else the whole token. */
export function tokenCredential(token: string): string {
  const value = token.trim();
  if (!value.startsWith(SECURE_PREFIX)) return value;
  for (const marker of [SERVER_MARKER, NODE_MARKER]) {
    const at = value.indexOf(marker);
    if (at !== -1) return value.slice(at + marker.length);
  }
  return value;
}

/** sha256 of the credential part: equal for the secure and the bare form of one token (6.1). */
export function tokenFingerprint(token: string): string {
  return sha256Hex(tokenCredential(token));
}

/** The CA hash a secure token pins (`K10<hash>::...`), null for a bare token. */
export function tokenCaHash(token: string): string | null {
  const value = token.trim();
  if (!value.startsWith(SECURE_PREFIX)) return null;
  const end = value.indexOf('::');
  return end > SECURE_PREFIX.length ? value.slice(SECURE_PREFIX.length, end) : null;
}

export interface TokenPairInput {
  server: string;
  agent: string;
  /** `server/agent-token` is a symlink (to `server/token` when k3s never had an agent token) */
  agentIsSymlink: boolean;
}

/**
 * Validates the pair `read-tokens` returns (4.6). An agent token that is a symlink, or that holds the
 * server credential, would hand agents a control-plane credential: refused (C15).
 */
export function checkClusterTokens(env: string, input: TokenPairInput): Result<ClusterTokens, SetupProblem> {
  const server = input.server.trim();
  const agent = input.agent.trim();
  if (!server.startsWith(SECURE_PREFIX) || !server.includes(SERVER_MARKER)) return err(setupMessages.tokenMalformed(env, 'server'));
  if (input.agentIsSymlink || agent === server || tokenCredential(agent) === tokenCredential(server)) {
    return err(setupMessages.tokensEqual(env));
  }
  if (!agent.startsWith(SECURE_PREFIX) || !agent.includes(NODE_MARKER)) return err(setupMessages.tokenMalformed(env, 'agent'));
  return ok({ server, agent });
}

/**
 * The tokens one node's install plan carries (6.1, 6.2). The server that bootstraps a fresh cluster
 * gets none (k3s generates the server token, the node step the agent token); on an existing cluster it
 * gets the agent token back to check its `agent-token-file`. Joining servers get both; agents only
 * ever the agent token.
 */
export function tokensFor(role: K3sNodeRole, tokens: ClusterTokens | null): NodeTokens {
  if (tokens === null) return { ...NO_TOKENS };
  if (role === 'server') return { server: tokens.server, agent: tokens.agent };
  return { server: null, agent: tokens.agent };
}

export interface TokenFile {
  path: string;
  /** token followed by a newline */
  content: string;
  mode: number;
}

/**
 * The token files an install writes (6.1): the directory is root 0700 and each file root 0600,
 * written atomically by the node step. A bootstrap server without tokens writes its generated
 * agent token.
 */
export function tokenFilesFor(role: K3sNodeRole, tokens: NodeTokens, generatedAgentToken: string | null = null): TokenFile[] {
  const file = (path: string, token: string): TokenFile => ({ path, content: `${token.trim()}\n`, mode: K3S_SECRET_FILE_MODE });
  const files: TokenFile[] = [];
  if (role === 'agent') {
    if (tokens.agent !== null) files.push(file(K3S_TOKEN_FILE, tokens.agent));
    return files;
  }
  const agent = tokens.agent ?? (role === 'server-init' ? generatedAgentToken : null);
  if (agent !== null) files.push(file(K3S_AGENT_TOKEN_FILE, agent));
  if (role === 'server' && tokens.server !== null) files.push(file(K3S_TOKEN_FILE, tokens.server));
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const TOKEN_DIRECTORY = { path: K3S_DOCKFLOW_DIR, mode: K3S_DOCKFLOW_DIR_MODE } as const;
