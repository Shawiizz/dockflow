// The x-dockflow schema (DESIGN-CORE 3 tables, 7.3; design-01 8.1): strict at every level, the
// fields of the core tables and nothing else, a `.describe()` text on every field (R-S1-03, read by
// the docs generator), and the zod issue shapes normalize/extension.ts turns into diagnostics.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  ProbeOverrideSchema,
  type ServiceExtensionInput,
  ServiceExtensionSchema,
  TolerationSchema,
  type VolumeExtensionInput,
  VolumeExtensionSchema,
} from '../../../schemas/compose-extension.schema';
import { DOCKFLOW_K8S_PREFIX } from '../../../services/orchestrator/kubernetes/constants';

function issues(schema: z.ZodType, input: unknown): z.core.$ZodIssue[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

function summary(schema: z.ZodType, input: unknown): [string, string][] {
  return issues(schema, input).map((i) => [i.code, i.path.map(String).join('.')]);
}

function unwrap(schema: z.ZodType): z.ZodType {
  let inner = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  return inner;
}

/** `[path, description]` of every field reachable through objects and arrays of objects. */
function fields(schema: z.ZodType, path = ''): [string, string | undefined][] {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodArray) return fields(inner.element as z.ZodType, `${path}[]`);
  if (!(inner instanceof z.ZodObject)) return [];
  const out: [string, string | undefined][] = [];
  for (const [key, field] of Object.entries(inner.shape as Record<string, z.ZodType>)) {
    const fieldPath = path === '' ? key : `${path}.${key}`;
    out.push([fieldPath, field.description], ...fields(field, fieldPath));
  }
  return out;
}

describe('fields (DESIGN-CORE 3 x-dockflow tables)', () => {
  test('the service and volume schemas declare exactly the fields of the core tables', () => {
    expect(Object.keys(ServiceExtensionSchema.shape).sort()).toEqual([
      'fs_group',
      'kind',
      'lb_source_ranges',
      'node_selector',
      'pod_labels',
      'probes',
      'publish',
      'tolerations',
    ]);
    expect(Object.keys(VolumeExtensionSchema.shape).sort()).toEqual(['access_mode', 'per_replica', 'size', 'storage_class']);
    expect(Object.keys(ProbeOverrideSchema.shape).sort()).toEqual(['http', 'tcp', 'use']);
    expect(Object.keys(TolerationSchema.shape).sort()).toEqual(['effect', 'key', 'operator', 'toleration_seconds', 'value']);
  });

  test('every field is optional: an empty extension is valid and changes nothing', () => {
    expect(ServiceExtensionSchema.parse({})).toEqual({});
    expect(VolumeExtensionSchema.parse({})).toEqual({});
    expect(ProbeOverrideSchema.parse({})).toEqual({});
  });

  test('a complete extension parses to the input types', () => {
    const service: ServiceExtensionInput = ServiceExtensionSchema.parse({
      kind: 'statefulset',
      publish: 'hostport',
      lb_source_ranges: ['10.0.0.0/8', '2001:db8::/32'],
      probes: { use: 'readiness', http: { path: '/healthz', port: 8080, scheme: 'HTTPS' } },
      node_selector: { 'topology.kubernetes.io/zone': 'eu-1' },
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoExecute', toleration_seconds: 30 }],
      fs_group: 999,
      pod_labels: { tier: 'db' },
    });
    expect(service.probes?.http?.scheme).toBe('HTTPS');
    const volume: VolumeExtensionInput = VolumeExtensionSchema.parse({
      size: '10Gi',
      storage_class: 'fast-ssd',
      access_mode: 'ReadWriteOncePod',
      per_replica: true,
    });
    expect(volume).toEqual({ size: '10Gi', storage_class: 'fast-ssd', access_mode: 'ReadWriteOncePod', per_replica: true });
  });
});

