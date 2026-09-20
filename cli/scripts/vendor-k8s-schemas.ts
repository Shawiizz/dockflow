#!/usr/bin/env bun
/**
 * Vendors the API schemas the offline validator checks every generated object against
 * (design-07 7.1, design-02 14.2):
 *   src/__tests__/kubernetes/support/schema/k8s-<k8s>.json.gz       Kubernetes OpenAPI v3
 *   src/__tests__/kubernetes/support/schema/traefik-<chart>.json.gz Traefik IngressRoute and Middleware CRDs
 *   src/__tests__/kubernetes/support/schema/SOURCES.md              URLs, tags and sha256 of the inputs
 *
 * Usage (from cli/):
 *   bun run scripts/vendor-k8s-schemas.ts [--k8s <v>] [--traefik-chart <v>] [--check]
 *
 * The Kubernetes version defaults to K3S_PIN.minimumServerVersion: vendoring the oldest supported
 * server makes a field added in a later version fail offline. The chart must be the pinned one,
 * because its archive is refused unless it hashes to TRAEFIK_CHART_PIN.sha256. Both schema sets are
 * trimmed to the $ref closure of the kinds Dockflow creates, without descriptions or examples.
 * --check rebuilds everything in memory and exits 1 when a committed file differs.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import { K3S_PIN } from '../src/services/orchestrator/kubernetes/k3s/versions';
import { TRAEFIK_CHART_PIN } from '../src/services/orchestrator/kubernetes/versions';

const CLI_DIR = resolve(import.meta.dir, '..');
const SCHEMA_DIR = join(CLI_DIR, 'src', '__tests__', 'kubernetes', 'support', 'schema');
const SOURCES_FILE = 'SOURCES.md';

const K8S_SPEC_BASE = 'https://raw.githubusercontent.com/kubernetes/kubernetes';
const K8S_DOCUMENTS = [
  'api__v1_openapi.json',
  'apis__apps__v1_openapi.json',
  'apis__batch__v1_openapi.json',
  'apis__coordination.k8s.io__v1_openapi.json',
  'apis__storage.k8s.io__v1_openapi.json',
  'apis__rbac.authorization.k8s.io__v1_openapi.json',
  'apis__apiextensions.k8s.io__v1_openapi.json',
];
const REF_PREFIX = '#/components/schemas/';

/** `<apiVersion>/<kind>` -> OpenAPI definition name (design-07 7.1 step 3) */
const K8S_ROOTS: Record<string, string> = {
  'v1/Namespace': 'io.k8s.api.core.v1.Namespace',
  'v1/Service': 'io.k8s.api.core.v1.Service',
  'v1/Secret': 'io.k8s.api.core.v1.Secret',
  'v1/ConfigMap': 'io.k8s.api.core.v1.ConfigMap',
  'v1/PersistentVolumeClaim': 'io.k8s.api.core.v1.PersistentVolumeClaim',
  'v1/PersistentVolume': 'io.k8s.api.core.v1.PersistentVolume',
  'v1/Pod': 'io.k8s.api.core.v1.Pod',
  'v1/ServiceAccount': 'io.k8s.api.core.v1.ServiceAccount',
  'apps/v1/Deployment': 'io.k8s.api.apps.v1.Deployment',
  'apps/v1/StatefulSet': 'io.k8s.api.apps.v1.StatefulSet',
  'apps/v1/DaemonSet': 'io.k8s.api.apps.v1.DaemonSet',
  'batch/v1/Job': 'io.k8s.api.batch.v1.Job',
  'coordination.k8s.io/v1/Lease': 'io.k8s.api.coordination.v1.Lease',
  'storage.k8s.io/v1/StorageClass': 'io.k8s.api.storage.v1.StorageClass',
  'rbac.authorization.k8s.io/v1/ClusterRoleBinding': 'io.k8s.api.rbac.v1.ClusterRoleBinding',
  // The pinned Traefik CRDs themselves (design-04 2.5, KubeExecutor.apply before install/upgrade).
  'apiextensions.k8s.io/v1/CustomResourceDefinition': 'io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.CustomResourceDefinition',
};

interface CrdRoot {
  file: string;
  crd: string;
  kind: string;
}

