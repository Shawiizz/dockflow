// Normalizer handler for the `x-dockflow` extension (design-01 1.1 row 15, 8): the service and
// volume fields validated by `schemas/compose-extension.schema.ts` and the cross-field rules of
// 8.3. X3 and X10 are decidable on the model and belong to the translator (design-01 1.6); X11, an
// `x-dockflow` written anywhere else, is reported by the key walker (keys.ts), which knows every
// path of the registry.
// Pure. A handler never throws on user input: an invalid extension leaves every default in place.

import type { z } from 'zod';
import {
  type ServiceExtensionInput,
  ServiceExtensionSchema,
  VolumeExtensionSchema,
} from '../../../../schemas/compose-extension.schema';
import type { DiagnosticSink } from '../../diagnostics';
import type { ProbeOverride, ServiceExtension, TolerationSpec } from '../model/types';
import { canonicalQuantity } from '../model/units';
import {
  childPath,
  indexPath,
  isPlainMap,
  type NormalizeContext,
  type ServiceDraft,
  sortedKeys,
  sortedUnique,
  type VolumeDraft,
  type VolumeTable,
} from './context';

export const EXTENSION_KEY = 'x-dockflow';

const REFERENCE_HINT = 'See the `x-dockflow` reference on the Kubernetes page of the documentation.';

type Mapping = Record<string, unknown>;

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'list';
  if (isPlainMap(v)) return 'mapping';
  return typeof v;
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// zod issues -> extension.invalid (design-01 8.1)
// ---------------------------------------------------------------------------

/** zod's `expected` names in the vocabulary of values.invalid-type */
const EXPECTED: Readonly<Record<string, string>> = { object: 'mapping', record: 'mapping', array: 'list', int: 'integer' };

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let v = data;
  for (const segment of path) {
    if (Array.isArray(v) && typeof segment === 'number') v = v[segment];
    else if (isPlainMap(v) && typeof segment === 'string') v = v[segment];
    else return undefined;
  }
  return v;
}

function joinPath(base: string, path: readonly PropertyKey[]): string {
  let out = base;
  for (const segment of path) out = typeof segment === 'number' ? indexPath(out, segment) : childPath(out, String(segment));
  return out;
}

const NUMERIC_TEXT = /^-?[0-9]+(?:\.[0-9]+)?$/;

function issueMessage(issue: z.core.$ZodIssue, value: unknown): { message: string; hint: string } {
  const hint = REFERENCE_HINT;
  switch (issue.code) {
    case 'invalid_value':
      return { message: `expected one of ${issue.values.map(String).join(', ')}`, hint };
    case 'invalid_type': {
      const expected = EXPECTED[issue.expected] ?? issue.expected;
      if (value === undefined) return { message: `is required: expected ${expected}`, hint };
      // a quoted YAML number reaches zod as a string
      const quoted = (expected === 'number' || expected === 'integer') && typeof value === 'string' && NUMERIC_TEXT.test(value);
      return { message: `expected ${expected}, got ${typeName(value)}`, hint: quoted ? 'Write the number without quotes.' : hint };
    }
    case 'invalid_union':
      return { message: `${show(value)} is not a CIDR range such as 10.0.0.0/8`, hint };
    case 'invalid_key': {
      const inner = issue.issues[0];
      const key = issue.path[issue.path.length - 1];
      const detail = inner ? issueMessage(inner, key).message : issue.message;
      return { message: `key ${String(key)} ${detail}`, hint };
    }
    case 'too_small':
      return { message: `must be at least ${issue.minimum}`, hint };
    case 'too_big':
      return { message: `must be at most ${issue.maximum}`, hint };
    default:
      // invalid_format and custom carry the message written in the schema
      return { message: issue.message, hint };
  }
}

/** One extension.invalid per issue; unknown keys get one diagnostic each at their own path. */
function reportIssues(issues: readonly z.core.$ZodIssue[], base: string, data: unknown, sink: DiagnosticSink): void {
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) sink.error('extension.invalid', joinPath(base, [...issue.path, key]), 'is not an x-dockflow key', REFERENCE_HINT);
      continue;
    }
    const { message, hint } = issueMessage(issue, valueAt(data, issue.path));
    sink.error('extension.invalid', joinPath(base, issue.path), message, hint);
  }
}

/**
 * The `x-dockflow` value of a service or volume mapping as a mapping to validate: null when the
 * key is absent or not a mapping (reported); `x-dockflow: null` is `{}`.
 */