describe('strictness (D3: nothing is ignored)', () => {
  test('an unknown key is unrecognized_keys at every level', () => {
    expect(summary(ServiceExtensionSchema, { replicas: 2 })).toEqual([['unrecognized_keys', '']]);
    expect(summary(ServiceExtensionSchema, { probes: { exec: ['true'] } })).toEqual([['unrecognized_keys', 'probes']]);
    expect(summary(ServiceExtensionSchema, { probes: { http: { path: '/', port: 80, method: 'HEAD' } } })).toEqual([
      ['unrecognized_keys', 'probes.http'],
    ]);
    expect(summary(ServiceExtensionSchema, { probes: { tcp: { port: 80, host: 'x' } } })).toEqual([['unrecognized_keys', 'probes.tcp']]);
    expect(summary(ServiceExtensionSchema, { tolerations: [{ key: 'a', seconds: 1 }] })).toEqual([['unrecognized_keys', 'tolerations.0']]);
    expect(summary(VolumeExtensionSchema, { driver: 'local' })).toEqual([['unrecognized_keys', '']]);
    const [unknown] = issues(ServiceExtensionSchema, { replicas: 2, 'x-note': 'n' });
    expect(unknown.code === 'unrecognized_keys' && unknown.keys).toEqual(['replicas', 'x-note']);
  });

  test('values keep their types: no coercion of strings, numbers or booleans', () => {
    expect(summary(ServiceExtensionSchema, { fs_group: '999' })).toEqual([['invalid_type', 'fs_group']]);
    expect(summary(ServiceExtensionSchema, { fs_group: 1.5 })).toEqual([['invalid_type', 'fs_group']]);
    expect(summary(ServiceExtensionSchema, { node_selector: { ssd: true } })).toEqual([['invalid_type', 'node_selector.ssd']]);
    expect(summary(VolumeExtensionSchema, { per_replica: 'true' })).toEqual([['invalid_type', 'per_replica']]);
    expect(summary(VolumeExtensionSchema, { size: 10 })).toEqual([['invalid_type', 'size']]);
  });
});

