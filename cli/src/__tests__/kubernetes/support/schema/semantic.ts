// Semantic rules over a whole artifact (design-07 7.3 S01..S28, design-02 14.4): the API-server
// validation the OpenAPI schemas do not encode (names, ports, probes, strategies, security, DNS,
// sizes) and Dockflow's own invariants (labels, references, per-kind fields, data safety). A SEM
// rule that design-07 already covers is implemented once, under its S id, with the SEM content as
// its minimum; the SEM rules without an S equivalent keep their SEM id.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  ANNOTATIONS,
  K8S_IMPORTED_IMAGE_REGISTRY,
  K8S_MANAGED_BY,
  KUBE_KEYS,
  LABELS,
  MAX_LOAD_BALANCER_PORTS,
  MAX_MIN_READY_S,
  PARTS,
  progressDeadlineFor,
} from '../../../../services/orchestrator/kubernetes/constants';
import type { DistributionTraits } from '../../../../services/orchestrator/kubernetes/distribution';
import { isManifestKind, KIND_REGISTRY } from '../../../../services/orchestrator/kubernetes/resources/registry';
import {
  childPath,
  compareQuantities,
  formatQuantity,
  isRecord,
  parseQuantity,
  type SchemaIssue,
  validateObject,
} from './validate';

export interface SemanticContext {
  /** the stack namespace; every object sits in it and carries it as `P/stack` (S20) */
  namespace: string;
  /**
   * Names the artifact may reference without containing them (design-02 14.5): claim names of
   * external volumes, external secret and config object names, the sibling role's Service and
   * Middleware names.
   */
  externalNames?: readonly string[];
  /** SEM-071: an unresolved middleware reference fails instead of being a warning */
  strictMiddlewares?: boolean;
  /** servers.yml keys; S28 accepts `kubernetes.io/hostname` values derived from them only */
  serverNames?: readonly string[];
  /** traits the rules read; defaults are the values of the one supported distribution */
  traits?: Partial<Pick<DistributionTraits, 'clusterDnsNameservers' | 'loadBalancerNodePorts'>>;
  /** rule ids not to run, e.g. S20/S21 for objects created outside artifacts (design-07 7.4) */
  skipRules?: readonly string[];
}

export interface SemanticIssue extends SchemaIssue {
  kind: string;
  name: string;
}

/** What a rule reports; the rule id is added by `validateSemantics`. */
export interface Finding {
  path: string;
  message: string;
  severity?: 'warning';
}

type Json = Record<string, unknown>;

/** The artifact index and resolved context every rule receives. */
export interface RuleEnvironment {
  namespace: string;
  external: ReadonlySet<string>;
  strictMiddlewares: boolean;
  nodeNames: ReadonlySet<string>;
  clusterDnsNameservers: number;
  loadBalancerNodePorts: boolean;
  services: ReadonlyMap<string, Json>;
  secrets: ReadonlyMap<string, Json>;
  configMaps: ReadonlyMap<string, Json>;
  claims: ReadonlyMap<string, Json>;
  middlewares: ReadonlyMap<string, Json>;
  workloads: readonly Json[];
  /** Secrets some container reads through `envFrom` */
  envSecrets: ReadonlySet<string>;
}

export interface SemanticRule {
  id: string;
  /** kinds whose objects the rule checks; other objects are read through the environment */
  kinds: readonly string[] | 'all';
  check(object: Json, env: RuleEnvironment): Finding[];
}

// ---------------------------------------------------------------------------------------------
// Shared vocabulary

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'] as const;
const LONG_RUNNING_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const;
const POD_KINDS = [...WORKLOAD_KINDS, 'Pod'] as const;
/** kinds that always belong to one compose service (design-02 1.3 `serviceObjectLabels`) */
const SERVICE_OBJECT_KINDS = new Set<string>([...WORKLOAD_KINDS, 'Service', 'IngressRoute']);
const ROLES = new Set(['app', 'accessory']);

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const QUALIFIED_NAME_PART = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
const CONFIG_MAP_KEY = /^[-._a-zA-Z0-9]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SYSCTL_NAME = /^([a-z0-9]([-_a-z0-9]*[a-z0-9])?[./])*[a-z0-9]([-_a-z0-9]*[a-z0-9])?$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HASHED_NAME = /-(env|secret|config)-([0-9a-f]{8})$/;
const GENERATED_PORT_NAME = /^(tcp|udp|sctp)-(\d+)$/;
const MAX_SIZE = 1024 * 1024;
const MAX_ANNOTATIONS_SIZE = 256 * 1024;
const MAX_RESOLV_NAMESERVERS = 3;
const MAX_DNS_SEARCHES = 32;
const MAX_DNS_SEARCH_CHARS = 2048;
const HOSTNAME_KEY = KUBE_KEYS.hostname;

/** kubelet `safe_sysctls.go` at the minimum server version (design-02 0). */
const SAFE_SYSCTLS = new Set([
  'kernel.shm_rmid_forced',
  'net.ipv4.ip_local_port_range',
  'net.ipv4.tcp_syncookies',
  'net.ipv4.ping_group_range',
  'net.ipv4.ip_unprivileged_port_start',
  'net.ipv4.ip_local_reserved_ports',
  'net.ipv4.tcp_keepalive_time',
  'net.ipv4.tcp_fin_timeout',
  'net.ipv4.tcp_keepalive_intvl',
  'net.ipv4.tcp_keepalive_probes',
  'net.ipv4.tcp_rmem',
  'net.ipv4.tcp_wmem',
]);

/** Middleware arrays whose order Traefik gives a meaning; every other one is a sorted set (design-02 9.4). */
const ORDERED_MIDDLEWARE_ARRAYS = new Set(['chain.middlewares', 'stripPrefix.prefixes', 'stripPrefixRegex.regex']);

const ENTRY_POINTS = new Set(['web', 'websecure']);

function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rec(value))) if (typeof entry === 'string') result[key] = entry;
  return result;
}

function metadataOf(object: Json): Json {
  return rec(object.metadata);
}

function nameOf(object: Json): string {
  return text(metadataOf(object).name) ?? '';
}

function labelsOf(object: Json): Record<string, string> {
  return stringMap(metadataOf(object).labels);
}

function annotationsOf(object: Json): Record<string, string> {
  return stringMap(metadataOf(object).annotations);
}

function has(object: Json, key: string): boolean {
  return object[key] !== undefined;
}

function finding(path: string, message: string): Finding {
  return { path, message };
}

/** `childPath` for a dotted run of plain field names (label keys go through `childPath` alone). */
function sub(path: string, fields: string): string {
  return fields.split('.').reduce<string>((current, field) => childPath(current, field), path);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function decodeBase64(value: string): Uint8Array | null {
  return BASE64.test(value) ? new Uint8Array(Buffer.from(value, 'base64')) : null;
}

/** The `kubernetes.io/hostname` value of a servers.yml key (DESIGN-CORE 5.4 `nodeNameFor`). */
function nodeNameFor(serverKey: string): string {
  return serverKey.toLowerCase().replace(/_/g, '-');
}

function isQualifiedName(key: string): boolean {
  const parts = key.split('/');
  if (parts.length > 2) return false;
  const name = parts[parts.length - 1];
  if (name.length > 63 || !QUALIFIED_NAME_PART.test(name)) return false;
  if (parts.length === 1) return true;
  const prefix = parts[0];
  return prefix.length > 0 && prefix.length <= 253 && DNS1123_SUBDOMAIN.test(prefix);
}

function isLabelValue(value: string): boolean {
  return value.length <= 63 && LABEL_VALUE.test(value);
}

function isDnsLabel(value: string, max = 63): boolean {
  return value.length <= max && DNS1123_LABEL.test(value);
}

function isSubdomain(value: string): boolean {
  return value.length <= 253 && DNS1123_SUBDOMAIN.test(value);
}

function isIanaServiceName(value: string): boolean {
  return value.length <= 15 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value) && /[a-z]/.test(value) && !value.includes('--');
}

function isConfigMapKey(key: string): boolean {
  return key.length <= 253 && CONFIG_MAP_KEY.test(key) && key !== '.' && key !== '..' && !key.startsWith('..');
}

function isCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash < 0) return false;
  const family = isIP(value.slice(0, slash));
  const bits = value.slice(slash + 1);
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

/** 0, '0' and '0%' mean no pods for maxSurge / maxUnavailable. */
function isZeroAmount(value: unknown): boolean {
  return value === 0 || value === '0' || value === '0%';
}

