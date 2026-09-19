// Deterministic multi-document YAML for stack artifacts (DESIGN-CORE 4.2 rules 1-7, 9, 10) and its
// reader. Array order and the per-kind field policy (rule 8) are the translator's job; this module
// owns the header, document order, key order, scalar styles and the digest.
// Pure: no I/O, no clock.

import { Document, isScalar, parseAllDocuments, parseDocument, Scalar, visit } from 'yaml';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { DeployError, ErrorCode } from '../../../utils/errors';
import type { HelmReleaseRecord, StackArtifactFormat, StackRole } from '../interfaces';
import { isManifestKind, KIND_REGISTRY, type ManifestObject } from './resources/registry';

export interface ArtifactHeader {
  format: StackArtifactFormat;
  stackName: string;
  role: StackRole;
  version: string;
}

export const ARTIFACT_FORMAT_LINE_PREFIX = '# dockflow-artifact: ';

/** Keys written first, in this order, in every mapping; all other keys follow in code-unit order. */
export const KEY_PRIORITY: readonly string[] = ['apiVersion', 'kind', 'metadata', 'name', 'namespace', 'type'];

const BUG_HINT = 'Report this as a Dockflow bug.';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareKeys(a: string, b: string): number {
  const pa = KEY_PRIORITY.indexOf(a);
  const pb = KEY_PRIORITY.indexOf(b);
  if (pa !== -1 || pb !== -1) {
    if (pa === -1) return 1;
    if (pb === -1) return -1;
    return pa - pb;
  }
  return compareCodeUnits(a, b);
}

function describe(object: ManifestObject): string {
  return `${object.kind}/${object.metadata?.name ?? '?'}`;
}

/**
 * Rebuilds a manifest value with keys in emission order and undefined properties dropped. `null`
 * and non-finite numbers are never produced by the translator: meeting one is a Dockflow bug.
 */
function ordered(value: unknown, where: string, path: string): unknown {
  if (value === null) throw new DeployError(`Manifest ${where} has a null value at ${path || '.'}`, ErrorCode.DEPLOY_FAILED, BUG_HINT);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DeployError(`Manifest ${where} has a non-finite number at ${path}`, ErrorCode.DEPLOY_FAILED, BUG_HINT);
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item, i) => ordered(item, where, `${path}[${i}]`));
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareKeys)) {
      if (record[key] !== undefined) out[key] = ordered(record[key], where, path ? `${path}.${key}` : key);
    }
    return out;
  }
  throw new DeployError(`Manifest ${where} has a value of type ${typeof value} at ${path}`, ErrorCode.DEPLOY_FAILED, BUG_HINT);
}

/**
 * kubectl reads manifests with YAML 1.1 rules (go-yaml v2): `yes`, `on`, `y`, `0b101`, `1_000`
 * or a timestamp written plain are not strings there, although YAML 1.2 keeps them as strings,
 * and a plain `<<` key is a merge key.
 */
function plainIsSafe(text: string, memo: Map<string, boolean>): boolean {
  const known = memo.get(text);
  if (known !== undefined) return known;
  let safe = text !== '<<';
  for (const version of ['1.1', '1.2'] as const) {
    if (!safe) break;
    const doc = parseDocument(text, { version });
    safe = doc.errors.length === 0 && isScalar(doc.contents) && doc.contents.value === text;
  }
  memo.set(text, safe);
  return safe;
}

/** Forces double quotes where the library's own YAML 1.2 choice is not enough (keys included). */
function styleScalars(doc: Document, memo: Map<string, boolean>): void {
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return;
      const text = node.value;
      // a tab or BOM stays escaped; trailing blank lines would need keep chomping and break the
      // single trailing newline of the file
      if (/[\t\u{feff}]/u.test(text) || /(?:^|\n)\n$/.test(text)) {
        node.type = Scalar.QUOTE_DOUBLE;
      } else if (!text.includes('\n') && !plainIsSafe(text, memo)) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
}