const TRAEFIK_CRDS: CrdRoot[] = [
  { file: 'crds/traefik.io_ingressroutes.yaml', crd: 'ingressroutes.traefik.io', kind: 'IngressRoute' },
  { file: 'crds/traefik.io_middlewares.yaml', crd: 'middlewares.traefik.io', kind: 'Middleware' },
];

/** Validation keywords the offline validator reads; `x-kubernetes-*` is kept as well. */
const KEPT_KEYWORDS = new Set([
  '$ref',
  'type',
  'format',
  'enum',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'required',
  'default',
  'properties',
  'additionalProperties',
  'items',
  'allOf',
  'oneOf',
  'anyOf',
]);

const PLAIN_VERSION_RE = /^v\d+\.\d+\.\d+$/;
const CHART_VERSION_RE = /^\d+\.\d+\.\d+$/;
const REQUEST_TIMEOUT_MS = 300_000;

const USAGE = `Usage (from cli/):
  bun run scripts/vendor-k8s-schemas.ts [--k8s <v>] [--traefik-chart <v>] [--check]

  --k8s <v>            Kubernetes version of the OpenAPI documents (default: K3S_PIN.minimumServerVersion)
  --traefik-chart <v>  Traefik chart version (default and only accepted value: TRAEFIK_CHART_PIN.version)
  --check              rebuild in memory and exit 1 when a committed file differs
`;

class VendorError extends Error {}
class UsageError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Source {
  url: string;
  sha256: string;
}

interface Bundle {
  schema: 1;
  sources: Source[];
  roots: Record<string, string>;
  schemas: Record<string, JsonObject>;
}

interface Output {
  file: string;
  bytes: Uint8Array;
  /** compared by --check; gzip bytes depend on the zlib build, their content does not */
  content: string;
}

interface Options {
  k8s: string;
  traefikChart: string;
  check: boolean;
  help: boolean;
}

// ---------------------------------------------------------------------------------------------
// Arguments and small helpers

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let check = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === '--k8s' || name === '--traefik-chart') {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
      if (values.has(name)) throw new UsageError(`${name} is given twice`);
      values.set(name, value);
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--help') {
      help = true;
    } else {
      throw new UsageError(`Unknown argument ${arg}`);
    }
  }
  const k8s = values.get('--k8s') ?? K3S_PIN.minimumServerVersion;
  const traefikChart = values.get('--traefik-chart') ?? TRAEFIK_CHART_PIN.version;
  if (!PLAIN_VERSION_RE.test(k8s)) throw new UsageError(`--k8s takes a vX.Y.Z Kubernetes tag, not ${k8s}`);
  if (!CHART_VERSION_RE.test(traefikChart)) throw new UsageError(`--traefik-chart takes an X.Y.Z chart version, not ${traefikChart}`);
  if (traefikChart !== TRAEFIK_CHART_PIN.version) {
    throw new UsageError(
      `Traefik chart ${traefikChart} is not the pinned chart ${TRAEFIK_CHART_PIN.version}; pin it first with scripts/pin-kubernetes.ts`,
    );
  }
  return { k8s, traefikChart, check, help };
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, what: string): JsonObject {
  if (!isObject(value)) throw new VendorError(`${what} is not an object`);
  return value;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with keys sorted at every depth, so a rebuild from the same inputs is byte-identical. */
function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

function gzip(text: string): Uint8Array {
  const bytes = new Uint8Array(gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
  // No timestamp and OS "unknown": the header then does not depend on the machine that ran the script.
  bytes.fill(0, 4, 8);
  bytes[9] = 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Downloads

async function request(url: string): Promise<Response> {
  if (!url.startsWith('https://')) throw new VendorError(`Refusing to download ${url} over a non-HTTPS URL`);
  let failure = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dockflow-vendor-k8s-schemas' },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      failure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await Bun.sleep(attempt * 2000);
  }
  throw new VendorError(`GET ${url} failed: ${failure}`);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await request(url)).arrayBuffer());
}

// ---------------------------------------------------------------------------------------------
// Chart archive (ustar with GNU long names and PAX paths)

const decoder = new TextDecoder();

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function paxPath(data: Uint8Array): string | null {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) return null;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    if (record.startsWith('path=')) return record.slice('path='.length);
    offset += length;
  }
  return null;
}