describe('.describe() texts (R-S1-03)', () => {
  test('both schemas are described', () => {
    expect(ServiceExtensionSchema.description).toBe('Kubernetes settings of a service (`services.<name>.x-dockflow`).');
    expect(VolumeExtensionSchema.description).toBe('Kubernetes settings of a top-level volume (`volumes.<name>.x-dockflow`).');
  });

  test('every field at every level has a description written as a sentence', () => {
    const all = [...fields(ServiceExtensionSchema), ...fields(VolumeExtensionSchema, 'volume')];
    expect(all.map(([path]) => path)).toEqual([
      'kind',
      'publish',
      'lb_source_ranges',
      'probes',
      'probes.use',
      'probes.http',
      'probes.http.path',
      'probes.http.port',
      'probes.http.scheme',
      'probes.tcp',
      'probes.tcp.port',
      'node_selector',
      'tolerations',
      'tolerations[].key',
      'tolerations[].operator',
      'tolerations[].value',
      'tolerations[].effect',
      'tolerations[].toleration_seconds',
      'fs_group',
      'pod_labels',
      'volume.size',
      'volume.storage_class',
      'volume.access_mode',
      'volume.per_replica',
    ]);
    const undescribed = all.filter(([, text]) => text === undefined || text.trim() === '').map(([path]) => path);
    expect(undescribed).toEqual([]);
    for (const [path, text] of all) {
      expect({ path, sentence: /^[A-Z`].*\.$/.test(text ?? '') }).toEqual({ path, sentence: true });
    }
  });

  test('the texts name the defaults of the core tables', () => {
    const text = new Map(fields(ServiceExtensionSchema));
    const volume = new Map(fields(VolumeExtensionSchema));
    expect(text.get('kind')).toContain('`deployment` (the default)');
    expect(text.get('publish')).toContain('`loadbalancer` (the default');
    expect(text.get('probes.use')).toContain('`both` (the default)');
    expect(text.get('probes.http.scheme')).toContain('`HTTP` (the default)');
    expect(text.get('pod_labels')).toContain(`${DOCKFLOW_K8S_PREFIX}/`);
    expect(volume.get('size')).toContain('default `1Gi`');
    expect(volume.get('access_mode')).toContain('`ReadWriteOnce` (the default)');
  });
});

describe('issue shapes normalize/extension.ts relies on (design-01 8.1, zod 4.3.6)', () => {
  test('enum: invalid_value with the accepted values', () => {
    const [issue] = issues(ServiceExtensionSchema, { publish: 'public' });
    expect(issue.code).toBe('invalid_value');
    expect(issue.code === 'invalid_value' && issue.values).toEqual(['loadbalancer', 'hostport', 'none']);
    expect(summary(VolumeExtensionSchema, { access_mode: 'ReadOnlyMany' })).toEqual([['invalid_value', 'access_mode']]);
  });

  test('CIDR list items: invalid_union at the item', () => {
    expect(summary(ServiceExtensionSchema, { lb_source_ranges: ['10.0.0.0/8', '10.0.0.1', '2001:db8::/129'] })).toEqual([
      ['invalid_union', 'lb_source_ranges.1'],
      ['invalid_union', 'lb_source_ranges.2'],
    ]);
    expect(summary(ServiceExtensionSchema, { lb_source_ranges: ['0.0.0.0/0', '::/0', '2001:DB8::/32'] })).toEqual([]);
  });

  test('record keys: invalid_key at the key, the reason in the inner issues', () => {
    const [issue] = issues(ServiceExtensionSchema, { pod_labels: { 'app.kubernetes.io/name': 'x' } });
    expect(issue.code).toBe('invalid_key');
    expect(issue.path).toEqual(['pod_labels', 'app.kubernetes.io/name']);
    expect(issue.code === 'invalid_key' && issue.issues.map((i) => i.message)).toEqual([
      `must not use the reserved prefixes ${DOCKFLOW_K8S_PREFIX}/ and app.kubernetes.io/`,
    ]);
  });

  test('refinements: custom issues at the offending field', () => {
    expect(issues(ServiceExtensionSchema, { probes: { http: { path: '/', port: 80 }, tcp: { port: 80 } } })).toEqual([
      { code: 'custom', path: ['probes', 'tcp'], message: 'set http or tcp, not both' },
    ]);
    expect(issues(TolerationSchema, { operator: 'Exists', value: 'x' })).toEqual([
      { code: 'custom', path: ['value'], message: 'must not be set when operator is Exists' },
    ]);
    expect(issues(TolerationSchema, { effect: 'NoSchedule' })).toEqual([
      { code: 'custom', path: ['operator'], message: 'must be Exists when key is not set' },
    ]);
    expect(issues(TolerationSchema, { key: 'a', toleration_seconds: 5 })).toEqual([
      { code: 'custom', path: ['toleration_seconds'], message: 'requires effect: NoExecute' },
    ]);
    expect(issues(TolerationSchema, { key: 'a', effect: 'NoExecute', toleration_seconds: 0 })).toEqual([]);
    expect(issues(TolerationSchema, { operator: 'Exists' })).toEqual([]);
  });
});

describe('Kubernetes name rules', () => {
  const key = (k: string) => summary(ServiceExtensionSchema, { node_selector: { [k]: 'x' } });
  const value = (v: string) => summary(ServiceExtensionSchema, { node_selector: { zone: v } });

  test('label keys: optional DNS prefix of at most 253 characters, name of at most 63', () => {
    for (const ok of ['zone', 'Zone_1.a-b', 'example.com/zone', 'a'.repeat(63), `${'a'.repeat(253)}/${'b'.repeat(63)}`]) {
      expect({ ok, issues: key(ok) }).toEqual({ ok, issues: [] });
    }
    for (const bad of ['bad key', '-zone', 'zone-', 'a'.repeat(64), 'Example.com/zone', '/zone', `${'a'.repeat(254)}/zone`, '']) {
      expect({ bad, invalid: key(bad).length > 0 }).toEqual({ bad, invalid: true });
    }
  });

  test('label values: at most 63 characters, alphanumeric at both ends, empty allowed', () => {
    for (const ok of ['', 'eu-1', 'A.b_c', 'a'.repeat(63)]) expect({ ok, issues: value(ok) }).toEqual({ ok, issues: [] });
    for (const bad of ['a'.repeat(64), '-eu', 'eu-', 'fast ssd', 'a/b']) expect({ bad, invalid: value(bad).length > 0 }).toEqual({ bad, invalid: true });
  });

  test('pod_labels refuse both reserved prefixes, node_selector does not', () => {
    for (const reserved of [`${DOCKFLOW_K8S_PREFIX}/role`, 'app.kubernetes.io/name']) {
      expect(summary(ServiceExtensionSchema, { pod_labels: { [reserved]: 'x' } })).toEqual([['invalid_key', `pod_labels.${reserved}`]]);
      expect(summary(ServiceExtensionSchema, { node_selector: { [reserved]: 'x' } })).toEqual([]);
    }
    expect(summary(ServiceExtensionSchema, { pod_labels: { 'kubernetes.io/app': 'x' } })).toEqual([]);
  });

  test('probe paths start with a slash and hold no spaces; ports are 1-65535', () => {
    const probe = (http: Record<string, unknown>) => summary(ServiceExtensionSchema, { probes: { http } });
    expect(probe({ path: '/healthz?full=1', port: 1 })).toEqual([]);
    expect(probe({ path: '/', port: 65_535 })).toEqual([]);
    expect(probe({ path: 'healthz', port: 80 })).toEqual([['invalid_format', 'probes.http.path']]);
    expect(probe({ path: '/health z', port: 80 })).toEqual([['invalid_format', 'probes.http.path']]);
    expect(probe({ path: '/', port: 0 })).toEqual([['too_small', 'probes.http.port']]);
    expect(probe({ path: '/', port: 65_536 })).toEqual([['too_big', 'probes.http.port']]);
  });

  test('fs_group is an int32 of at least 0', () => {
    expect(summary(ServiceExtensionSchema, { fs_group: 0 })).toEqual([]);
    expect(summary(ServiceExtensionSchema, { fs_group: 2_147_483_647 })).toEqual([]);
    expect(summary(ServiceExtensionSchema, { fs_group: -1 })).toEqual([['too_small', 'fs_group']]);
    expect(summary(ServiceExtensionSchema, { fs_group: 2_147_483_648 })).toEqual([['too_big', 'fs_group']]);
  });

  test('volume size is a whole Ki/Mi/Gi/Ti quantity; storage_class a DNS subdomain', () => {
    for (const ok of ['1Ki', '512Mi', '10Gi', '2Ti']) expect(summary(VolumeExtensionSchema, { size: ok })).toEqual([]);
    for (const bad of ['0Gi', '10G', '10GB', '1Ei', '1.5Gi', '010Gi', '10gi', '']) {
      expect({ bad, issues: summary(VolumeExtensionSchema, { size: bad }) }).toEqual({ bad, issues: [['invalid_format', 'size']] });
    }
    for (const ok of ['fast-ssd', 'dockflow-local', 'storage.example.com']) expect(summary(VolumeExtensionSchema, { storage_class: ok })).toEqual([]);
    for (const bad of ['Fast', 'fast_ssd', '-fast', 'fast-']) {
      expect({ bad, issues: summary(VolumeExtensionSchema, { storage_class: bad }) }).toEqual({ bad, issues: [['invalid_format', 'storage_class']] });
    }
    expect(summary(VolumeExtensionSchema, { storage_class: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}` })).toEqual([
      ['too_big', 'storage_class'],
    ]);
  });
});
