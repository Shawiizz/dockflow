// The k3s configuration drop-in Dockflow owns (design-05 7): rendering per role, the restart-class
// key set and the drift classification of an installed node. Pure.

import { Document, isMap, isScalar, parseDocument, Scalar, visit } from 'yaml';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import {
  K3S_AGENT_TOKEN_FILE,
  K3S_DISABLED_COMPONENTS,
  K3S_KUBECONFIG_MODE,
  K3S_TOKEN_FILE,
  SECRETS_ENCRYPTION_PROVIDER,
} from './constants';
import { type SetupProblem, setupMessages } from './messages';
import type { AddressMode, FlannelBackend, K3sNodeNetwork, K3sNodeSpec } from './plan';

export type K3sConfigValue = string | boolean | string[];

/** What the drop-in of one node depends on besides the node itself. */
export interface K3sConfigContext {
  /** '' in local single-host mode */
  env: string;
  addressMode: AddressMode;
  flannelBackend: FlannelBackend;
  clusterInit: boolean;
  network: Pick<K3sNodeNetwork, 'nodeIp' | 'nodeExternalIp'>;
  /** `server:` of the drop-in; null on the node that bootstraps the cluster */
  joinUrl: string | null;
}

export interface RenderedK3sConfig {
  content: string;
  sha256: string;
  values: Record<string, K3sConfigValue>;
  /** every rendered key except the paths and join-only values (7.2) */
  restartKeys: Record<string, K3sConfigValue>;
  restartSha256: string;
}

/** Keys an agent file never contains (7.1). */
export const SERVER_ONLY_CONFIG_KEYS: readonly string[] = [
  'agent-token-file',
  'cluster-init',
  'disable',
  'flannel-backend',
  'flannel-external-ip',
  'secrets-encryption',
  'secrets-encryption-provider',
  'write-kubeconfig-mode',
];

/** Changing these rewrites the file without a restart (7.2, 7.3). */
export const NO_RESTART_CONFIG_KEYS: readonly string[] = ['agent-token-file', 'server', 'token-file'];

/** Every key Dockflow may render, plus the inline token forms it never renders but owns. */
export const MANAGED_CONFIG_KEYS: readonly string[] = [
  ...SERVER_ONLY_CONFIG_KEYS,
  'agent-token',
  'node-external-ip',
  'node-ip',
  'node-name',
  'server',
  'token',
  'token-file',
].sort();

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function configHeader(env: string): string {
  const command = env === '' ? 'dockflow setup --orchestrator k3s' : `dockflow setup k3s ${env}`;
  return `# Managed by Dockflow (${command}). Changes are overwritten.`;
}

// k3s reads its configuration with YAML 1.1 rules, where a plain `yes`, `on` or `0600` is not a
// string, so any string that is not the same scalar under both versions is double-quoted.
function plainIsSafe(text: string): boolean {
  if (text === '<<') return false;
  for (const version of ['1.1', '1.2'] as const) {
    const doc = parseDocument(text, { version });
    if (doc.errors.length > 0 || !isScalar(doc.contents) || doc.contents.value !== text) return false;
  }
  return true;
}

function emitYaml(values: Record<string, K3sConfigValue>): string {
  const doc = new Document(values);
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && !plainIsSafe(node.value)) node.type = Scalar.QUOTE_DOUBLE;
    },
  });
  return doc.toString();
}

function sortedValues(values: Record<string, K3sConfigValue>): Record<string, K3sConfigValue> {
  const out: Record<string, K3sConfigValue> = {};
  for (const key of Object.keys(values).sort(compareCodeUnits)) {
    const value = values[key];
    out[key] = Array.isArray(value) ? [...value].sort(compareCodeUnits) : value;
  }
  return out;
}

/** The restart-class subset of drop-in values (7.2). */
export function restartKeysOf<T>(values: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(values).sort(compareCodeUnits)) {
    if (!NO_RESTART_CONFIG_KEYS.includes(key)) out[key] = values[key];
  }
  return out;
}

/** sha256 of the canonical JSON of the restart-class keys, recorded in state.json. */
export function restartSha256Of(values: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson(restartKeysOf(normalized(values))));
}

/** The values of 50-dockflow.yaml for one node (7.1). */
export function renderK3sConfig(node: Pick<K3sNodeSpec, 'nodeName' | 'role'>, cluster: K3sConfigContext): RenderedK3sConfig {
  const values: Record<string, K3sConfigValue> = { 'node-name': node.nodeName };
  if (cluster.network.nodeIp !== null) values['node-ip'] = cluster.network.nodeIp;
  if (cluster.addressMode === 'public' && cluster.network.nodeExternalIp !== null) {
    values['node-external-ip'] = cluster.network.nodeExternalIp;
  }

  if (node.role === 'agent') {
    if (cluster.joinUrl !== null) values.server = cluster.joinUrl;
    values['token-file'] = K3S_TOKEN_FILE;
  } else {
    values['agent-token-file'] = K3S_AGENT_TOKEN_FILE;
    if (cluster.clusterInit) values['cluster-init'] = true;
    values.disable = [...K3S_DISABLED_COMPONENTS];
    values['flannel-backend'] = cluster.flannelBackend;
    if (cluster.addressMode === 'public') values['flannel-external-ip'] = true;
    values['secrets-encryption'] = true;
    values['secrets-encryption-provider'] = SECRETS_ENCRYPTION_PROVIDER;
    values['write-kubeconfig-mode'] = K3S_KUBECONFIG_MODE;
    if (cluster.joinUrl !== null) {
      values.server = cluster.joinUrl;
      values['token-file'] = K3S_TOKEN_FILE;
    }
  }

  const sorted = sortedValues(values);
  const content = `${configHeader(cluster.env)}\n${emitYaml(sorted)}`;
  const restartKeys = restartKeysOf(sorted);
  return {
    content,
    sha256: sha256Hex(content),
    values: sorted,
    restartKeys,
    restartSha256: sha256Hex(canonicalJson(restartKeys)),
  };
}

