// zod mirrors of the documents that cross the setup channel: the node plan read by the node step
// on stdin (tokens inside, design-05 3.4), the inspection it returns and its state.json. The type
// assertions at the end keep each schema and its TypeScript type identical.

import { z } from 'zod';
import { err, ok, type Result } from '../../../types/result';
import { NODE_PLAN_MAX_BYTES } from './constants';
import type { K3sNodeInspection, K3sNodePlan, NodeStateFile } from './plan';

const SERVER_KEY = z.string().max(63).regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/);
const NODE_NAME = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const IPV4 = z.ipv4();
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const HTTPS_URL = z.string().regex(/^https:\/\/[^\s]+$/);
const LINUX_USER = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);
const PUBLIC_KEY_LINE = z.string().regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,2} dockflow-deploy$/);
/** printable ASCII without spaces: a token is written to a file followed by one newline */
const TOKEN = z.string().min(1).max(4096).regex(/^[!-~]+$/);
const INTERFACE = z.string().regex(/^[a-z0-9.-]+$/);
const JOIN_URL = z.string().regex(/^https:\/\/(\d{1,3}\.){3}\d{1,3}:6443$/);

const ROLE = z.enum(['server-init', 'server', 'agent']);
const BACKEND = z.enum(['vxlan', 'wireguard-native']);
const ADDRESS_MODE = z.enum(['private', 'public']);
const DATASTORE = z.enum(['sqlite', 'etcd']);
const OPERATION = z.enum(['inspect', 'prepare', 'install', 'control-plane', 'read-tokens', 'finalize', 'reset']);
const ACTION_KIND = z.enum(['install', 'repair', 'noop', 'start', 'reconfigure', 'upgrade', 'convert-to-etcd']);
const LABELS = z.record(z.string(), z.string());

const DownloadPinSchema = z.strictObject({ url: HTTPS_URL, sha256: SHA256 });