function readTarGz(archive: Uint8Array, name: string): Map<string, Uint8Array> {
  const tar = new Uint8Array(gunzipSync(archive));
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | null = null;
  let pax: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if ((header[124] & 0x80) !== 0) throw new VendorError(`${name}: base-256 tar sizes are not supported`);
    const sizeText = cString(header.subarray(124, 136)).trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size)) throw new VendorError(`${name}: invalid tar size field`);
    const type = String.fromCharCode(header[156]);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = paxPath(data);
      continue;
    }
    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    if (type === 'g') continue;
    const prefix = cString(header.subarray(345, 500));
    const entry = pax ?? longName ?? (prefix === '' ? cString(header.subarray(0, 100)) : `${prefix}/${cString(header.subarray(0, 100))}`);
    pax = null;
    longName = null;
    if (type === '0' || type === '\0' || type === '7') files.set(entry, data);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Trimming

function prune(node: Json, path: string): JsonObject {
  const schema = asObject(node, path);
  const result: JsonObject = {};
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const value = schema[key];
    if (!KEPT_KEYWORDS.has(key) && !key.startsWith('x-kubernetes-')) continue;
    if (key === 'properties') {
      const properties = asObject(value, `${path}.properties`);
      const pruned: JsonObject = {};
      for (const name of Object.keys(properties).sort(compareCodeUnits)) pruned[name] = prune(properties[name], `${path}.${name}`);
      result.properties = pruned;
    } else if (key === 'items') {
      result.items = prune(value, `${path}[]`);
    } else if (key === 'additionalProperties') {
      result.additionalProperties = typeof value === 'boolean' ? value : prune(value, `${path}{}`);
    } else if (key === 'allOf' || key === 'oneOf' || key === 'anyOf') {
      if (!Array.isArray(value)) throw new VendorError(`${path}.${key} is not an array`);
      result[key] = value.map((member, index) => prune(member, `${path}.${key}[${index}]`));
    } else {
      result[key] = value;
    }
  }
  return result;
}

function refsOf(node: Json, found: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) refsOf(item, found);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (!value.startsWith(REF_PREFIX)) throw new VendorError(`Unsupported $ref ${value}`);
        found.add(value.slice(REF_PREFIX.length));
      } else if (key !== 'default' && key !== 'enum') {
        refsOf(value, found);
      }
    }
  }
  return found;
}

function closure(roots: string[], definitions: Map<string, JsonObject>): Record<string, JsonObject> {
  const result: Record<string, JsonObject> = {};
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || result[name] !== undefined) continue;
    const definition = definitions.get(name);
    if (definition === undefined) throw new VendorError(`The OpenAPI documents define no ${name}`);
    result[name] = definition;
    queue.push(...refsOf(definition, new Set()));
  }
  return result;
}

function checkGroupVersionKind(key: string, name: string, schema: JsonObject): void {
  const slash = key.lastIndexOf('/');
  const apiVersion = key.slice(0, slash);
  const kind = key.slice(slash + 1);
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  const gvks = schema['x-kubernetes-group-version-kind'];
  const matches =
    Array.isArray(gvks) && gvks.some((gvk) => isObject(gvk) && gvk.group === group && gvk.version === version && gvk.kind === kind);
  if (!matches) throw new VendorError(`${name} is not the schema of ${apiVersion} ${kind}`);
}

// ---------------------------------------------------------------------------------------------
// Bundles

interface Built {
  outputs: Output[];
  summary: string[];
}

async function kubernetesBundle(version: string): Promise<{ bundle: Bundle; documents: Source[] }> {
  const definitions = new Map<string, JsonObject>();
  const documents: Source[] = [];
  for (const document of K8S_DOCUMENTS) {
    const url = `${K8S_SPEC_BASE}/${version}/api/openapi-spec/v3/${document}`;
    err(`- ${url}`);
    const bytes = await fetchBytes(url);
    documents.push({ url, sha256: sha256Hex(bytes) });
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    const schemas = asObject(asObject(asObject(parsed, document).components, `${document} components`).schemas, `${document} schemas`);
    for (const [name, schema] of Object.entries(schemas)) {
      const pruned = prune(schema, name);
      const previous = definitions.get(name);
      // Shared definitions (ObjectMeta, ...) are repeated in every document; they must agree.
      if (previous !== undefined && stableJson(previous) !== stableJson(pruned)) {
        throw new VendorError(`${name} differs between the OpenAPI documents of ${version}`);
      }
      definitions.set(name, pruned);
    }
  }
  for (const [key, name] of Object.entries(K8S_ROOTS)) {
    const schema = definitions.get(name);
    if (schema === undefined) throw new VendorError(`The OpenAPI documents of ${version} define no ${name}`);
    checkGroupVersionKind(key, name, schema);
  }
  const roots = Object.fromEntries(Object.entries(K8S_ROOTS).sort(([a], [b]) => compareCodeUnits(a, b)));
  const schemas = closure(Object.values(K8S_ROOTS), definitions);
  return { bundle: { schema: 1, sources: documents, roots, schemas }, documents };
}