function extensionInput(node: unknown, path: string, sink: DiagnosticSink): Mapping | null {
  if (!isPlainMap(node) || !Object.hasOwn(node, EXTENSION_KEY)) return null;
  const raw = node[EXTENSION_KEY];
  if (raw === null) return {};
  if (isPlainMap(raw)) return raw;
  sink.error('values.invalid-type', path, `expected mapping, got ${typeName(raw)}`, REFERENCE_HINT);
  return null;
}

// ---------------------------------------------------------------------------
// services.<key>.x-dockflow (design-01 8.2, 8.3 X1, X5-X9)
// ---------------------------------------------------------------------------

/**
 * `node` is the interpolated service mapping. Runs after ports.ts, healthcheck.ts and deploy.ts
 * (design-01 1.1): the cross-field rules read the ports, the healthcheck and the mode they filled.
 */
export function extension(draft: ServiceDraft, node: Mapping, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const path = childPath(draft.path, EXTENSION_KEY);
  const input = extensionInput(node, path, ctx.sink);
  if (input === null) return;
  const parsed = ServiceExtensionSchema.safeParse(input);
  if (!parsed.success) {
    reportIssues(parsed.error.issues, path, input, ctx.sink);
    return;
  }
  const x = parsed.data;
  const at = (key: string): string => childPath(path, key);
  const ext: ServiceExtension = {
    kind: x.kind ?? null,
    publish: x.publish ?? null,
    loadBalancerSourceRanges: sortedUnique((x.lb_source_ranges ?? []).map((r) => r.toLowerCase())),
    probes: x.probes === undefined ? null : probeOverride(x.probes),
    nodeSelector: { ...x.node_selector },
    tolerations: (x.tolerations ?? []).map(toleration),
    fsGroup: x.fs_group ?? null,
    podLabels: { ...x.pod_labels },
  };
  draft.extension = ext;

  if (ext.kind !== null) {
    if (draft.mode !== 'replicated') {
      ctx.sink.error(
        'extension.kind-mode',
        at('kind'),
        `x-dockflow.kind ${ext.kind} requires deploy.mode: replicated`,
        'Remove `x-dockflow.kind`, or use `deploy.mode: replicated`.',
      );
    } else if (ext.kind === 'statefulset') {
      draft.workloadKind = 'StatefulSet';
    }
  }

  const ranges = ext.loadBalancerSourceRanges.length > 0;
  if (ranges && (ext.publish === 'hostport' || ext.publish === 'none')) {
    ctx.sink.error(
      'extension.lb-source-ranges-without-lb',
      at('lb_source_ranges'),
      'lb_source_ranges requires publish: loadbalancer',
      'Remove `lb_source_ranges`, or set `publish: loadbalancer`.',
    );
  }
  const publishesIngress = draft.ports.some((p) => p.mode === 'ingress' && p.published !== null);
  if (!publishesIngress) {
    const unused = [...(ext.publish !== null ? ['publish'] : []), ...(ranges ? ['lb_source_ranges'] : [])];
    for (const key of unused) {
      ctx.sink.warn(
        'extension.publish-unused',
        at(key),
        `x-dockflow.${key} has no effect: ${draft.composeName} publishes no port in ingress mode`,
        `Remove \`x-dockflow.${key}\`, or publish a port with \`ports\`.`,
      );
    }
  }

  if (ext.probes !== null) probeRules(draft, ext.probes, at('probes'), ctx);
}

function probeOverride(p: NonNullable<ServiceExtensionInput['probes']>): ProbeOverride {
  const handler: ProbeOverride['handler'] = p.http
    ? { type: 'http', path: p.http.path, port: p.http.port, scheme: p.http.scheme ?? 'HTTP' }
    : p.tcp
      ? { type: 'tcp', port: p.tcp.port }
      : null;
  return { use: p.use ?? 'both', handler };
}

function toleration(t: NonNullable<ServiceExtensionInput['tolerations']>[number]): TolerationSpec {
  return {
    key: t.key ?? null,
    operator: t.operator ?? 'Equal',
    value: t.value ?? null,
    effect: t.effect ?? null,
    tolerationSeconds: t.toleration_seconds ?? null,
  };
}