export const K3sNodeSpecSchema = z.strictObject({
  key: SERVER_KEY,
  nodeName: NODE_NAME,
  role: ROLE,
  ssh: z.strictObject({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  deployUser: LINUX_USER,
  deployPublicKey: PUBLIC_KEY_LINE.nullable(),
  privateHost: IPV4.nullable(),
  hostName: z.string().min(1).nullable(),
  hostIp: IPV4.nullable(),
  nodeLabels: LABELS,
});

export const K3sNodeNetworkSchema = z.strictObject({
  privateIp: IPV4.nullable(),
  publicIp: IPV4.nullable(),
  nodeIp: IPV4.nullable(),
  nodeExternalIp: IPV4.nullable(),
  peerSources: z.array(IPV4),
  serverPeerSources: z.array(IPV4),
  cniInterfaces: z.array(INTERFACE),
});

export const NodeActionSchema = z.strictObject({
  kind: ACTION_KIND,
  changedKeys: z.array(z.string()),
  fromVersion: z.string().nullable(),
  toVersion: z.string().min(1),
});

const ClusterSchema = z.strictObject({
  addressMode: ADDRESS_MODE,
  flannelBackend: BACKEND,
  datastore: DATASTORE,
  clusterInit: z.boolean(),
  network: K3sNodeNetworkSchema,
  joinUrl: JOIN_URL.nullable(),
  action: NodeActionSchema,
  proxyPorts: z.strictObject({ http: z.boolean(), https: z.boolean() }),
  firewallTool: z.enum(['ufw', 'firewalld']).nullable(),
  nodes: z.array(
    z.strictObject({ key: SERVER_KEY, nodeName: NODE_NAME, role: ROLE, nodeIp: IPV4.nullable(), nodeLabels: LABELS }),
  ),
  takeEtcdSnapshot: z.boolean(),
});

export const K3sNodePlanSchema = z
  .strictObject({
    schema: z.literal(1),
    operation: OPERATION,
    dockflowVersion: z.string().min(1),
    /** '' in local single-host mode */
    env: z.string(),
    node: K3sNodeSpecSchema,
    cluster: ClusterSchema.optional(),
    pins: z.strictObject({
      k3s: z.strictObject({ version: z.string().min(1), binary: DownloadPinSchema, installScript: DownloadPinSchema }),
      helm: z.strictObject({ version: z.string().min(1), archive: DownloadPinSchema }).nullable(),
    }),
    tokens: z.strictObject({ server: TOKEN.nullable(), agent: TOKEN.nullable() }),
    options: z.strictObject({
      skipFirewall: z.boolean(),
      skipNetworkCheck: z.boolean(),
      rotateDeployToken: z.boolean(),
      deleteVolumes: z.boolean(),
      sharedCluster: z.boolean(),
    }),
  })
  .superRefine((plan, ctx) => {
    if (plan.operation !== 'inspect' && plan.cluster === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cluster'], message: `the ${plan.operation} operation needs the cluster section` });
    }
    if (plan.operation !== 'install' && (plan.tokens.server !== null || plan.tokens.agent !== null)) {
      ctx.addIssue({ code: 'custom', path: ['tokens'], message: 'only the install operation carries tokens' });
    }
    // C15: an agent never receives the cluster-admin server token
    if (plan.node.role === 'agent' && plan.tokens.server !== null) {
      ctx.addIssue({ code: 'custom', path: ['tokens', 'server'], message: 'an agent plan never carries the server token' });
    }
  });

export const NodeStateFileSchema = z.object({
  schema: z.literal(1),
  managedBy: z.literal('dockflow'),
  dockflowVersion: z.string(),
  envs: z.array(z.string()),
  nodeName: z.string(),
  role: z.enum(['server', 'agent']),
  clusterInit: z.boolean(),
  datastore: DATASTORE.nullable(),
  flannelBackend: BACKEND,
  k3sVersion: z.string(),
  configSha256: z.string(),
  restartSha256: z.string(),
  caSha256: z.string().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
});

export const K3sNodeInspectionSchema = z.object({
  os: z.object({
    id: z.string(),
    versionId: z.string(),
    kernel: z.string(),
    arch: z.enum(['amd64', 'arm64']),
    systemd: z.boolean(),
    selinux: z.enum(['enforcing', 'permissive', 'disabled', 'absent']),
  }),
  resources: z.object({ cpus: z.number(), memoryBytes: z.number(), varLibFreeBytes: z.number() }),
  network: z.object({ localIpv4: z.array(z.string()), resolvedHost: z.string().nullable(), defaultRouteIp: z.string().nullable() }),
  commands: z.object({ missing: z.array(z.string()), packageManager: z.string().nullable() }),
  k3s: z.object({
    binaryVersion: z.string().nullable(),
    unit: z.enum(['k3s', 'k3s-agent']).nullable(),
    activeState: z.string().nullable(),
    subState: z.string().nullable(),
    managed: z.boolean(),
    state: NodeStateFileSchema.nullable(),
    dropinSha256: z.string().nullable(),
    restartSha256: z.string().nullable(),
    dropin: z.record(z.string(), z.unknown()).nullable(),
    foreignConfig: z.array(z.object({ file: z.string(), keys: z.array(z.string()) })),
    unitEnvK3sVars: z.array(z.string()),
    tokenFingerprints: z.object({ token: z.string().nullable(), agentToken: z.string().nullable() }),
    caSha256: z.string().nullable(),
    datastore: DATASTORE.nullable(),
    apiReady: z.boolean().nullable(),
    netcheckPresent: z.boolean().nullable(),
    defaultStorageClasses: z.array(z.object({ name: z.string(), createdAt: z.string() })).nullable(),
  }),
  helmVersion: z.string().nullable(),
  firewall: z.object({ ufw: z.enum(['active', 'inactive', 'absent']), firewalld: z.enum(['running', 'stopped', 'absent']) }),
  portsInUse: z.array(z.object({ port: z.number().int(), proto: z.enum(['tcp', 'udp']), process: z.string() })),
  swarmActive: z.boolean(),
  dockerPresent: z.boolean(),
  nmCloudSetupEnabled: z.boolean(),
  wireguardAvailable: z.boolean(),
  cgroupMemory: z.boolean(),
  ntpSynchronized: z.boolean().nullable(),
  deployUser: z.object({ exists: z.boolean(), uid: z.number().int().nullable(), home: z.string().nullable(), keyAuthorized: z.boolean() }),
  legacySudoRules: z.array(z.string()),
});

// Issue texts carry paths and expectations, never the received value: a plan holds tokens.
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Parses and validates the stdin plan of the node step (3.4). The error names fields, never values. */
export function parseNodePlan(text: string): Result<K3sNodePlan, string> {
  if (Buffer.byteLength(text, 'utf8') > NODE_PLAN_MAX_BYTES) return err(`the plan is larger than ${NODE_PLAN_MAX_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err('the plan is not valid JSON');
  }
  const parsed = K3sNodePlanSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(describeIssues(parsed.error));
}

/** Validates a state.json read from disk; null when it is not Dockflow's current format. */
export function parseNodeState(value: unknown): NodeStateFile | null {
  const parsed = NodeStateFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Validates the inspection a node step returned. */
export function parseNodeInspection(value: unknown): Result<K3sNodeInspection, string> {
  const parsed = K3sNodeInspectionSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(describeIssues(parsed.error));
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type NodePlanSchemaMatches = Assert<Same<z.infer<typeof K3sNodePlanSchema>, K3sNodePlan>>;
export type NodeStateSchemaMatches = Assert<Same<z.infer<typeof NodeStateFileSchema>, NodeStateFile>>;
export type NodeInspectionSchemaMatches = Assert<Same<z.infer<typeof K3sNodeInspectionSchema>, K3sNodeInspection>>;