function percentOf(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+)%$/.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function matchesLabels(selector: Record<string, string>, labels: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function selectorMatches(selector: Json, labels: Record<string, string>): boolean {
  if (!matchesLabels(stringMap(selector.matchLabels), labels)) return false;
  return list(selector.matchExpressions).every((raw) => {
    const expression = rec(raw);
    const key = text(expression.key) ?? '';
    const values = list(expression.values).filter((value): value is string => typeof value === 'string');
    switch (expression.operator) {
      case 'In':
        return key in labels && values.includes(labels[key]);
      case 'NotIn':
        return !(key in labels) || !values.includes(labels[key]);
      case 'Exists':
        return key in labels;
      case 'DoesNotExist':
        return !(key in labels);
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Pod templates and containers

interface Template {
  metadata: Json;
  spec: Json;
  metadataPath: string;
  specPath: string;
}

interface ContainerRef {
  container: Json;
  path: string;
  init: boolean;
}

function templateOf(object: Json): Template | null {
  if (object.kind === 'Pod') return { metadata: metadataOf(object), spec: rec(object.spec), metadataPath: 'metadata', specPath: 'spec' };
  if (!(WORKLOAD_KINDS as readonly unknown[]).includes(object.kind)) return null;
  const template = rec(rec(object.spec).template);
  return { metadata: rec(template.metadata), spec: rec(template.spec), metadataPath: 'spec.template.metadata', specPath: 'spec.template.spec' };
}

function containersOf(template: Template): ContainerRef[] {
  const refs: ContainerRef[] = [];
  for (const field of ['initContainers', 'containers'] as const) {
    list(template.spec[field]).forEach((container, index) => {
      refs.push({ container: rec(container), path: childPath(childPath(template.specPath, field), index), init: field === 'initContainers' });
    });
  }
  return refs;
}

function templateLabels(object: Json): Record<string, string> {
  const template = templateOf(object);
  return template === null ? {} : stringMap(template.metadata.labels);
}

/** Selector labels of a workload: its selector, or the ones the Job controller will match on. */
function workloadSelector(workload: Json): Record<string, string> {
  if (workload.kind !== 'Job') return stringMap(rec(rec(workload.spec).selector).matchLabels);
  const labels = templateLabels(workload);
  const selector: Record<string, string> = {};
  for (const key of [LABELS.stack, LABELS.service]) if (labels[key] !== undefined) selector[key] = labels[key];
  return selector;
}

/** Container ports of the pod templates a Service selector matches. */
function selectedPorts(selector: Record<string, string>, env: RuleEnvironment): Json[] {
  const ports: Json[] = [];
  if (Object.keys(selector).length === 0) return ports;
  for (const workload of env.workloads) {
    const template = templateOf(workload);
    if (template === null || !matchesLabels(selector, stringMap(template.metadata.labels))) continue;
    for (const { container, init } of containersOf(template)) if (!init) ports.push(...list(container.ports).map(rec));
  }
  return ports;
}

// ---------------------------------------------------------------------------------------------
// S01 names

function nameRule(kind: string): { valid: (name: string) => boolean; what: string } {
  switch (kind) {
    case 'Service':
      return { valid: (name) => name.length <= 63 && DNS1035_LABEL.test(name), what: 'a DNS-1035 label of at most 63 characters' };
    case 'Namespace':
    case 'Deployment':
    case 'DaemonSet':
    case 'Job':
      return { valid: (name) => isDnsLabel(name), what: 'a DNS-1123 label of at most 63 characters' };
    case 'StatefulSet':
      return { valid: (name) => isDnsLabel(name, 52), what: 'a DNS-1123 label of at most 52 characters' };
    default:
      return { valid: isSubdomain, what: 'a DNS-1123 subdomain of at most 253 characters' };
  }
}

function checkNames(object: Json): Finding[] {
  const name = nameOf(object);
  const kind = text(object.kind) ?? '';
  const rule = nameRule(kind);
  const findings: Finding[] = [];
  if (!rule.valid(name)) findings.push(finding('metadata.name', `${JSON.stringify(name)} is not ${rule.what}`));
  if (kind === 'IngressRoute') {
    const service = labelsOf(object)[LABELS.service];
    const prefix = service === undefined ? '[a-z0-9-]+' : service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^${prefix}--[0-9a-f]{8}$`).test(name)) {
      findings.push(finding('metadata.name', `${JSON.stringify(name)} is not <service>--<8 hex of the router name>`));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S02 labels and annotations

function labelMapFindings(value: unknown, path: string): Finding[] {
  const findings: Finding[] = [];
  for (const [key, entry] of Object.entries(rec(value))) {
    const at = childPath(path, key);
    if (!isQualifiedName(key)) findings.push(finding(at, `label key ${JSON.stringify(key)} is not a qualified name`));
    if (typeof entry !== 'string' || !isLabelValue(entry)) {
      findings.push(finding(at, `label value ${JSON.stringify(entry)} is not a label value (at most 63 characters, alphanumeric ends)`));
    }
  }
  return findings;
}

function annotationFindings(value: unknown, path: string): Finding[] {
  const findings: Finding[] = [];
  let size = 0;
  for (const [key, entry] of Object.entries(rec(value))) {
    if (!isQualifiedName(key.toLowerCase())) findings.push(finding(childPath(path, key), `annotation key ${JSON.stringify(key)} is not a qualified name`));
    size += Buffer.byteLength(key, 'utf8') + (typeof entry === 'string' ? Buffer.byteLength(entry, 'utf8') : 0);
  }
  if (size > MAX_ANNOTATIONS_SIZE) findings.push(finding(path, `annotations total ${size} bytes, more than 256 KiB`));
  return findings;
}

function selectorFindings(selector: unknown, path: string): Finding[] {
  const findings = labelMapFindings(rec(selector).matchLabels, childPath(path, 'matchLabels'));
  list(rec(selector).matchExpressions).forEach((raw, index) => findings.push(...expressionFindings(raw, childPath(childPath(path, 'matchExpressions'), index))));
  return findings;
}

function expressionFindings(raw: unknown, path: string): Finding[] {
  const expression = rec(raw);
  const findings: Finding[] = [];
  const key = text(expression.key) ?? '';
  if (!isQualifiedName(key)) findings.push(finding(childPath(path, 'key'), `label key ${JSON.stringify(key)} is not a qualified name`));
  list(expression.values).forEach((value, index) => {
    const valid = typeof value === 'string' && (expression.operator === 'Gt' || expression.operator === 'Lt' ? /^-?\d+$/.test(value) : isLabelValue(value));
    if (!valid) findings.push(finding(childPath(childPath(path, 'values'), index), `${JSON.stringify(value)} is not a label value`));
  });
  return findings;
}

function checkLabels(object: Json): Finding[] {
  const metadata = metadataOf(object);
  const findings = [...labelMapFindings(metadata.labels, 'metadata.labels'), ...annotationFindings(metadata.annotations, 'metadata.annotations')];
  const spec = rec(object.spec);
  if (has(spec, 'selector')) {
    const path = 'spec.selector';
    findings.push(...(object.kind === 'Service' ? labelMapFindings(spec.selector, path) : selectorFindings(spec.selector, path)));
  }
  list(spec.volumeClaimTemplates).forEach((raw, index) => {
    const claim = rec(rec(raw).metadata);
    const path = childPath(childPath('spec.volumeClaimTemplates', index), 'metadata');
    findings.push(...labelMapFindings(claim.labels, childPath(path, 'labels')), ...annotationFindings(claim.annotations, childPath(path, 'annotations')));
  });
  const template = templateOf(object);
  if (template !== null && object.kind !== 'Pod') {
    findings.push(
      ...labelMapFindings(template.metadata.labels, childPath(template.metadataPath, 'labels')),
      ...annotationFindings(template.metadata.annotations, childPath(template.metadataPath, 'annotations')),
    );
  }
  if (template !== null) {
    const spec = template.spec;
    findings.push(...labelMapFindings(spec.nodeSelector, childPath(template.specPath, 'nodeSelector')));
    const affinity = rec(spec.affinity);
    const terms = list(rec(rec(affinity.nodeAffinity).requiredDuringSchedulingIgnoredDuringExecution).nodeSelectorTerms);
    const termsPath = sub(template.specPath, 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms');
    terms.forEach((term, index) => {
      list(rec(term).matchExpressions).forEach((raw, position) => {
        findings.push(...expressionFindings(raw, childPath(childPath(childPath(termsPath, index), 'matchExpressions'), position)));
      });
    });
    const antiPath = sub(template.specPath, 'affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution');
    list(rec(affinity.podAntiAffinity).requiredDuringSchedulingIgnoredDuringExecution).forEach((term, index) => {
      findings.push(...selectorFindings(rec(term).labelSelector, childPath(childPath(antiPath, index), 'labelSelector')));
    });
    list(spec.topologySpreadConstraints).forEach((constraint, index) => {
      const path = childPath(childPath(template.specPath, 'topologySpreadConstraints'), index);
      findings.push(...selectorFindings(rec(constraint).labelSelector, childPath(path, 'labelSelector')));
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S03 selectors (SEM-010, SEM-043)

function checkSelectors(object: Json, env: RuleEnvironment): Finding[] {
  if (object.kind === 'Service') {
    const selector = stringMap(rec(object.spec).selector);
    const selected = env.workloads.some((workload) => sameLabels(workloadSelector(workload), selector));
    return selected ? [] : [finding('spec.selector', 'does not equal the selector labels of any workload of the artifact')];
  }
  if (object.kind === 'Job') return [];
  const selector = rec(rec(object.spec).selector);
  const matchLabels = stringMap(selector.matchLabels);
  const expected = { [LABELS.stack]: env.namespace, [LABELS.service]: labelsOf(object)[LABELS.service] ?? '' };
  const findings: Finding[] = [];
  if (!sameLabels(matchLabels, expected) || list(selector.matchExpressions).length > 0) {
    findings.push(finding('spec.selector', `must be exactly matchLabels {${LABELS.stack}: ${expected[LABELS.stack]}, ${LABELS.service}: ${expected[LABELS.service]}}`));
  }
  if (!matchesLabels(matchLabels, templateLabels(object))) findings.push(finding('spec.selector.matchLabels', 'is not a subset of the pod template labels'));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S04 containers and container ports (SEM-020, SEM-021)

function checkContainers(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const names = new Map<string, string>();
  const hostNetwork = template.spec.hostNetwork === true;
  for (const { container, path } of containersOf(template)) {
    const name = text(container.name) ?? '';
    if (!isDnsLabel(name)) findings.push(finding(childPath(path, 'name'), `${JSON.stringify(name)} is not a DNS-1123 label`));
    const first = names.get(name);
    if (first !== undefined) findings.push(finding(childPath(path, 'name'), `repeats the container name of ${first}`));
    else names.set(name, path);
    const portNames = new Set<string>();
    const keys = new Set<string>();
    list(container.ports).forEach((raw, index) => {
      const port = rec(raw);
      const at = childPath(childPath(path, 'ports'), index);
      const portName = text(port.name);
      if (portName !== undefined) {
        if (!isIanaServiceName(portName)) findings.push(finding(childPath(at, 'name'), `${JSON.stringify(portName)} is not an IANA service name (at most 15 of [a-z0-9-], one letter, no leading, trailing or double -)`));
        if (portNames.has(portName)) findings.push(finding(childPath(at, 'name'), `repeats the port name ${portName}`));
        portNames.add(portName);
      }
      for (const field of ['containerPort', 'hostPort'] as const) {
        const value = port[field];
        if (value === undefined && field === 'hostPort') continue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          findings.push(finding(childPath(at, field), `${JSON.stringify(value)} is not a port between 1 and 65535`));
        }
      }
      const key = `${String(port.containerPort)}/${String(port.protocol ?? 'TCP')}`;
      if (keys.has(key)) findings.push(finding(at, `repeats containerPort and protocol ${key}`));
      keys.add(key);
      if (hostNetwork && port.hostPort !== port.containerPort) findings.push(finding(childPath(at, 'hostPort'), 'must equal containerPort with hostNetwork'));
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S05 Services (SEM-040, SEM-041)

function checkServicePorts(object: Json, env: RuleEnvironment): Finding[] {
  const spec = rec(object.spec);
  const ports = list(spec.ports).map(rec);
  const headless = spec.clusterIP === 'None';
  const findings: Finding[] = [];
  if (ports.length === 0 && !headless) findings.push(finding('spec.ports', 'a Service without ports must be headless (clusterIP: None)'));
  if (headless && spec.type !== undefined && spec.type !== 'ClusterIP') findings.push(finding('spec.type', 'a headless Service must be of type ClusterIP'));
  const selector = stringMap(spec.selector);
  const containerPorts = selectedPorts(selector, env);
  const names = new Set<string>();
  const keys = new Set<string>();
  ports.forEach((port, index) => {
    const at = childPath('spec.ports', index);
    const name = text(port.name);
    if (name === undefined) {
      if (ports.length > 1) findings.push(finding(childPath(at, 'name'), 'is required when a Service has more than one port'));
    } else {
      if (!isDnsLabel(name)) findings.push(finding(childPath(at, 'name'), `${JSON.stringify(name)} is not a DNS-1123 label`));
      if (names.has(name)) findings.push(finding(childPath(at, 'name'), `repeats the port name ${name}`));
      names.add(name);
    }
    const number = port.port;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 65535) {
      findings.push(finding(childPath(at, 'port'), `${JSON.stringify(number)} is not a port between 1 and 65535`));
    }
    const key = `${String(number)}/${String(port.protocol ?? 'TCP')}`;
    if (keys.has(key)) findings.push(finding(at, `repeats port and protocol ${key}`));
    keys.add(key);
    const target = port.targetPort;
    if (typeof target === 'number') {
      if (!Number.isInteger(target) || target < 1 || target > 65535) findings.push(finding(childPath(at, 'targetPort'), `${target} is not a port between 1 and 65535`));
    } else if (typeof target === 'string') {
      if (!isIanaServiceName(target)) findings.push(finding(childPath(at, 'targetPort'), `${JSON.stringify(target)} is not an IANA service name`));
      else if (!containerPorts.some((candidate) => candidate.name === target)) {
        findings.push(finding(childPath(at, 'targetPort'), `names no container port of a pod template the selector matches`));
      }
    }
    // Ports are named after the target (container) port, never the published one (K30).
    const generated = name === undefined ? null : GENERATED_PORT_NAME.exec(name);
    const targetNumber = typeof target === 'number' ? target : number;
    if (generated !== null && Number(generated[2]) !== targetNumber) {
      findings.push(finding(childPath(at, 'name'), `${name} is not derived from the target port ${String(targetNumber)}`));
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S06 pod volumes and mounts (SEM-022, SEM-023)

function checkVolumes(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const volumes = new Set<string>();
  const volumesPath = childPath(template.specPath, 'volumes');
  list(template.spec.volumes).forEach((raw, index) => {
    const volume = rec(raw);
    const at = childPath(volumesPath, index);
    const name = text(volume.name) ?? '';
    if (!isDnsLabel(name)) findings.push(finding(childPath(at, 'name'), `${JSON.stringify(name)} is not a DNS-1123 label`));
    if (volumes.has(name)) findings.push(finding(childPath(at, 'name'), `repeats the volume name ${name}`));
    volumes.add(name);
    const sources = Object.keys(volume).filter((key) => key !== 'name' && volume[key] !== undefined);
    if (sources.length !== 1) findings.push(finding(at, `has ${sources.length} volume sources, exactly one required`));
    for (const source of ['secret', 'configMap'] as const) {
      if (!has(volume, source)) continue;
      const files = rec(volume[source]);
      const mode = files.defaultMode;
      if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
        findings.push(finding(childPath(childPath(at, source), 'defaultMode'), `${JSON.stringify(mode)} is not a file mode between 0 and 0777`));
      }
      list(files.items).forEach((item, position) => {
        if (has(rec(item), 'mode')) findings.push(finding(childPath(childPath(childPath(at, source), 'items'), position), 'items[].mode is never emitted; defaultMode carries the mode'));
      });
    }
  });
  const claims = new Set<string>();
  list(rec(object.spec).volumeClaimTemplates).forEach((raw, index) => {
    const name = text(rec(rec(raw).metadata).name) ?? '';
    const at = sub(childPath('spec.volumeClaimTemplates', index), 'metadata.name');
    if (!isDnsLabel(name)) findings.push(finding(at, `${JSON.stringify(name)} is not a DNS-1123 label`));
    if (volumes.has(name) || claims.has(name)) findings.push(finding(at, `claim template ${name} collides with another pod volume name`));
    claims.add(name);
  });
  for (const { container, path } of containersOf(template)) {
    const mountPaths = new Set<string>();
    const privileged = rec(container.securityContext).privileged === true;
    list(container.volumeMounts).forEach((raw, index) => {
      const mount = rec(raw);
      const at = childPath(childPath(path, 'volumeMounts'), index);
      const name = text(mount.name) ?? '';
      if (!volumes.has(name) && !claims.has(name)) findings.push(finding(childPath(at, 'name'), `refers to no pod volume or claim template named ${name}`));
      const mountPath = text(mount.mountPath) ?? '';
      if (!mountPath.startsWith('/')) findings.push(finding(childPath(at, 'mountPath'), `${JSON.stringify(mountPath)} is not an absolute path`));
      if (mountPaths.has(mountPath)) findings.push(finding(childPath(at, 'mountPath'), `repeats the mount path ${mountPath}`));
      mountPaths.add(mountPath);
      const subPath = text(mount.subPath);
      if (subPath !== undefined && (subPath.startsWith('/') || subPath.split('/').includes('..'))) {
        findings.push(finding(childPath(at, 'subPath'), `${JSON.stringify(subPath)} must be relative and must not contain ..`));
      }
      const propagation = mount.mountPropagation;
      if (has(mount, 'recursiveReadOnly')) {
        if (mount.recursiveReadOnly !== 'IfPossible' && mount.recursiveReadOnly !== 'Enabled') {
          findings.push(finding(childPath(at, 'recursiveReadOnly'), 'Dockflow emits only IfPossible or Enabled'));
        }
        if (mount.readOnly !== true) findings.push(finding(childPath(at, 'recursiveReadOnly'), 'requires readOnly: true'));
        if (propagation !== undefined && propagation !== 'None') findings.push(finding(childPath(at, 'recursiveReadOnly'), 'requires no mount propagation'));
      }
      if (propagation === 'Bidirectional' && !privileged) findings.push(finding(childPath(at, 'mountPropagation'), 'Bidirectional requires a privileged container'));
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S07 references (SEM-032)

function reference(name: unknown, known: ReadonlyMap<string, Json>, env: RuleEnvironment): boolean {
  return typeof name === 'string' && (known.has(name) || env.external.has(name));
}

function checkReferences(object: Json, env: RuleEnvironment): Finding[] {
  const findings: Finding[] = [];
  if (object.kind === 'Middleware') {
    const spec = rec(object.spec);
    for (const type of ['basicAuth', 'digestAuth'] as const) {
      if (!has(spec, type)) continue;
      const secretName = rec(spec[type]).secret;
      const secret = typeof secretName === 'string' ? env.secrets.get(secretName) : undefined;
      const path = childPath(childPath('spec', type), 'secret');
      // A user-managed Secret (`...basicauth.secret=<name>`, design-04 2.14.1 rule 6) is not visible, so its keys cannot be checked.
      if (secret === undefined && typeof secretName === 'string' && env.external.has(secretName)) continue;
      if (secret === undefined) findings.push(finding(path, `${JSON.stringify(secretName)} is neither a Secret of the artifact nor a declared external name`));
      else if (Object.keys(rec(secret.data)).length !== 1) findings.push(finding(path, `Secret ${String(secretName)} must hold exactly one data key`));
    }
    return findings;
  }
  const template = templateOf(object);
  if (template === null) return findings;
  for (const { container, path } of containersOf(template)) {
    list(container.envFrom).forEach((raw, index) => {
      const source = rec(raw);
      const at = childPath(childPath(path, 'envFrom'), index);
      if (has(source, 'secretRef') && !reference(rec(source.secretRef).name, env.secrets, env)) {
        findings.push(finding(sub(at, 'secretRef.name'), `${JSON.stringify(rec(source.secretRef).name)} is neither a Secret of the artifact nor a declared external name`));
      }
      if (has(source, 'configMapRef') && !reference(rec(source.configMapRef).name, env.configMaps, env)) {
        findings.push(finding(sub(at, 'configMapRef.name'), `${JSON.stringify(rec(source.configMapRef).name)} is neither a ConfigMap of the artifact nor a declared external name`));
      }
    });
  }
  list(template.spec.volumes).forEach((raw, index) => {
    const volume = rec(raw);
    const at = childPath(childPath(template.specPath, 'volumes'), index);
    const checks: [string, string, unknown, ReadonlyMap<string, Json>][] = [
      ['secret', 'secretName', rec(volume.secret).secretName, env.secrets],
      ['configMap', 'name', rec(volume.configMap).name, env.configMaps],
      ['persistentVolumeClaim', 'claimName', rec(volume.persistentVolumeClaim).claimName, env.claims],
    ];
    for (const [source, field, name, known] of checks) {
      if (has(volume, source) && !reference(name, known, env)) {
        findings.push(finding(childPath(childPath(at, source), field), `${JSON.stringify(name)} is neither an object of the artifact nor a declared external name`));
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S08 Secret and ConfigMap data (SEM-050)

function checkData(object: Json): Finding[] {
  const findings: Finding[] = [];
  const data = rec(object.data);
  const binary = rec(object.binaryData);
  let size = 0;
  for (const [field, entries] of [
    ['data', data],
    ['binaryData', binary],
  ] as const) {
    for (const [key, value] of Object.entries(entries)) {
      const at = childPath(field, key);
      if (!isConfigMapKey(key)) findings.push(finding(at, `key ${JSON.stringify(key)} is not a valid data key ([-._a-zA-Z0-9]+, at most 253, not . or ..)`));
      if (typeof value !== 'string') continue;
      const decoded = object.kind === 'Secret' || field === 'binaryData';
      if (decoded) {
        const bytes = decodeBase64(value);
        if (bytes === null) findings.push(finding(at, 'is not canonical base64'));
        else size += bytes.length;
      } else {
        if (LONE_SURROGATE.test(value)) findings.push(finding(at, 'is not valid UTF-8'));
        size += Buffer.byteLength(value, 'utf8');
      }
    }
  }
  if (object.kind === 'ConfigMap') {
    for (const key of Object.keys(data)) if (has(binary, key)) findings.push(finding(childPath('binaryData', key), `key ${key} is also in data`));
  }
  if (size > MAX_SIZE) findings.push(finding(object.kind === 'Secret' ? 'data' : '', `holds ${size} bytes, more than 1 MiB`));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S09 rollout timing and strategies (SEM-011, SEM-012, SEM-015)

function checkRollout(object: Json): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  const minReady = spec.minReadySeconds;
  const minReadySeconds = typeof minReady === 'number' ? minReady : 0;
  if (typeof minReady === 'number' && minReady > MAX_MIN_READY_S) {
    findings.push(finding('spec.minReadySeconds', `${minReady} exceeds ${MAX_MIN_READY_S}, so no rollout could be observed inside the convergence deadline`));
  }
  if (object.kind === 'Deployment') {
    const deadline = spec.progressDeadlineSeconds;
    const expected = progressDeadlineFor(minReadySeconds);
    if (typeof deadline === 'number') {
      if (deadline <= minReadySeconds) findings.push(finding('spec.progressDeadlineSeconds', `${deadline} must exceed minReadySeconds (${minReadySeconds})`));
      else if (deadline !== expected) {
        findings.push(finding('spec.progressDeadlineSeconds', `${deadline} is not progressDeadlineFor(${minReadySeconds}) = ${expected} (240..270, below the 300s convergence deadline)`));
      }
    }
    const strategy = rec(spec.strategy);
    if (strategy.type === 'Recreate' && has(strategy, 'rollingUpdate')) findings.push(finding('spec.strategy.rollingUpdate', 'must be absent with the Recreate strategy'));
    if (strategy.type === 'RollingUpdate' || strategy.type === undefined) {
      const rolling = rec(strategy.rollingUpdate);
      if (has(rolling, 'maxSurge') && has(rolling, 'maxUnavailable') && isZeroAmount(rolling.maxSurge) && isZeroAmount(rolling.maxUnavailable)) {
        findings.push(finding('spec.strategy.rollingUpdate', 'maxSurge and maxUnavailable must not both be 0'));
      }
      const percent = percentOf(rolling.maxUnavailable);
      if (percent !== null && percent > 100) findings.push(finding('spec.strategy.rollingUpdate.maxUnavailable', 'must not exceed 100%'));
    }
  }
  const restart = rec(rec(spec.template).spec).restartPolicy;
  if (restart !== undefined && restart !== 'Always') findings.push(finding('spec.template.spec.restartPolicy', `${JSON.stringify(restart)} is only allowed on Jobs; omit it (Always)`));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S10 probes (SEM-024)

const PROBE_TIMINGS = ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'successThreshold', 'failureThreshold'] as const;
const PROBE_HANDLERS = ['exec', 'httpGet', 'tcpSocket', 'grpc'] as const;

function checkProbes(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  for (const { container, path, init } of containersOf(template)) {
    if (init) continue;
    for (const kind of ['livenessProbe', 'readinessProbe', 'startupProbe'] as const) {
      if (!has(container, kind)) continue;
      const probe = rec(container[kind]);
      const at = childPath(path, kind);
      const handlers = PROBE_HANDLERS.filter((handler) => has(probe, handler));
      if (handlers.length !== 1) findings.push(finding(at, `has ${handlers.length} handlers, exactly one required`));
      for (const timing of PROBE_TIMINGS) {
        const value = probe[timing];
        if (value === undefined) {
          findings.push(finding(childPath(at, timing), 'is mandatory (emission rule 8)'));
          continue;
        }
        const minimum = timing === 'initialDelaySeconds' ? 0 : 1;
        if (typeof value !== 'number' || value < minimum) findings.push(finding(childPath(at, timing), `${JSON.stringify(value)} must be at least ${minimum}`));
      }
      if (kind !== 'readinessProbe' && has(probe, 'successThreshold') && probe.successThreshold !== 1) {
        findings.push(finding(childPath(at, 'successThreshold'), `must be 1 on a ${kind}`));
      }
    }
    if (has(container, 'startupProbe') && !has(container, 'livenessProbe')) findings.push(finding(childPath(path, 'startupProbe'), 'is only emitted next to a livenessProbe'));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S11 resources (SEM-026)

function checkResources(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  for (const { container, path } of containersOf(template)) {
    const resources = rec(container.resources);
    const limits = stringMap(resources.limits);
    for (const [name, request] of Object.entries(stringMap(resources.requests))) {
      const limit = limits[name];
      if (limit === undefined) continue;
      const requested = parseQuantity(request);
      const limited = parseQuantity(limit);
      if (requested !== null && limited !== null && compareQuantities(requested, limited) > 0) {
        findings.push(finding(childPath(sub(path, 'resources.requests'), name), `request ${request} exceeds the limit ${limit}`));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S12 enums (SEM-031)

function enumFinding(value: unknown, allowed: readonly string[], path: string, optional = true): Finding[] {
  if (value === undefined && optional) return [];
  return typeof value === 'string' && allowed.includes(value) ? [] : [finding(path, `${JSON.stringify(value)} is not one of ${allowed.join(', ')}`)];
}

const PROTOCOLS = ['TCP', 'UDP', 'SCTP'];
const PROFILE_TYPES = ['RuntimeDefault', 'Unconfined', 'Localhost'];
const ACCESS_MODES = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];

function checkEnums(object: Json): Finding[] {
  const findings: Finding[] = [];
  const spec = rec(object.spec);
  switch (object.kind) {
    case 'Service':
      findings.push(...enumFinding(spec.type, ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'], 'spec.type'));
      findings.push(...enumFinding(spec.externalTrafficPolicy, ['Cluster', 'Local'], 'spec.externalTrafficPolicy'));
      list(spec.ports).forEach((port, index) => findings.push(...enumFinding(rec(port).protocol, PROTOCOLS, childPath(childPath('spec.ports', index), 'protocol'))));
      break;
    case 'PersistentVolumeClaim':
      list(spec.accessModes).forEach((mode, index) => findings.push(...enumFinding(mode, ACCESS_MODES, childPath('spec.accessModes', index), false)));
      break;
    case 'Deployment':
      findings.push(...enumFinding(rec(spec.strategy).type, ['RollingUpdate', 'Recreate'], 'spec.strategy.type'));
      break;
    case 'StatefulSet':
    case 'DaemonSet':
      findings.push(...enumFinding(rec(spec.updateStrategy).type, ['RollingUpdate', 'OnDelete'], 'spec.updateStrategy.type'));
      break;
  }
  list(spec.volumeClaimTemplates).forEach((claim, index) => {
    const path = sub(childPath('spec.volumeClaimTemplates', index), 'spec.accessModes');
    list(rec(rec(claim).spec).accessModes).forEach((mode, position) => findings.push(...enumFinding(mode, ACCESS_MODES, childPath(path, position), false)));
  });
  const template = templateOf(object);
  if (template === null) return findings;
  const pod = template.spec;
  const podPath = template.specPath;
  findings.push(...enumFinding(pod.dnsPolicy, ['ClusterFirst', 'ClusterFirstWithHostNet', 'Default', 'None'], childPath(podPath, 'dnsPolicy')));
  findings.push(...enumFinding(pod.restartPolicy, ['Always', 'OnFailure', 'Never'], childPath(podPath, 'restartPolicy')));
  const security = rec(pod.securityContext);
  findings.push(...enumFinding(rec(security.seccompProfile).type, PROFILE_TYPES, sub(podPath, 'securityContext.seccompProfile.type')));
  findings.push(...enumFinding(rec(security.appArmorProfile).type, PROFILE_TYPES, sub(podPath, 'securityContext.appArmorProfile.type')));
  list(pod.tolerations).forEach((raw, index) => {
    const toleration = rec(raw);
    const path = childPath(childPath(podPath, 'tolerations'), index);
    findings.push(...enumFinding(toleration.operator, ['Equal', 'Exists'], childPath(path, 'operator')));
    if (toleration.effect !== '') findings.push(...enumFinding(toleration.effect, ['NoSchedule', 'PreferNoSchedule', 'NoExecute'], childPath(path, 'effect')));
  });
  list(pod.topologySpreadConstraints).forEach((constraint, index) => {
    const path = childPath(childPath(childPath(podPath, 'topologySpreadConstraints'), index), 'whenUnsatisfiable');
    findings.push(...enumFinding(rec(constraint).whenUnsatisfiable, ['DoNotSchedule', 'ScheduleAnyway'], path, false));
  });
  for (const { container, path } of containersOf(template)) {
    findings.push(...enumFinding(container.imagePullPolicy, ['Always', 'IfNotPresent', 'Never'], childPath(path, 'imagePullPolicy'), false));
    const image = text(container.image) ?? '';
    // An imported image exists only in the node's store; a pull can never succeed (DV5).
    if (image.startsWith(`${K8S_IMPORTED_IMAGE_REGISTRY}/`) && container.imagePullPolicy === 'Always') {
      findings.push(finding(childPath(path, 'imagePullPolicy'), `an imported ${K8S_IMPORTED_IMAGE_REGISTRY}/ image is never pulled, so Always cannot work`));
    }
    list(container.ports).forEach((port, index) => findings.push(...enumFinding(rec(port).protocol, PROTOCOLS, childPath(childPath(path, 'ports'), index))));
    const context = rec(container.securityContext);
    findings.push(...enumFinding(rec(context.seccompProfile).type, PROFILE_TYPES, sub(path, 'securityContext.seccompProfile.type')));
    findings.push(...enumFinding(rec(context.appArmorProfile).type, PROFILE_TYPES, sub(path, 'securityContext.appArmorProfile.type')));
    list(container.volumeMounts).forEach((mount, index) => {
      const at = childPath(childPath(path, 'volumeMounts'), index);
      findings.push(...enumFinding(rec(mount).mountPropagation, ['None', 'HostToContainer', 'Bidirectional'], childPath(at, 'mountPropagation')));
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S13 claims (SEM-060)

function claimFindings(spec: Json, path: string): Finding[] {
  const findings: Finding[] = [];
  if (list(spec.accessModes).length === 0) findings.push(finding(childPath(path, 'accessModes'), 'must list at least one access mode'));
  if (rec(rec(spec.resources).requests).storage === undefined) findings.push(finding(sub(path, 'resources.requests.storage'), 'is required'));
  const storageClass = spec.storageClassName;
  if (typeof storageClass !== 'string' || !isSubdomain(storageClass)) {
    findings.push(finding(childPath(path, 'storageClassName'), 'must name a storage class explicitly, so a claim never binds to the default class'));
  }
  return findings;
}

function checkClaims(object: Json): Finding[] {
  if (object.kind === 'PersistentVolumeClaim') return claimFindings(rec(object.spec), 'spec');
  const findings: Finding[] = [];
  list(rec(object.spec).volumeClaimTemplates).forEach((claim, index) => {
    findings.push(...claimFindings(rec(rec(claim).spec), childPath(childPath('spec.volumeClaimTemplates', index), 'spec')));
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S14 host ports and surge

function bindsHostPorts(template: Template): boolean {
  if (template.spec.hostNetwork === true) return true;
  return containersOf(template).some(({ container }) => list(container.ports).some((port) => rec(port).hostPort !== undefined));
}

function checkHostPortStrategy(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null || !bindsHostPorts(template)) return [];
  const spec = rec(object.spec);
  if (object.kind === 'Deployment') {
    const strategy = rec(spec.strategy);
    const surge = rec(strategy.rollingUpdate).maxSurge;
    if (strategy.type !== 'Recreate' && !isZeroAmount(surge)) {
      return [finding('spec.strategy', 'a pod template that binds node ports needs Recreate or maxSurge: 0')];
    }
  }
  if (object.kind === 'DaemonSet') {
    const surge = rec(rec(spec.updateStrategy).rollingUpdate).maxSurge;
    if (surge !== undefined && !isZeroAmount(surge)) return [finding('spec.updateStrategy.rollingUpdate.maxSurge', 'must be 0 when the pods bind node ports')];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// S15 Jobs (SEM-015)

function checkJob(object: Json): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  const restart = rec(rec(spec.template).spec).restartPolicy;
  if (restart !== 'Never') findings.push(finding('spec.template.spec.restartPolicy', `${JSON.stringify(restart)} must be Never on a Job (K35)`));
  for (const field of ['progressDeadlineSeconds', 'strategy', 'revisionHistoryLimit', 'minReadySeconds', 'selector', 'manualSelector']) {
    if (has(spec, field)) findings.push(finding(childPath('spec', field), 'is never emitted on a Job'));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S16 routing references (SEM-070, SEM-071)

function servicePortMatches(service: Json, port: unknown): boolean {
  return list(rec(service.spec).ports).some((raw) => {
    const candidate = rec(raw);
    return typeof port === 'number' ? candidate.port === port : candidate.name === port;
  });
}

function middlewareReference(name: unknown, path: string, env: RuleEnvironment): Finding[] {
  if (typeof name === 'string' && (env.middlewares.has(name) || env.external.has(name))) return [];
  const found = finding(path, `${JSON.stringify(name)} is neither a Middleware of the artifact nor a declared sibling Middleware`);
  return [env.strictMiddlewares ? found : { ...found, severity: 'warning' }];
}

function checkRouting(object: Json, env: RuleEnvironment): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  if (object.kind === 'Middleware') {
    const service = rec(rec(spec.errors).service);
    if (has(rec(spec.errors), 'service')) {
      const name = text(service.name);
      const target = name === undefined ? undefined : env.services.get(name);
      if (target === undefined && !(name !== undefined && env.external.has(name))) {
        findings.push(finding('spec.errors.service.name', `${JSON.stringify(name)} is neither a Service of the artifact nor a declared sibling Service`));
      } else if (target !== undefined && service.port !== undefined && !servicePortMatches(target, service.port)) {
        findings.push(finding('spec.errors.service.port', `Service ${name} exposes no port ${String(service.port)}`));
      }
    }
    list(rec(spec.chain).middlewares).forEach((ref, index) => {
      findings.push(...middlewareReference(rec(ref).name, childPath(childPath('spec.chain.middlewares', index), 'name'), env));
    });
    return findings;
  }
  const routes = list(spec.routes);
  if (routes.length !== 1) findings.push(finding('spec.routes', `holds ${routes.length} routes; Dockflow emits one IngressRoute per router`));
  routes.forEach((raw, index) => {
    const route = rec(raw);
    const at = childPath('spec.routes', index);
    if (has(route, 'kind') && route.kind !== 'Rule') findings.push(finding(childPath(at, 'kind'), 'must be Rule'));
    list(route.services).forEach((ref, position) => {
      const backend = rec(ref);
      const path = childPath(childPath(at, 'services'), position);
      const name = text(backend.name);
      const service = name === undefined ? undefined : env.services.get(name);
      if (service === undefined) findings.push(finding(childPath(path, 'name'), `${JSON.stringify(backend.name)} is not a Service of the artifact`));
      else if (!servicePortMatches(service, backend.port)) findings.push(finding(childPath(path, 'port'), `Service ${name} exposes no port ${String(backend.port)}`));
      if (backend.namespace !== undefined && backend.namespace !== env.namespace) findings.push(finding(childPath(path, 'namespace'), 'must stay in the stack namespace'));
    });
    list(route.middlewares).forEach((ref, position) => {
      findings.push(...middlewareReference(rec(ref).name, childPath(childPath(childPath(at, 'middlewares'), position), 'name'), env));
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S17-S19 pod scheduling fields

function checkGracePeriod(object: Json): Finding[] {
  const template = templateOf(object);
  const grace = template?.spec.terminationGracePeriodSeconds;
  if (template === null || grace === undefined) return [];
  return typeof grace === 'number' && grace >= 0 ? [] : [finding(childPath(template.specPath, 'terminationGracePeriodSeconds'), `${JSON.stringify(grace)} must be at least 0`)];
}

function checkTolerations(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  list(template.spec.tolerations).forEach((raw, index) => {
    const toleration = rec(raw);
    const at = childPath(childPath(template.specPath, 'tolerations'), index);
    const exists = toleration.operator === 'Exists';
    if (exists && toleration.value !== undefined && toleration.value !== '') findings.push(finding(childPath(at, 'value'), 'must be empty with operator Exists'));
    if ((toleration.key === undefined || toleration.key === '') && !exists) findings.push(finding(childPath(at, 'operator'), 'an empty key needs operator Exists'));
    if (toleration.tolerationSeconds !== undefined && toleration.effect !== 'NoExecute') {
      findings.push(finding(childPath(at, 'tolerationSeconds'), 'is only allowed with effect NoExecute'));
    }
  });
  return findings;
}

function checkSpread(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const labels = stringMap(template.metadata.labels);
  const deployment = object.kind === 'Deployment';
  const keys = new Set<string>();
  list(template.spec.topologySpreadConstraints).forEach((raw, index) => {
    const constraint = rec(raw);
    const at = childPath(childPath(template.specPath, 'topologySpreadConstraints'), index);
    const skew = constraint.maxSkew;
    if (typeof skew !== 'number' || skew < 1) findings.push(finding(childPath(at, 'maxSkew'), `${JSON.stringify(skew)} must be at least 1`));
    if (!selectorMatches(rec(constraint.labelSelector), labels)) findings.push(finding(childPath(at, 'labelSelector'), 'does not match the pod template labels'));
    const key = `${String(constraint.topologyKey)}/${String(constraint.whenUnsatisfiable)}`;
    if (keys.has(key)) findings.push(finding(at, `repeats topologyKey and whenUnsatisfiable ${key}`));
    keys.add(key);
    if (has(constraint, 'matchLabelKeys') && !deployment) findings.push(finding(childPath(at, 'matchLabelKeys'), 'pod-template-hash exists on Deployment pods only'));
  });
  const antiPath = sub(template.specPath, 'affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution');
  list(rec(rec(template.spec.affinity).podAntiAffinity).requiredDuringSchedulingIgnoredDuringExecution).forEach((raw, index) => {
    const term = rec(raw);
    const at = childPath(antiPath, index);
    if (!selectorMatches(rec(term.labelSelector), labels)) findings.push(finding(childPath(at, 'labelSelector'), 'does not match the pod template labels'));
    if (has(term, 'matchLabelKeys') && !deployment) findings.push(finding(childPath(at, 'matchLabelKeys'), 'pod-template-hash exists on Deployment pods only'));
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S20 namespace and Dockflow labels (SEM-004, SEM-005)

function stackLabelFindings(labels: Record<string, string>, path: string, env: RuleEnvironment): Finding[] {
  const findings: Finding[] = [];
  const expect = (key: string, valid: boolean, wanted: string): void => {
    if (!valid) findings.push(finding(childPath(path, key), `must be ${wanted}, found ${JSON.stringify(labels[key])}`));
  };
  expect(LABELS.managedBy, labels[LABELS.managedBy] === K8S_MANAGED_BY, K8S_MANAGED_BY);
  expect(LABELS.partOf, (labels[LABELS.partOf] ?? '') !== '', 'the project name');
  expect(LABELS.instance, labels[LABELS.instance] === env.namespace, env.namespace);
  expect(LABELS.stack, labels[LABELS.stack] === env.namespace, env.namespace);
  expect(LABELS.part, labels[LABELS.part] === PARTS.stack, PARTS.stack);
  expect(LABELS.role, ROLES.has(labels[LABELS.role] ?? ''), 'app or accessory');
  return findings;
}

function checkOwnership(object: Json, env: RuleEnvironment): Finding[] {
  const kind = text(object.kind) ?? '';
  const findings: Finding[] = [];
  if (!isManifestKind(kind)) findings.push(finding('kind', `${kind} is not an artifact kind (KIND_REGISTRY)`));
  else if (object.apiVersion !== KIND_REGISTRY[kind].apiVersion) findings.push(finding('apiVersion', `${kind} is emitted as ${KIND_REGISTRY[kind].apiVersion}`));
  const metadata = metadataOf(object);
  if (metadata.namespace !== env.namespace) findings.push(finding('metadata.namespace', `must be the stack namespace ${env.namespace}`));
  const labels = labelsOf(object);
  const annotations = annotationsOf(object);
  findings.push(...stackLabelFindings(labels, 'metadata.labels', env));
  const service = labels[LABELS.service];
  if (SERVICE_OBJECT_KINDS.has(kind) && (service ?? '') === '') findings.push(finding(childPath('metadata.labels', LABELS.service), 'is required on per-service objects'));
  if (service !== undefined && labels[LABELS.name] !== service) findings.push(finding(childPath('metadata.labels', LABELS.name), `must equal ${LABELS.service} (${service})`));
  const role = labels[LABELS.role];
  const release = annotations[ANNOTATIONS.release];
  if ((WORKLOAD_KINDS as readonly string[]).includes(kind)) {
    if (role === 'app' && (release ?? '') === '') findings.push(finding(childPath('metadata.annotations', ANNOTATIONS.release), 'is required on role app workloads'));
    if (role === 'accessory' && release !== undefined) findings.push(finding(childPath('metadata.annotations', ANNOTATIONS.release), 'is never emitted for role accessory'));
  } else if (release !== undefined) {
    findings.push(finding(childPath('metadata.annotations', ANNOTATIONS.release), 'is emitted on workload metadata only'));
  }
  if (kind === 'PersistentVolumeClaim' && labels[LABELS.volume] !== nameOf(object)) {
    findings.push(finding(childPath('metadata.labels', LABELS.volume), `must equal the claim name ${nameOf(object)}`));
  }
  list(rec(object.spec).volumeClaimTemplates).forEach((raw, index) => {
    const claim = rec(rec(raw).metadata);
    const path = sub(childPath('spec.volumeClaimTemplates', index), 'metadata.labels');
    const claimLabels = stringMap(claim.labels);
    findings.push(...stackLabelFindings(claimLabels, path, env));
    if (claimLabels[LABELS.volume] !== claim.name) findings.push(finding(childPath(path, LABELS.volume), `must equal the template name ${String(claim.name)}`));
  });
  const template = templateOf(object);
  if (template !== null) {
    const podLabels = stringMap(template.metadata.labels);
    const labelsPath = childPath(template.metadataPath, 'labels');
    const wanted: Record<string, string | undefined> = {
      [LABELS.stack]: env.namespace,
      [LABELS.service]: service,
      [LABELS.name]: service,
      [LABELS.instance]: env.namespace,
      [LABELS.role]: role,
    };
    for (const [key, value] of Object.entries(wanted)) {
      if (value !== undefined && podLabels[key] !== value) findings.push(finding(childPath(labelsPath, key), `must be ${value}, found ${JSON.stringify(podLabels[key])}`));
    }
    // The release version on a pod template would roll every pod on every release (emission rule 9).
    if (stringMap(template.metadata.annotations)[ANNOTATIONS.release] !== undefined) {
      findings.push(finding(childPath(childPath(template.metadataPath, 'annotations'), ANNOTATIONS.release), 'is never emitted on pod templates'));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S21 server-owned fields (SEM-060)

const SERVER_OWNED_METADATA = ['ownerReferences', 'managedFields', 'resourceVersion', 'uid', 'creationTimestamp'];

function serverOwned(metadata: Json, path: string): Finding[] {
  return SERVER_OWNED_METADATA.filter((field) => has(metadata, field)).map((field) => finding(childPath(path, field), 'is server-owned and never emitted'));
}

function checkServerOwned(object: Json): Finding[] {
  const findings = serverOwned(metadataOf(object), 'metadata');
  if (has(object, 'status')) findings.push(finding('status', 'is server-owned and never emitted'));
  const template = templateOf(object);
  if (template !== null && object.kind !== 'Pod') findings.push(...serverOwned(template.metadata, template.metadataPath));
  list(rec(object.spec).volumeClaimTemplates).forEach((raw, index) => {
    const claim = rec(raw);
    const path = childPath('spec.volumeClaimTemplates', index);
    findings.push(...serverOwned(rec(claim.metadata), childPath(path, 'metadata')));
    if (has(claim, 'status')) findings.push(finding(childPath(path, 'status'), 'is server-owned and never emitted'));
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S22 environment keys

function checkEnvKeys(object: Json, env: RuleEnvironment): Finding[] {
  if (!env.envSecrets.has(nameOf(object)) && !/-env-[0-9a-f]{8}$/.test(nameOf(object))) return [];
  return Object.keys(rec(object.data))
    .filter((key) => !/^[\x20-\x7e]+$/.test(key) || key.includes('='))
    .map((key) => finding(childPath('data', key), `environment variable name ${JSON.stringify(key)} must be printable ASCII without =`));
}

// ---------------------------------------------------------------------------------------------
// S23 DNS and host aliases (SEM-027, SEM-028)

function checkDns(object: Json, env: RuleEnvironment): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const pod = template.spec;
  list(pod.hostAliases).forEach((raw, index) => {
    const alias = rec(raw);
    const at = childPath(childPath(template.specPath, 'hostAliases'), index);
    if (typeof alias.ip !== 'string' || isIP(alias.ip) === 0) findings.push(finding(childPath(at, 'ip'), `${JSON.stringify(alias.ip)} is not an IP address`));
    list(alias.hostnames).forEach((hostname, position) => {
      if (typeof hostname !== 'string' || !isSubdomain(hostname)) findings.push(finding(childPath(childPath(at, 'hostnames'), position), `${JSON.stringify(hostname)} is not a DNS-1123 subdomain`));
    });
  });
  const config = rec(pod.dnsConfig);
  const configPath = childPath(template.specPath, 'dnsConfig');
  const nameservers = list(config.nameservers);
  nameservers.forEach((server, index) => {
    if (typeof server !== 'string' || isIP(server) === 0) findings.push(finding(childPath(childPath(configPath, 'nameservers'), index), `${JSON.stringify(server)} is not an IP address`));
  });
  const policy = pod.dnsPolicy ?? 'ClusterFirst';
  const clusterFirst = policy === 'ClusterFirst' || policy === 'ClusterFirstWithHostNet';
  const limit = clusterFirst ? MAX_RESOLV_NAMESERVERS - env.clusterDnsNameservers : MAX_RESOLV_NAMESERVERS;
  if (nameservers.length > limit) findings.push(finding(childPath(configPath, 'nameservers'), `lists ${nameservers.length} nameservers, at most ${limit} fit next to the cluster DNS`));
  if (policy === 'None' && nameservers.length === 0) findings.push(finding(childPath(configPath, 'nameservers'), 'dnsPolicy None needs at least one nameserver'));
  const searches = list(config.searches).map(String);
  if (searches.length > MAX_DNS_SEARCHES) findings.push(finding(childPath(configPath, 'searches'), `lists ${searches.length} search domains, at most ${MAX_DNS_SEARCHES} allowed`));
  if (searches.join(' ').length > MAX_DNS_SEARCH_CHARS) findings.push(finding(childPath(configPath, 'searches'), `exceed ${MAX_DNS_SEARCH_CHARS} characters`));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S24 StatefulSet governing Service

function checkGoverningService(object: Json, env: RuleEnvironment): Finding[] {
  const serviceName = rec(object.spec).serviceName;
  const expected = `${nameOf(object)}-hl`;
  if (serviceName !== expected) return [finding('spec.serviceName', `must be ${expected} (immutable, independent of ports)`)];
  if (!isDnsLabel(expected)) return [finding('spec.serviceName', `${expected} is not a DNS-1123 label`)];
  const service = env.services.get(expected);
  if (service === undefined || rec(service.spec).clusterIP !== 'None') return [finding('spec.serviceName', `names no headless Service ${expected} of the artifact`)];
  return [];
}

// ---------------------------------------------------------------------------------------------
// S25 per-kind fields (SEM-016, SEM-061)

const KIND_FIELDS: Record<string, { mandatory: string[]; forbidden: string[] }> = {
  Deployment: { mandatory: ['replicas', 'revisionHistoryLimit', 'progressDeadlineSeconds', 'strategy'], forbidden: ['updateStrategy'] },
  StatefulSet: {
    mandatory: ['replicas', 'revisionHistoryLimit', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy'],
    forbidden: ['progressDeadlineSeconds', 'strategy'],
  },
  DaemonSet: { mandatory: ['revisionHistoryLimit', 'updateStrategy'], forbidden: ['replicas', 'progressDeadlineSeconds', 'strategy'] },
  Job: { mandatory: ['backoffLimit', 'completions', 'parallelism'], forbidden: ['replicas', 'updateStrategy'] },
};

function checkKindFields(object: Json): Finding[] {
  const fields = KIND_FIELDS[text(object.kind) ?? ''];
  if (fields === undefined) return [];
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  for (const field of fields.mandatory) if (!has(spec, field)) findings.push(finding(childPath('spec', field), `is mandatory on a ${String(object.kind)} (emission rule 8)`));
  for (const field of fields.forbidden) if (has(spec, field)) findings.push(finding(childPath('spec', field), `does not exist on a ${String(object.kind)}`));
  if (spec.minReadySeconds === 0) findings.push(finding('spec.minReadySeconds', 'is emitted only when above 0'));
  if (object.kind === 'StatefulSet') {
    const retention = rec(spec.persistentVolumeClaimRetentionPolicy);
    if (has(spec, 'persistentVolumeClaimRetentionPolicy') && (retention.whenDeleted !== 'Retain' || retention.whenScaled !== 'Retain')) {
      findings.push(finding('spec.persistentVolumeClaimRetentionPolicy', 'must be whenDeleted: Retain, whenScaled: Retain (D7)'));
    }
  }
  const template = templateOf(object);
  if (template === null) return findings;
  const pod = template.spec;
  if (!has(pod, 'terminationGracePeriodSeconds')) findings.push(finding(childPath(template.specPath, 'terminationGracePeriodSeconds'), 'is mandatory (emission rule 8)'));
  for (const field of ['enableServiceLinks', 'automountServiceAccountToken']) {
    if (pod[field] !== false) findings.push(finding(childPath(template.specPath, field), 'must be false (emission rule 8)'));
  }
  if (!has(rec(pod.securityContext), 'seccompProfile')) findings.push(finding(sub(template.specPath, 'securityContext.seccompProfile'), 'is mandatory (emission rule 8)'));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S26 explicit list-map keys

function checkExplicitKeys(object: Json): Finding[] {
  const findings: Finding[] = [];
  if (object.kind === 'Service') {
    list(rec(object.spec).ports).forEach((port, index) => {
      if (!has(rec(port), 'protocol')) findings.push(finding(childPath(childPath('spec.ports', index), 'protocol'), 'is mandatory: it is half of the list-map key'));
    });
  }
  if (object.kind === 'IngressRoute') {
    list(rec(object.spec).routes).forEach((route, index) => {
      if (!has(rec(route), 'kind')) findings.push(finding(childPath(childPath('spec.routes', index), 'kind'), 'is mandatory (kind: Rule)'));
    });
  }
  const template = templateOf(object);
  if (template === null) return findings;
  for (const { container, path } of containersOf(template)) {
    list(container.ports).forEach((port, index) => {
      if (!has(rec(port), 'protocol')) findings.push(finding(childPath(childPath(childPath(path, 'ports'), index), 'protocol'), 'is mandatory: it is half of the list-map key'));
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S27 canonical quantities (SEM-006)

const BYTE_RESOURCES = new Set(['memory', 'storage', 'ephemeral-storage', 'sizeLimit']);

function quantityFindings(value: unknown, name: string, path: string): Finding[] {
  if (typeof value !== 'string') return [];
  const quantity = parseQuantity(value);
  if (quantity === null) return [];
  const findings: Finding[] = [];
  const canonical = formatQuantity(quantity);
  if (canonical !== value) findings.push(finding(path, `${JSON.stringify(value)} is not canonical; the API server returns ${JSON.stringify(canonical)}`));
  if (BYTE_RESOURCES.has(name) && value.endsWith('m')) findings.push(finding(path, `${JSON.stringify(value)} is in millibytes`));
  return findings;
}

function resourceListFindings(resources: unknown, path: string): Finding[] {
  const findings: Finding[] = [];
  for (const field of ['limits', 'requests']) {
    for (const [name, value] of Object.entries(rec(rec(resources)[field]))) {
      findings.push(...quantityFindings(value, name, childPath(childPath(path, field), name)));
    }
  }
  return findings;
}

function checkQuantities(object: Json): Finding[] {
  const findings: Finding[] = [];
  if (object.kind === 'PersistentVolumeClaim') findings.push(...resourceListFindings(rec(object.spec).resources, 'spec.resources'));
  list(rec(object.spec).volumeClaimTemplates).forEach((claim, index) => {
    const path = sub(childPath('spec.volumeClaimTemplates', index), 'spec.resources');
    findings.push(...resourceListFindings(rec(rec(claim).spec).resources, path));
  });
  const template = templateOf(object);
  if (template === null) return findings;
  for (const { container, path } of containersOf(template)) findings.push(...resourceListFindings(container.resources, childPath(path, 'resources')));
  list(template.spec.volumes).forEach((volume, index) => {
    const path = childPath(childPath(template.specPath, 'volumes'), index);
    findings.push(...quantityFindings(rec(rec(volume).emptyDir).sizeLimit, 'sizeLimit', sub(path, 'emptyDir.sizeLimit')));
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// S28 hostname placement

function checkHostnames(object: Json, env: RuleEnvironment): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const known = (value: unknown): boolean => typeof value === 'string' && env.nodeNames.has(value);
  const message = (value: unknown): string =>
    `${JSON.stringify(value)} is not nodeNameFor() of a declared servers.yml key; placement validation must refuse it before render`;
  const selector = stringMap(template.spec.nodeSelector);
  if (selector[HOSTNAME_KEY] !== undefined && !known(selector[HOSTNAME_KEY])) {
    findings.push(finding(childPath(childPath(template.specPath, 'nodeSelector'), HOSTNAME_KEY), message(selector[HOSTNAME_KEY])));
  }
  const termsPath = sub(template.specPath, 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms');
  const terms = list(rec(rec(rec(template.spec.affinity).nodeAffinity).requiredDuringSchedulingIgnoredDuringExecution).nodeSelectorTerms);
  terms.forEach((term, index) => {
    list(rec(term).matchExpressions).forEach((raw, position) => {
      const expression = rec(raw);
      if (expression.key !== HOSTNAME_KEY) return;
      const at = childPath(childPath(childPath(termsPath, index), 'matchExpressions'), position);
      list(expression.values).forEach((value, entry) => {
        if (!known(value)) findings.push(finding(childPath(childPath(at, 'values'), entry), message(value)));
      });
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// SEM rules without an S equivalent

function checkDaemonSetRollout(object: Json): Finding[] {
  const strategy = rec(rec(object.spec).updateStrategy);
  if (strategy.type !== 'RollingUpdate' && strategy.type !== undefined) return [];
  const rolling = rec(strategy.rollingUpdate);
  const surge = rolling.maxSurge ?? 0;
  const unavailable = rolling.maxUnavailable ?? 1;
  const findings: Finding[] = [];
  if (isZeroAmount(surge) === isZeroAmount(unavailable)) {
    findings.push(finding('spec.updateStrategy.rollingUpdate', 'exactly one of maxSurge and maxUnavailable must be non-zero'));
  }
  for (const [field, value] of [
    ['maxSurge', surge],
    ['maxUnavailable', unavailable],
  ] as const) {
    const percent = percentOf(value);
    if (percent !== null && percent > 100) findings.push(finding(childPath('spec.updateStrategy.rollingUpdate', field), 'must not exceed 100%'));
  }
  return findings;
}

function checkStatefulSetPolicy(object: Json): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  // Immutable: a value derived from anything would break the next apply (K13).
  if (spec.podManagementPolicy !== 'Parallel') findings.push(finding('spec.podManagementPolicy', `${JSON.stringify(spec.podManagementPolicy)} must be the literal Parallel`));
  if (has(rec(rec(spec.updateStrategy).rollingUpdate), 'maxUnavailable')) {
    findings.push(finding('spec.updateStrategy.rollingUpdate.maxUnavailable', 'is behind a feature gate that is off at the minimum server version'));
  }
  return findings;
}

function profileFindings(profile: unknown, path: string): Finding[] {
  if (!isRecord(profile)) return [];
  const local = profile.type === 'Localhost';
  const named = typeof profile.localhostProfile === 'string' && profile.localhostProfile !== '';
  if (local && !named) return [finding(childPath(path, 'localhostProfile'), 'is required with type Localhost')];
  if (!local && has(profile, 'localhostProfile')) return [finding(childPath(path, 'localhostProfile'), 'is only allowed with type Localhost')];
  return [];
}

function checkSecurity(object: Json): Finding[] {
  const template = templateOf(object);
  if (template === null) return [];
  const findings: Finding[] = [];
  const pod = template.spec;
  const podSecurity = rec(pod.securityContext);
  const securityPath = childPath(template.specPath, 'securityContext');
  if (pod.shareProcessNamespace === true && pod.hostPID === true) findings.push(finding(childPath(template.specPath, 'shareProcessNamespace'), 'cannot be combined with hostPID'));
  list(podSecurity.sysctls).forEach((raw, index) => {
    const name = text(rec(raw).name) ?? '';
    const at = childPath(childPath(childPath(securityPath, 'sysctls'), index), 'name');
    if (!SYSCTL_NAME.test(name) || name.length > 253) findings.push(finding(at, `${JSON.stringify(name)} is not a sysctl name`));
    else if (!SAFE_SYSCTLS.has(name)) findings.push(finding(at, `${name} is not in the safe sysctl list of the minimum server version`));
    if (pod.hostNetwork === true && name.startsWith('net.')) findings.push(finding(at, `${name} cannot be set on a pod in the host network namespace`));
  });
  findings.push(...profileFindings(podSecurity.seccompProfile, childPath(securityPath, 'seccompProfile')));
  findings.push(...profileFindings(podSecurity.appArmorProfile, childPath(securityPath, 'appArmorProfile')));
  for (const { container, path } of containersOf(template)) {
    const context = rec(container.securityContext);
    const contextPath = childPath(path, 'securityContext');
    if (context.privileged === true && context.allowPrivilegeEscalation === false) {
      findings.push(finding(childPath(contextPath, 'allowPrivilegeEscalation'), 'false cannot be combined with privileged: true'));
    }
    findings.push(...profileFindings(context.seccompProfile, childPath(contextPath, 'seccompProfile')));
    findings.push(...profileFindings(context.appArmorProfile, childPath(contextPath, 'appArmorProfile')));
  }
  return findings;
}

function checkFeatureGates(object: Json): Finding[] {
  const findings: Finding[] = [];
  const gated = (path: string): void => {
    findings.push(finding(path, 'is behind a feature gate below beta at the minimum server version'));
  };
  if (object.kind === 'StatefulSet' && has(rec(rec(rec(object.spec).updateStrategy).rollingUpdate), 'maxUnavailable')) {
    gated('spec.updateStrategy.rollingUpdate.maxUnavailable');
  }
  const template = templateOf(object);
  if (template === null) return findings;
  for (const field of ['hostnameOverride', 'hostUsers', 'resources']) if (has(template.spec, field)) gated(childPath(template.specPath, field));
  for (const { container, path } of containersOf(template)) {
    if (has(rec(container.lifecycle), 'stopSignal')) gated(sub(path, 'lifecycle.stopSignal'));
    if (has(container, 'restartPolicyRules')) gated(childPath(path, 'restartPolicyRules'));
  }
  return findings;
}

function checkLoadBalancer(object: Json, env: RuleEnvironment): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  if (spec.type !== 'LoadBalancer') {
    for (const field of ['allocateLoadBalancerNodePorts', 'loadBalancerSourceRanges']) {
      if (has(spec, field)) findings.push(finding(childPath('spec', field), 'only applies to LoadBalancer Services'));
    }
    return findings;
  }
  list(spec.loadBalancerSourceRanges).forEach((range, index) => {
    if (typeof range !== 'string' || !isCidr(range)) findings.push(finding(childPath('spec.loadBalancerSourceRanges', index), `${JSON.stringify(range)} is not a CIDR`));
  });
  const ports = list(spec.ports).map(rec);
  ports.forEach((port, index) => {
    const at = childPath('spec.ports', index);
    if (has(port, 'nodePort')) findings.push(finding(childPath(at, 'nodePort'), 'is never set; the load balancer binds the port itself'));
    if (port.protocol === 'SCTP') findings.push(finding(childPath(at, 'protocol'), 'SCTP is not published through the load balancer'));
  });
  if (ports.length > MAX_LOAD_BALANCER_PORTS) findings.push(finding('spec.ports', `publishes ${ports.length} ports, at most ${MAX_LOAD_BALANCER_PORTS} per Service`));
  const allocate = spec.allocateLoadBalancerNodePorts;
  const valid = env.loadBalancerNodePorts ? allocate === undefined || allocate === true : allocate === false;
  if (!valid) findings.push(finding('spec.allocateLoadBalancerNodePorts', `must be ${env.loadBalancerNodePorts ? 'absent' : 'false'} for this distribution's load balancer`));
  return findings;
}

function envChecksum(data: Json): string | null {
  const environment: { name: string; value: string }[] = [];
  for (const name of Object.keys(data).sort(compareCodeUnits)) {
    const value = data[name];
    const bytes = typeof value === 'string' ? decodeBase64(value) : null;
    if (bytes === null) return null;
    environment.push({ name, value: Buffer.from(bytes).toString('utf8') });
  }
  // canonicalJson of the sorted EnvVar[]: keys `name` < `value`, JSON string escaping.
  return sha256Hex(JSON.stringify(environment));
}

function fileChecksum(object: Json): string | null {
  const entries = [...Object.entries(rec(object.data)).map(([key, value]) => ({ key, value, binary: object.kind === 'Secret' })), ...Object.entries(rec(object.binaryData)).map(([key, value]) => ({ key, value, binary: true }))];
  if (entries.length !== 1 || typeof entries[0].value !== 'string') return null;
  const { value, binary } = entries[0];
  const bytes = binary ? decodeBase64(value) : new TextEncoder().encode(value);
  return bytes === null ? null : sha256Hex(bytes);
}

function checkHashedObject(object: Json): Finding[] {
  const name = nameOf(object);
  const match = HASHED_NAME.exec(name);
  const labelled = labelsOf(object)[LABELS.hashed] !== undefined;
  if (match === null && !labelled) return [];
  const findings: Finding[] = [];
  if (object.immutable !== true) findings.push(finding('immutable', 'must be true on a content-named object'));
  if (labelsOf(object)[LABELS.hashed] !== 'true') findings.push(finding(childPath('metadata.labels', LABELS.hashed), 'must be "true" on a content-named object'));
  if (match === null) return [...findings, finding('metadata.name', `${JSON.stringify(name)} does not end with -<env|secret|config>-<8 hex of the content>`)];
  const [, kind, suffix] = match;
  const wrongKind = kind === 'config' ? object.kind !== 'ConfigMap' : object.kind !== 'Secret';
  if (wrongKind) return [...findings, finding('metadata.name', `a ${String(object.kind)} is never named -${kind}-`)];
  const checksum = kind === 'env' ? envChecksum(rec(object.data)) : fileChecksum(object);
  if (checksum === null) findings.push(finding(kind === 'env' ? 'data' : '', `the content of a -${kind}- object cannot be hashed (one key for files, base64 values)`));
  else if (checksum.slice(0, 8) !== suffix) findings.push(finding('metadata.name', `suffix ${suffix} is not the content checksum prefix ${checksum.slice(0, 8)}`));
  return findings;
}

function sortedStringArrays(value: unknown, path: string, findings: Finding[]): void {
  if (Array.isArray(value)) {
    const orderMatters = ORDERED_MIDDLEWARE_ARRAYS.has(path);
    if (!orderMatters && value.length > 0 && value.every((entry): entry is string => typeof entry === 'string')) {
      const sorted = [...new Set(value)].sort(compareCodeUnits);
      if (sorted.length !== value.length || sorted.some((entry, index) => entry !== value[index])) {
        findings.push(finding(childPath('spec', path), 'is a set in Traefik and must be sorted by code unit without duplicates'));
      }
    }
    value.forEach((entry, index) => sortedStringArrays(entry, childPath(path, index), findings));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) sortedStringArrays(entry, childPath(path, key), findings);
  }
}

function checkMiddleware(object: Json): Finding[] {
  const spec = rec(object.spec);
  const findings: Finding[] = [];
  const prefix = rec(spec.addPrefix).prefix;
  if (has(rec(spec.addPrefix), 'prefix') && !(typeof prefix === 'string' && prefix.startsWith('/'))) {
    findings.push(finding('spec.addPrefix.prefix', `${JSON.stringify(prefix)} must start with /`));
  }
  for (const [key, value] of Object.entries(spec)) sortedStringArrays(value, key, findings);
  return findings;
}

function checkEntryPoints(object: Json): Finding[] {
  return list(rec(object.spec).entryPoints)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry !== 'string' || !ENTRY_POINTS.has(entry))
    .map(({ entry, index }) => finding(childPath('spec.entryPoints', index), `${JSON.stringify(entry)} is not web or websecure`));
}

// ---------------------------------------------------------------------------------------------
// Rule set

const CLAIM_KINDS = ['PersistentVolumeClaim', 'StatefulSet'];

export const SEMANTIC_RULES: readonly SemanticRule[] = [
  { id: 'S01', kinds: 'all', check: checkNames },
  { id: 'S02', kinds: 'all', check: checkLabels },
  { id: 'S03', kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Service'], check: checkSelectors },
  { id: 'S04', kinds: POD_KINDS, check: checkContainers },
  { id: 'S05', kinds: ['Service'], check: checkServicePorts },
  { id: 'S06', kinds: POD_KINDS, check: checkVolumes },
  { id: 'S07', kinds: [...POD_KINDS, 'Middleware'], check: checkReferences },
  { id: 'S08', kinds: ['Secret', 'ConfigMap'], check: checkData },
  { id: 'S09', kinds: LONG_RUNNING_KINDS, check: checkRollout },
  { id: 'S10', kinds: POD_KINDS, check: checkProbes },
  { id: 'S11', kinds: POD_KINDS, check: checkResources },
  { id: 'S12', kinds: 'all', check: checkEnums },
  { id: 'S13', kinds: CLAIM_KINDS, check: checkClaims },
  { id: 'S14', kinds: ['Deployment', 'DaemonSet'], check: checkHostPortStrategy },
  { id: 'S15', kinds: ['Job'], check: checkJob },
  { id: 'S16', kinds: ['IngressRoute', 'Middleware'], check: checkRouting },
  { id: 'S17', kinds: POD_KINDS, check: checkGracePeriod },
  { id: 'S18', kinds: POD_KINDS, check: checkTolerations },
  { id: 'S19', kinds: POD_KINDS, check: checkSpread },
  { id: 'S20', kinds: 'all', check: checkOwnership },
  { id: 'S21', kinds: 'all', check: checkServerOwned },
  { id: 'S22', kinds: ['Secret'], check: checkEnvKeys },
  { id: 'S23', kinds: POD_KINDS, check: checkDns },
  { id: 'S24', kinds: ['StatefulSet'], check: checkGoverningService },
  { id: 'S25', kinds: WORKLOAD_KINDS, check: checkKindFields },
  { id: 'S26', kinds: [...POD_KINDS, 'Service', 'IngressRoute'], check: checkExplicitKeys },
  { id: 'S27', kinds: [...POD_KINDS, 'PersistentVolumeClaim'], check: checkQuantities },
  { id: 'S28', kinds: POD_KINDS, check: checkHostnames },
  { id: 'SEM-013', kinds: ['DaemonSet'], check: checkDaemonSetRollout },
  { id: 'SEM-014', kinds: ['StatefulSet'], check: checkStatefulSetPolicy },
  { id: 'SEM-025', kinds: POD_KINDS, check: checkSecurity },
  { id: 'SEM-033', kinds: POD_KINDS, check: checkFeatureGates },
  { id: 'SEM-042', kinds: ['Service'], check: checkLoadBalancer },
  { id: 'SEM-051', kinds: ['Secret', 'ConfigMap'], check: checkHashedObject },
  { id: 'SEM-072', kinds: ['Middleware'], check: checkMiddleware },
  { id: 'SEM-073', kinds: ['IngressRoute'], check: checkEntryPoints },
];

export const SEMANTIC_RULE_IDS: readonly string[] = SEMANTIC_RULES.map((rule) => rule.id);

// ---------------------------------------------------------------------------------------------
// Entry points

function environment(objects: readonly Json[], context: SemanticContext): RuleEnvironment {
  const byKind = (kind: string): Map<string, Json> => new Map(objects.filter((object) => object.kind === kind).map((object) => [nameOf(object), object]));
  const workloads = objects.filter((object) => (WORKLOAD_KINDS as readonly unknown[]).includes(object.kind));
  const envSecrets = new Set<string>();
  for (const workload of workloads) {
    const template = templateOf(workload);
    if (template === null) continue;
    for (const { container } of containersOf(template)) {
      for (const source of list(container.envFrom)) {
        const name = text(rec(rec(source).secretRef).name);
        if (name !== undefined) envSecrets.add(name);
      }
    }
  }
  return {
    namespace: context.namespace,
    external: new Set(context.externalNames ?? []),
    strictMiddlewares: context.strictMiddlewares === true,
    nodeNames: new Set((context.serverNames ?? []).map(nodeNameFor)),
    clusterDnsNameservers: context.traits?.clusterDnsNameservers ?? 1,
    loadBalancerNodePorts: context.traits?.loadBalancerNodePorts ?? false,
    services: byKind('Service'),
    secrets: byKind('Secret'),
    configMaps: byKind('ConfigMap'),
    claims: byKind('PersistentVolumeClaim'),
    middlewares: byKind('Middleware'),
    workloads,
    envSecrets,
  };
}

function identity(object: unknown): { kind: string; name: string } {
  const record = rec(object);
  return { kind: text(record.kind) ?? '?', name: text(rec(record.metadata).name) ?? '?' };
}

/** Semantic issues of an artifact (the objects of one render), in object order then rule order. */
export function validateSemantics(objects: readonly unknown[], context: SemanticContext): SemanticIssue[] {
  const records = objects.filter(isRecord);
  const env = environment(records, context);
  const skipped = new Set(context.skipRules ?? []);
  const rules = SEMANTIC_RULES.filter((rule) => !skipped.has(rule.id));
  const issues: SemanticIssue[] = [];
  for (const object of objects) {
    const { kind, name } = identity(object);
    if (!isRecord(object)) {
      issues.push({ kind, name, path: '', rule: 'S20', message: 'is not an object' });
      continue;
    }
    for (const rule of rules) {
      if (rule.kinds !== 'all' && !rule.kinds.includes(kind)) continue;
      for (const found of rule.check(object, env)) issues.push({ kind, name, rule: rule.id, ...found });
    }
  }
  return issues;
}

/** Structural issues of every object followed by the semantic issues of the whole artifact. */
export function validateArtifact(objects: readonly unknown[], context: SemanticContext): SemanticIssue[] {
  const structural = objects.flatMap((object) => validateObject(object).map((found) => ({ ...identity(object), ...found })));
  return [...structural, ...validateSemantics(objects, context)];
}

/** Issues that fail a render: everything except SEM-071 warnings. */
export function failures<T extends SchemaIssue>(issues: readonly T[]): T[] {
  return issues.filter((found) => found.severity !== 'warning');
}

/** `<kind>/<name> <path>: <rule> <message>`, one line per issue (design-02 14.5). */
export function formatIssues(issues: readonly SemanticIssue[]): string {
  return issues
    .map((found) => `${found.kind}/${found.name}${found.path === '' ? '' : ` ${found.path}`}: ${found.rule} ${found.message}${found.severity === 'warning' ? ' (warning)' : ''}`)
    .join('\n');
}