async function traefikBundle(version: string): Promise<{ bundle: Bundle; archive: Source; files: Source[] }> {
  const indexUrl = `${TRAEFIK_CHART_PIN.repo}/index.yaml`;
  err(`- ${indexUrl}`);
  const index = asObject(parseYaml(decoder.decode(await fetchBytes(indexUrl))), indexUrl);
  const entries = asObject(index.entries, `${indexUrl} entries`)[TRAEFIK_CHART_PIN.chart];
  const entry = Array.isArray(entries) ? entries.find((candidate) => isObject(candidate) && candidate.version === version) : undefined;
  const urls = isObject(entry) ? entry.urls : undefined;
  const listed = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : null;
  if (listed === null) throw new VendorError(`${indexUrl} lists no ${TRAEFIK_CHART_PIN.chart} ${version} archive`);
  const url = new URL(listed, `${TRAEFIK_CHART_PIN.repo}/`).href;
  err(`- ${url}`);
  const bytes = await fetchBytes(url);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== TRAEFIK_CHART_PIN.sha256) {
    throw new VendorError(`${url} hashes to ${sha256}, TRAEFIK_CHART_PIN.sha256 is ${TRAEFIK_CHART_PIN.sha256}`);
  }
  const archiveName = `${TRAEFIK_CHART_PIN.chart}-${version}.tgz`;
  const tar = readTarGz(bytes, archiveName);
  const roots: Record<string, string> = {};
  const schemas: Record<string, JsonObject> = {};
  const files: Source[] = [];
  for (const root of TRAEFIK_CRDS) {
    const path = `${TRAEFIK_CHART_PIN.chart}/${root.file}`;
    const data = tar.get(path);
    if (data === undefined) throw new VendorError(`${archiveName} has no ${path}`);
    files.push({ url: path, sha256: sha256Hex(data) });
    const documents = parseAllDocuments(decoder.decode(data)).map((document) => {
      if (document.errors.length > 0) throw new VendorError(`${path}: ${document.errors[0].message}`);
      return document.toJS() as unknown;
    });
    const crd = documents.find((doc) => isObject(doc) && doc.kind === 'CustomResourceDefinition' && isObject(doc.metadata) && doc.metadata.name === root.crd);
    const spec = asObject(asObject(crd, `${path} (${root.crd})`).spec, `${path} spec`);
    const names = asObject(spec.names, `${path} spec.names`);
    if (names.kind !== root.kind || typeof spec.group !== 'string') throw new VendorError(`${path} does not define ${root.kind}`);
    const versions = Array.isArray(spec.versions) ? spec.versions : [];
    const served = versions.filter((candidate) => isObject(candidate) && candidate.served === true && candidate.storage === true);
    const chosen = served.length === 1 ? served[0] : undefined;
    if (!isObject(chosen) || typeof chosen.name !== 'string') throw new VendorError(`${path}: expected exactly one served storage version`);
    const openApi = asObject(asObject(chosen.schema, `${path} schema`).openAPIV3Schema, `${path} openAPIV3Schema`);
    // Reverse-domain name, as the API server publishes CRD schemas in its own OpenAPI document.
    const name = `${spec.group.split('.').reverse().join('.')}.${chosen.name}.${root.kind}`;
    roots[`${spec.group}/${chosen.name}/${root.kind}`] = name;
    schemas[name] = prune(openApi, name);
  }
  const archive = { url, sha256 };
  return { bundle: { schema: 1, sources: [archive], roots, schemas }, archive, files };
}

function bundleOutput(file: string, bundle: Bundle): Output {
  const content = stableJson(bundle as unknown as Json);
  return { file, bytes: gzip(content), content };
}