/** The mapping of a drop-in on disk, or null when it is not a YAML mapping. */
export function parseK3sConfig(content: string): Record<string, unknown> | null {
  const doc = parseDocument(content, { version: '1.1' });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const value: unknown = doc.toJS();
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalized(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = Array.isArray(value) ? value.map(String).sort(compareCodeUnits) : value;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

function shown(value: unknown): string {
  if (value === undefined) return 'unset';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

function backendOf(values: Readonly<Record<string, unknown>>): string {
  const backend = typeof values['flannel-backend'] === 'string' ? values['flannel-backend'] : 'vxlan';
  return values['flannel-external-ip'] === true ? `${backend} with external IPs` : backend;
}

export interface ConfigDriftInput {
  key: string;
  env: string;
  /** a server whose installed datastore is embedded etcd */
  etcdMember: boolean;
  /** the node bootstraps the cluster and its installed datastore is SQLite */
  sqliteInit: boolean;
  existing: Readonly<Record<string, unknown>>;
  rendered: Readonly<Record<string, unknown>>;
  /** why the rendered pod network differs, for the flannel refusal */
  backendReason: string;
  /** keys whose difference the caller already reported */
  ignore?: readonly string[];
}

export interface ConfigDrift {
  refusals: SetupProblem[];
  /** changed keys that need a restart, sorted */
  restart: string[];
  /** changed keys rewritten without a restart, sorted */
  rewrite: string[];
  /** `cluster-init` appears on the SQLite server that bootstraps the cluster */
  convertToEtcd: boolean;
}

/** Classifies each difference between the drop-in on disk and the render (7.3). */
export function classifyConfigDrift(input: ConfigDriftInput): ConfigDrift {
  const existing = normalized(input.existing);
  const rendered = normalized(input.rendered);
  const drift: ConfigDrift = { refusals: [], restart: [], rewrite: [], convertToEtcd: false };
  let backendRefused = false;
  let encryptionRefused = false;

  const keys = [...new Set([...Object.keys(existing), ...Object.keys(rendered)])].sort(compareCodeUnits);
  for (const key of keys) {
    const before = existing[key];
    const after = rendered[key];
    if (sameValue(before, after) || input.ignore?.includes(key)) continue;

    switch (key) {
      case 'cluster-init':
        // sticky: only the SQLite bootstrap server gains it, by conversion
        if (after === true && input.sqliteInit) {
          drift.convertToEtcd = true;
          drift.restart.push(key);
        }
        break;
      case 'node-name':
        drift.refusals.push(setupMessages.nodeRenamed(input.key, shown(before), shown(after)));
        break;
      case 'node-ip':
        if (input.etcdMember) drift.refusals.push(setupMessages.etcdNodeIpChange(input.key, shown(before), shown(after)));
        else drift.restart.push(key);
        break;
      case 'flannel-backend':
      case 'flannel-external-ip':
        if (!backendRefused) {
          backendRefused = true;
          drift.refusals.push(setupMessages.flannelChange(input.env, backendOf(existing), backendOf(rendered), input.backendReason));
        }
        break;
      case 'secrets-encryption':
      case 'secrets-encryption-provider': {
        if (encryptionRefused) break;
        encryptionRefused = true;
        const from = existing['secrets-encryption-provider'] ?? 'aescbc';
        const to = rendered['secrets-encryption-provider'] ?? 'aescbc';
        const describe = (values: Record<string, unknown>, provider: unknown): string =>
          values['secrets-encryption'] === true ? `enabled, ${String(provider)}` : 'disabled';
        const problem =
          existing['secrets-encryption'] === true && from === 'aescbc' && to === SECRETS_ENCRYPTION_PROVIDER
            ? setupMessages.encryptionProviderMigration(input.key, describe(existing, from), describe(rendered, to))
            : setupMessages.encryptionChange(input.key, describe(existing, from), describe(rendered, to));
        drift.refusals.push(problem);
        break;
      }
      case 'disable':
        drift.refusals.push(setupMessages.disabledComponents(input.key, Array.isArray(before) ? before.map(String) : []));
        break;
      default:
        // `server`, `token-file`, `agent-token-file`: rewritten; every other key, including one
        // Dockflow no longer renders, needs a restart
        if (NO_RESTART_CONFIG_KEYS.includes(key)) drift.rewrite.push(key);
        else drift.restart.push(key);
    }
  }
  return drift;
}