/** design-01 8.3 X7, X8, X9 and the unused-handler row of design-02 5.6 */
function probeRules(draft: ServiceDraft, probes: ProbeOverride, path: string, ctx: NormalizeContext): void {
  if (probes.handler !== null && draft.healthcheckDisabled) {
    ctx.sink.error(
      'extension.probes-disabled-healthcheck',
      path,
      'x-dockflow.probes defines a check but the healthcheck is disabled',
      'Remove `healthcheck.disable` (or `test: NONE`), or remove `x-dockflow.probes`.',
    );
    return;
  }
  if (probes.handler === null && draft.healthcheck === null) {
    ctx.sink.warn(
      'extension.probes-without-check',
      path,
      'x-dockflow.probes has nothing to configure: the service has no healthcheck and no http or tcp check',
    );
    return;
  }
  if (probes.use === 'none') {
    const message =
      draft.healthcheck !== null
        ? 'the healthcheck is not turned into probes (x-dockflow.probes.use: none)'
        : `the ${probes.handler?.type} check is not used (x-dockflow.probes.use: none)`;
    ctx.sink.info('extension.probes-none', childPath(path, 'use'), message);
  }
}

// ---------------------------------------------------------------------------
// volumes.<key>.x-dockflow (design-01 8.2, 8.3 X4)
// ---------------------------------------------------------------------------

/**
 * Applies `volumes.<key>.x-dockflow` to a volume draft built by volumes.ts; `node` is the
 * top-level volume mapping (null for `data:`). Must run after volumes.ts decided `external`.
 */
export function volumeExtension(volume: VolumeDraft, node: unknown, ctx: NormalizeContext): void {
  const path = childPath(volume.path, EXTENSION_KEY);
  const input = extensionInput(node, path, ctx.sink);
  if (input === null) return;
  const parsed = VolumeExtensionSchema.safeParse(input);
  if (!parsed.success) {
    reportIssues(parsed.error.issues, path, input, ctx.sink);
    return;
  }
  const x = parsed.data;
  const at = (key: string): string => childPath(path, key);
  if (x.access_mode !== undefined) volume.accessMode = x.access_mode;

  if (volume.external) {
    // an external claim keeps its own settings; access_mode still declares its mode for D8
    const ignored = [...(x.size !== undefined ? ['size'] : []), ...(x.storage_class !== undefined ? ['storage_class'] : []), ...(x.per_replica ? ['per_replica'] : [])];
    for (const key of ignored) {
      ctx.sink.error(
        'extension.external-volume',
        at(key),
        `x-dockflow.${key} has no effect on the external volume ${volume.key}`,
        `Remove \`x-dockflow.${key}\`; the existing claim keeps its own settings.`,
      );
    }
    return;
  }

  if (x.storage_class !== undefined) volume.storageClass = x.storage_class;
  if (x.per_replica !== undefined) volume.perReplica = x.per_replica;
  if (x.size !== undefined) {
    volume.size = canonicalQuantity(x.size) ?? x.size;
    if (volume.storageClass === ctx.traits.defaultStorageClass) {
      ctx.sink.info('volumes.size-not-enforced', at('size'), `the size ${x.size} is recorded but not enforced by the storage class ${volume.storageClass}`);
    }
  }
}

/** volumeExtension for every declared volume; `volumes` is the top-level `volumes` mapping. */
export function volumeExtensions(volumes: unknown, table: VolumeTable, ctx: NormalizeContext): void {
  if (!isPlainMap(volumes)) return;
  for (const key of sortedKeys(volumes)) {
    const volume = table.get(key);
    if (volume !== undefined) volumeExtension(volume, volumes[key], ctx);
  }
}

// ---------------------------------------------------------------------------
// Stack-level rule (design-01 8.3 X2)
// ---------------------------------------------------------------------------

/**
 * A `per_replica` volume needs StatefulSet claim templates: every service mounting it must be a
 * StatefulSet. stackChecks runs it once every draft is complete, the only emitter of
 * extension.per-replica-kind; reported at each offending mount.
 */
export function checkPerReplicaVolumes(drafts: readonly ServiceDraft[], volumes: VolumeTable, ctx: NormalizeContext): void {
  for (const draft of drafts) {
    // a fatal service may still hold the default workload kind
    if (ctx.isFatal(draft.path) || draft.workloadKind === 'StatefulSet') continue;
    for (const mount of draft.mounts) {
      if (mount.type !== 'volume' || volumes.get(mount.volume)?.perReplica !== true) continue;
      ctx.sink.error(
        'extension.per-replica-kind',
        mount.path,
        `volume ${mount.volume} has per_replica: true but ${draft.composeName} is not a StatefulSet`,
        `Add \`x-dockflow: {kind: statefulset}\` to \`${draft.composeName}\`.`,
      );
    }
  }
}

