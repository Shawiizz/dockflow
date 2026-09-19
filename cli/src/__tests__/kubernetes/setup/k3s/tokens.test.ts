import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  K3S_AGENT_TOKEN_FILE,
  K3S_DOCKFLOW_DIR,
  K3S_TOKEN_FILE,
} from '../../../../commands/setup/k3s/constants';
import { setupMessages } from '../../../../commands/setup/k3s/messages';
import {
  buildClusterPlan,
  buildNodePlan,
  finalizeClusterPlan,
  type K3sNodeInspection,
  type K3sSetupOptions,
} from '../../../../commands/setup/k3s/plan';
import { parseNodePlan } from '../../../../commands/setup/k3s/schema';
import {
  checkClusterTokens,
  type ClusterTokens,
  generateAgentToken,
  NO_TOKENS,
  TOKEN_DIRECTORY,
  tokenCaHash,
  tokenCredential,
  tokenFilesFor,
  tokenFingerprint,
  tokensFor,
} from '../../../../commands/setup/k3s/tokens';
import type { ResolvedServer } from '../../../../types/servers';
import { sha256Hex } from '../../../../utils/hash';

const CA = 'a1b2c3d4'.repeat(8);
const SERVER_TOKEN = `K10${CA}::server:7f3e9c1d5a2b4e6f8091a2b3c4d5e6f7`;
const AGENT_TOKEN = `K10${CA}::node:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
const TOKENS: ClusterTokens = { server: SERVER_TOKEN, agent: AGENT_TOKEN };
const DEPLOY_KEY = readFileSync(join(import.meta.dir, 'golden', 'keys', 'deploy_ed25519'), 'utf8');

function noLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SERVER_TOKEN, AGENT_TOKEN, tokenCredential(SERVER_TOKEN), tokenCredential(AGENT_TOKEN)]) {
    expect(text).not.toContain(secret);
  }
}

describe('agent token generation (T1, U-SETUP-TOKENS-01)', () => {
  it('is 32 random bytes as 64 hex characters', () => {
    const token = generateAgentToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateAgentToken()).not.toBe(token);
  });

  it('uses the injected random source', () => {
    const sizes: number[] = [];
    const token = generateAgentToken((size) => {
      sizes.push(size);
      return new Uint8Array(size).fill(0xab);
    });
    expect(sizes).toEqual([32]);
    expect(token).toBe('ab'.repeat(32));
  });

  it('refuses a short random source', () => {
    expect(() => generateAgentToken(() => new Uint8Array(8))).toThrow('Expected 32 random bytes, got 8');
  });
});

describe('token fingerprints (T2)', () => {
  it('fingerprints the credential part of a secure token', () => {
    expect(tokenFingerprint('K10abc::node:xyz')).toBe(tokenFingerprint('xyz'));
    expect(tokenFingerprint('K10abc::server:xyz')).toBe(sha256Hex('xyz'));
    expect(tokenFingerprint(`${AGENT_TOKEN}\n`)).toBe(tokenFingerprint(tokenCredential(AGENT_TOKEN)));
    expect(tokenFingerprint('plain-token')).toBe(sha256Hex('plain-token'));
  });

  it('reads the CA hash a secure token pins', () => {
    expect(tokenCaHash(AGENT_TOKEN)).toBe(CA);
    expect(tokenCaHash('0123abcd')).toBeNull();
    expect(tokenCaHash('K10::node:x')).toBeNull();
  });
});

describe('token handoff (T3, U-SETUP-PLAN-09 as corrected by design-05 22.1)', () => {
  it('joining servers get both tokens, agents only the agent token', () => {
    expect(tokensFor('server', TOKENS)).toEqual({ server: SERVER_TOKEN, agent: AGENT_TOKEN });
    expect(tokensFor('agent', TOKENS)).toEqual({ server: null, agent: AGENT_TOKEN });
    expect(tokensFor('server-init', TOKENS)).toEqual({ server: null, agent: AGENT_TOKEN });
    expect(tokensFor('server-init', null)).toEqual(NO_TOKENS);
    expect(tokensFor('server', null)).toEqual(NO_TOKENS);
  });

  const options: K3sSetupOptions = {
    sshUser: 'root',
    dryRun: false,
    yes: false,
    upgrade: false,
    convertDatastore: false,
    sharedCluster: false,
    flannelBackend: null,
    skipFirewall: false,
    skipNetworkCheck: false,
    skipReachabilityCheck: false,
    insecureHostKey: false,
    requireHostKey: false,
    rotateDeployToken: false,
    binary: null,
    dev: false,
    interactive: false,
  };
  const server = (name: string, role: 'manager' | 'worker', privateHost: string): ResolvedServer => ({
    name,
    role,
    host: `203.0.113.${privateHost.split('.')[3]}`,
    privateHost,
    declaredPrivateHost: privateHost,
    nodeLabels: {},
    port: 22,
    user: 'deploy',
    env: {},
    tags: ['production'],
  });
  const servers = [
    server('srv-1', 'manager', '10.0.0.10'),
    server('srv-2', 'manager', '10.0.0.11'),
    server('srv-3', 'manager', '10.0.0.12'),
    server('worker-1', 'worker', '10.0.0.21'),
  ];
  const plan = buildClusterPlan({
    env: 'production',
    config: null,
    servers,
    deployKeys: Object.fromEntries(servers.map((s) => [s.name, DEPLOY_KEY])),
    options,
    dockflowVersion: '1.9.0',
  });
  const inspection = (ip: string): K3sNodeInspection => ({
    os: { id: 'ubuntu', versionId: '24.04', kernel: '6.8.0', arch: 'amd64', systemd: true, selinux: 'absent' },
    resources: { cpus: 4, memoryBytes: 8 * 1024 ** 3, varLibFreeBytes: 100 * 1024 ** 3 },
    network: { localIpv4: [ip], resolvedHost: null, defaultRouteIp: ip },
    commands: { missing: [], packageManager: 'apt' },
    k3s: {
      binaryVersion: null,
      unit: null,
      activeState: null,
      subState: null,
      managed: false,
      state: null,
      dropinSha256: null,
      restartSha256: null,
      dropin: null,
      foreignConfig: [],
      unitEnvK3sVars: [],
      tokenFingerprints: { token: null, agentToken: null },
      caSha256: null,
      datastore: null,
      apiReady: null,
      netcheckPresent: null,
      defaultStorageClasses: null,
    },
    helmVersion: null,
    firewall: { ufw: 'active', firewalld: 'absent' },
    portsInUse: [],
    swarmActive: false,
    dockerPresent: false,
    nmCloudSetupEnabled: false,
    wireguardAvailable: true,
    cgroupMemory: true,
    ntpSynchronized: true,
    deployUser: { exists: false, uid: null, home: null, keyAuthorized: false },
    legacySudoRules: [],
  });
  const cluster = finalizeClusterPlan(plan, {
    'srv-1': inspection('10.0.0.10'),
    'srv-2': inspection('10.0.0.11'),
    'srv-3': inspection('10.0.0.12'),
    'worker-1': inspection('10.0.0.21'),
  });

  it('the join-server install plan carries both tokens and the agent plan only the agent token', () => {
    expect(cluster.refusals).toEqual([]);
    const join = buildNodePlan({ operation: 'install', node: 'srv-2', arch: 'amd64', plan, cluster, tokens: TOKENS });
    expect(join.tokens).toEqual({ server: SERVER_TOKEN, agent: AGENT_TOKEN });
    const agent = buildNodePlan({ operation: 'install', node: 'worker-1', arch: 'amd64', plan, cluster, tokens: TOKENS });
    expect(agent.tokens).toEqual({ server: null, agent: AGENT_TOKEN });
    expect(JSON.stringify(agent)).not.toContain(tokenCredential(SERVER_TOKEN));
  });

  it('the bootstrap install of a fresh cluster and every other operation carry no token', () => {
    expect(buildNodePlan({ operation: 'install', node: 'srv-1', arch: 'amd64', plan, cluster, tokens: null }).tokens).toEqual(NO_TOKENS);
    for (const operation of ['prepare', 'control-plane', 'finalize', 'read-tokens', 'reset'] as const) {
      const nodePlan = buildNodePlan({ operation, node: 'srv-2', arch: 'amd64', plan, cluster, tokens: TOKENS });
      expect(nodePlan.tokens).toEqual(NO_TOKENS);
      noLeak(nodePlan);
    }
    noLeak(buildNodePlan({ operation: 'inspect', node: 'worker-1', arch: 'amd64', plan, tokens: TOKENS }));
  });

  it('the node step schema refuses an agent plan holding the server token and tokens outside install', () => {
    const agent = buildNodePlan({ operation: 'install', node: 'worker-1', arch: 'amd64', plan, cluster, tokens: TOKENS });
    const forged = { ...agent, tokens: { server: SERVER_TOKEN, agent: AGENT_TOKEN } };
    const refused = parseNodePlan(JSON.stringify(forged));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain('tokens.server: an agent plan never carries the server token');
      expect(refused.error).not.toContain(tokenCredential(SERVER_TOKEN));
    }
    const prepare = buildNodePlan({ operation: 'prepare', node: 'srv-2', arch: 'amd64', plan, cluster });
    const withTokens = parseNodePlan(JSON.stringify({ ...prepare, tokens: TOKENS }));
    expect(withTokens.success).toBe(false);
    if (!withTokens.success) expect(withTokens.error).toContain('only the install operation carries tokens');
  });
});

describe('checkClusterTokens (T4, C15)', () => {
  it('accepts a secure server token with a distinct agent token', () => {
    expect(checkClusterTokens('production', { server: `${SERVER_TOKEN}\n`, agent: AGENT_TOKEN, agentIsSymlink: false })).toEqual({
      success: true,
      data: TOKENS,
    });
  });

  it('refuses an agent-token symlink to the server token', () => {
    const result = checkClusterTokens('production', { server: SERVER_TOKEN, agent: SERVER_TOKEN, agentIsSymlink: true });
    expect(result).toEqual({ success: false, error: setupMessages.tokensEqual('production') });
    if (!result.success) {
      expect(result.error.message).toBe('The agent token of production equals the server token');
      expect(result.error.suggestion).toBe('Reset the cluster; Dockflow never hands the server token to agents.');
    }
  });

  it('refuses a symlink even when the contents differ', () => {
    expect(checkClusterTokens('production', { server: SERVER_TOKEN, agent: AGENT_TOKEN, agentIsSymlink: true }).success).toBe(false);
  });

  it('refuses equal tokens and an agent token holding the server credential', () => {
    expect(checkClusterTokens('production', { server: SERVER_TOKEN, agent: SERVER_TOKEN, agentIsSymlink: false })).toEqual({
      success: false,
      error: setupMessages.tokensEqual('production'),
    });
    const sameCredential = `K10${CA}::node:${tokenCredential(SERVER_TOKEN)}`;
    expect(checkClusterTokens('production', { server: SERVER_TOKEN, agent: sameCredential, agentIsSymlink: false })).toEqual({
      success: false,
      error: setupMessages.tokensEqual('production'),
    });
  });

  it('refuses tokens that are not k3s secure tokens', () => {
    expect(checkClusterTokens('production', { server: 'plain', agent: AGENT_TOKEN, agentIsSymlink: false })).toEqual({
      success: false,
      error: setupMessages.tokenMalformed('production', 'server'),
    });
    expect(checkClusterTokens('production', { server: SERVER_TOKEN, agent: 'f'.repeat(64), agentIsSymlink: false })).toEqual({
      success: false,
      error: setupMessages.tokenMalformed('production', 'agent'),
    });
  });

  it('never puts a token in a refusal (U-SETUP-TOKENS-03)', () => {
    for (const input of [
      { server: SERVER_TOKEN, agent: SERVER_TOKEN, agentIsSymlink: true },
      { server: SERVER_TOKEN, agent: SERVER_TOKEN, agentIsSymlink: false },
      { server: 'K10nope', agent: AGENT_TOKEN, agentIsSymlink: false },
      { server: SERVER_TOKEN, agent: 'K10x::server:abc', agentIsSymlink: false },
    ]) {
      const result = checkClusterTokens('production', input);
      expect(result.success).toBe(false);
      if (!result.success) noLeak(result.error);
    }
  });
});

describe('token files (T5)', () => {
  it('lives in a root 0700 directory, each file 0600 with one trailing newline', () => {
    expect(TOKEN_DIRECTORY).toEqual({ path: K3S_DOCKFLOW_DIR, mode: 0o700 });
    for (const file of tokenFilesFor('server', tokensFor('server', TOKENS))) {
      expect(file.mode).toBe(0o600);
      expect(file.path.startsWith(`${K3S_DOCKFLOW_DIR}/`)).toBe(true);
      expect(file.content.endsWith('\n')).toBe(true);
      expect(file.content.trimEnd()).not.toContain('\n');
    }
  });

  it('a joining server writes the server token to token-file and the agent token to agent-token-file', () => {
    expect(tokenFilesFor('server', tokensFor('server', TOKENS))).toEqual([
      { path: K3S_AGENT_TOKEN_FILE, content: `${AGENT_TOKEN}\n`, mode: 0o600 },
      { path: K3S_TOKEN_FILE, content: `${SERVER_TOKEN}\n`, mode: 0o600 },
    ]);
  });

  it('an agent writes only the agent token, to token-file', () => {
    expect(tokenFilesFor('agent', tokensFor('agent', TOKENS))).toEqual([{ path: K3S_TOKEN_FILE, content: `${AGENT_TOKEN}\n`, mode: 0o600 }]);
    noLeak(tokenFilesFor('agent', { server: SERVER_TOKEN, agent: null }).map((f) => f.content));
  });

  it('the bootstrap server of a fresh cluster writes the agent token it generated', () => {
    const generated = 'cd'.repeat(32);
    expect(tokenFilesFor('server-init', NO_TOKENS, generated)).toEqual([
      { path: K3S_AGENT_TOKEN_FILE, content: `${generated}\n`, mode: 0o600 },
    ]);
    expect(tokenFilesFor('server-init', tokensFor('server-init', TOKENS), generated)).toEqual([
      { path: K3S_AGENT_TOKEN_FILE, content: `${AGENT_TOKEN}\n`, mode: 0o600 },
    ]);
    expect(tokenFilesFor('server', NO_TOKENS, generated)).toEqual([]);
  });
});