function assertEncodable(object: ManifestObject): void {
  if (!isManifestKind(object.kind)) {
    throw new DeployError(`Manifest kind ${String(object.kind)} cannot be part of a stack artifact`, ErrorCode.DEPLOY_FAILED, BUG_HINT);
  }
  if (typeof object.metadata?.name !== 'string' || object.metadata.name === '') {
    throw new DeployError(`Manifest ${object.kind} has no metadata.name`, ErrorCode.DEPLOY_FAILED, BUG_HINT);
  }
}

/** Deterministic multi-document YAML: header comments, then ordered documents. */
export function emitManifests(objects: ManifestObject[], header: ArtifactHeader): string {
  for (const object of objects) assertEncodable(object);
  const sorted = [...objects].sort(
    (a, b) => KIND_REGISTRY[a.kind].rank - KIND_REGISTRY[b.kind].rank || compareCodeUnits(a.metadata.name, b.metadata.name),
  );
  // rule 9: accessory artifacts carry no version, so the accessories digest follows the accessories only
  const version = header.role === 'accessory' ? '-' : header.version;
  const lines = [
    `${ARTIFACT_FORMAT_LINE_PREFIX}${header.format}`,
    `# stack: ${header.stackName}`,
    `# role: ${header.role}`,
    `# version: ${version}`,
  ];
  let out = `${lines.join('\n')}\n`;
  const memo = new Map<string, boolean>();
  for (const object of sorted) {
    const doc = new Document(ordered(object, describe(object), ''), { aliasDuplicateObjects: false });
    styleScalars(doc, memo);
    out += `---\n${doc.toString({ lineWidth: 0, indent: 2, blockQuote: 'literal' })}`;
  }
  return out;
}

/** First-line format detection; content without the header line is 'swarm-compose/1'. */
export function readArtifactFormat(content: string): StackArtifactFormat {
  const end = content.indexOf('\n');
  const first = (end === -1 ? content : content.slice(0, end)).replace(/^\u{feff}/u, '').replace(/\r$/, '');
  if (!first.startsWith(ARTIFACT_FORMAT_LINE_PREFIX)) return 'swarm-compose/1';
  const format = first.slice(ARTIFACT_FORMAT_LINE_PREFIX.length).trim();
  if (format === 'k8s-manifests/1' || format === 'swarm-compose/1') return format;
  throw new DeployError(
    `Artifact format ${format} is not supported by this version of Dockflow`,
    ErrorCode.DEPLOY_FAILED,
    'Upgrade Dockflow to the version that deployed this release.',
  );
}

/** Parses emitted manifests back (rollback, --only closure, prune plans). Throws DeployError on invalid YAML. */
export function parseManifests(content: string): ManifestObject[] {
  const docs = parseAllDocuments(content);
  const objects: ManifestObject[] = [];
  docs.forEach((doc, index) => {
    const error = doc.errors[0];
    if (error) {
      throw new DeployError(`Stored manifests are not valid YAML: ${error.message.split('\n')[0]}`, ErrorCode.DEPLOY_FAILED);
    }
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new DeployError(`Stored manifest document ${index + 1} is not an object`, ErrorCode.DEPLOY_FAILED);
    }
    objects.push(value as ManifestObject);
  });
  return objects;
}

/** Rule 10: `StackArtifact.digest`, covering the manifests and the Helm records (values included). */
export function artifactDigest(content: string, helm: readonly HelmReleaseRecord[]): string {
  return sha256Hex(`${content}\n${canonicalJson(helm)}`);
}

/** Rule 7: a Secret `data` value is the base64 of the raw bytes (strings as UTF-8). */
export function secretDataValue(content: string | Uint8Array): string {
  return (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)).toString('base64');
}

/** Rule 7: ConfigMap content goes to `data` when it is valid UTF-8 and to `binaryData` (base64) otherwise. */
export function configMapValue(content: Uint8Array): { field: 'data' | 'binaryData'; value: string } {
  try {
    return { field: 'data', value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) };
  } catch {
    return { field: 'binaryData', value: Buffer.from(content).toString('base64') };
  }
}