function sourcesMarkdown(
  k8s: string,
  kubernetes: { bundle: Bundle; documents: Source[] },
  chart: string,
  traefik: { bundle: Bundle; archive: Source; files: Source[] },
): string {
  const rootList = (bundle: Bundle): string => Object.keys(bundle.roots).map((root) => `\`${root}\``).join(', ');
  const lines = [
    '# Vendored API schemas',
    '',
    'Generated by `cli/scripts/vendor-k8s-schemas.ts`; do not edit. Refresh from `cli/` with',
    '`bun run scripts/vendor-k8s-schemas.ts`; `--check` compares the committed files with a fresh download.',
    'Every definition is trimmed to the validation keywords (`description` and `example` removed) and to the',
    '`$ref` closure of its roots. `support/schema/validate.ts` reads both files.',
    '',
    `## k8s-${k8s}.json.gz`,
    '',
    `Kubernetes \`${k8s}\` OpenAPI v3, the minimum server version (\`K3S_PIN.minimumServerVersion\`), so a field added`,
    `in a later version fails offline. ${Object.keys(kubernetes.bundle.schemas).length} definitions.`,
    '',
    '| Document | sha256 |',
    '|---|---|',
    ...kubernetes.documents.map((source) => `| ${source.url} | \`${source.sha256}\` |`),
    '',
    `Roots: ${rootList(kubernetes.bundle)}.`,
    '',
    `## traefik-${chart}.json.gz`,
    '',
    `Traefik chart \`${chart}\`: the \`openAPIV3Schema\` of the served storage version of the CRDs below. The archive`,
    'hashes to `TRAEFIK_CHART_PIN.sha256`; the validator checks `metadata` against the Kubernetes `ObjectMeta`.',
    '',
    '| Archive | sha256 |',
    '|---|---|',
    `| ${traefik.archive.url} | \`${traefik.archive.sha256}\` |`,
    '',
    '| File in the archive | sha256 |',
    '|---|---|',
    ...traefik.files.map((source) => `| \`${source.url}\` | \`${source.sha256}\` |`),
    '',
    `Roots: ${rootList(traefik.bundle)}.`,
    '',
  ];
  return lines.join('\n');
}

async function build(options: Options): Promise<Built> {
  const kubernetes = await kubernetesBundle(options.k8s);
  const traefik = await traefikBundle(options.traefikChart);
  const sources = sourcesMarkdown(options.k8s, kubernetes, options.traefikChart, traefik);
  const outputs = [
    bundleOutput(`k8s-${options.k8s}.json.gz`, kubernetes.bundle),
    bundleOutput(`traefik-${options.traefikChart}.json.gz`, traefik.bundle),
    { file: SOURCES_FILE, bytes: Buffer.from(sources, 'utf8'), content: sources },
  ];
  const summary = outputs.map((output) => `${output.file}: ${output.bytes.length} bytes`);
  return { outputs, summary };
}

function committedContent(file: string): string | null {
  const path = join(SCHEMA_DIR, file);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const text = file.endsWith('.gz') ? decoder.decode(gunzipSync(bytes)) : decoder.decode(bytes);
  return text.replace(/\r\n/g, '\n');
}

/** Vendored bundles of other versions, which a version bump replaces. */
function staleBundles(outputs: Output[]): string[] {
  if (!existsSync(SCHEMA_DIR)) return [];
  const current = new Set(outputs.map((output) => output.file));
  return readdirSync(SCHEMA_DIR).filter((file) => /^(k8s|traefik)-.+\.json\.gz$/.test(file) && !current.has(file));
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const { outputs, summary } = await build(options);
  const stale = staleBundles(outputs);
  if (options.check) {
    const problems = outputs.filter((output) => committedContent(output.file) !== output.content).map((output) => output.file);
    problems.push(...stale.map((file) => `${file} (no longer produced)`));
    if (problems.length === 0) {
      out('Vendored schemas are up to date');
      return 0;
    }
    err(`Out of date: ${problems.join(', ')}\nRun bun run scripts/vendor-k8s-schemas.ts from cli/ and commit the result.`);
    return 1;
  }
  mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const output of outputs) writeFileSync(join(SCHEMA_DIR, output.file), output.bytes);
  for (const file of stale) rmSync(join(SCHEMA_DIR, file));
  for (const line of summary) out(line);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof UsageError) {
        err(`${error.message}\n\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      err(`vendor-k8s-schemas: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
