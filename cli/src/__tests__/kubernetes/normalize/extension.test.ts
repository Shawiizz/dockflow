// design-01 8: XD-* as direct tests of the x-dockflow handlers. The service handler runs after
// deploy.ts, as in the pipeline, so the mode is the one deploy.* set; ports, mounts and the
// healthcheck come from other handlers and are written on the draft here. X3 and X10 are translator
// checks (design-01 1.6) and X11 (misplaced x-dockflow) belongs to the key walker.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import { DOCKFLOW_K8S_PREFIX, K8S_STORAGE_CLASS } from '../../../services/orchestrator/kubernetes/constants';
import type { HealthSpec, PortSpec, VolumeMountSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { newVolumeDraft, type ServiceDraft, type VolumeDraft } from '../../../services/orchestrator/kubernetes/normalize/context';
import { deploy } from '../../../services/orchestrator/kubernetes/normalize/deploy';
import {
  checkPerReplicaVolumes,
  EXTENSION_KEY,
  extension,
  volumeExtension,
  volumeExtensions,
} from '../../../services/orchestrator/kubernetes/normalize/extension';
import { normalizeContext, type NormalizeInputOverrides, serviceDraft } from '../support/builders';

type Row = [Diagnostic['severity'], string, string];

const HINT = 'See the `x-dockflow` reference on the Kubernetes page of the documentation.';

const DEFAULT_EXTENSION = {
  kind: null,
  publish: null,
  loadBalancerSourceRanges: [],
  probes: null,
  nodeSelector: {},
  tolerations: [],
  fsGroup: null,
  podLabels: {},
};

function port(overrides: Partial<PortSpec> = {}): PortSpec {
  return {
    target: 80,
    published: 8080,
    protocol: 'TCP',
    mode: 'ingress',
    hostIp: null,
    name: null,
    appProtocol: null,
    path: 'services.web.ports[0]',
    ...overrides,
  };
}

const HEALTHCHECK: HealthSpec = {
  test: { type: 'exec', argv: ['curl', '-f', 'http://localhost/'] },
  intervalMs: 30_000,
  timeoutMs: 30_000,
  retries: 3,
  startPeriodMs: 0,
  startIntervalMs: 5_000,
  path: 'services.web.healthcheck',
};

function volumeMount(volume: string, service = 'web'): VolumeMountSpec {
  return { type: 'volume', volume, target: '/data', readOnly: false, subpath: null, path: `services.${service}.volumes[0]` };
}

interface RunOptions {
  overrides?: NormalizeInputOverrides;
  /** what the handlers that run before extension.ts would have written */
  prepare?: (draft: ServiceDraft) => void;
}

/** `x-dockflow` of service `web` (any value, `undefined` = key absent), or a whole service body. */
function run(body: Record<string, unknown> | string, options: RunOptions = {}) {
  const ctx = normalizeContext({ ...options.overrides, compose: body });
  const draft = serviceDraft('web', ctx);
  const node = ctx.input.compose.services.web;
  deploy(draft, node, ctx);
  options.prepare?.(draft);
  extension(draft, node, ctx);
  const diagnostics = ctx.sink.list();
  const rows: Row[] = diagnostics.map((d) => [d.severity, d.code, d.path]);
  return { draft, ctx, diagnostics, rows, codes: diagnostics.map((d) => d.code) };
}

/** Service `web` with `x-dockflow: ext` and a published port, so X6 stays quiet. */
function ext(value: unknown, options: RunOptions = {}) {
  return run(
    { image: 'nginx:1.27', 'x-dockflow': value },
    {
      ...options,
      prepare: (draft) => {
        draft.ports = [port()];
        options.prepare?.(draft);
      },
    },
  );
}

function only(result: { diagnostics: Diagnostic[] }): Diagnostic {
  expect(result.diagnostics).toHaveLength(1);
  return result.diagnostics[0];
}

describe('services.<key>.x-dockflow fields (XD-01..08)', () => {
  test('XD-01 kind statefulset makes a replicated service a StatefulSet; deployment is the default stated', () => {
    const sts = ext({ kind: 'statefulset' });
    expect(sts.diagnostics).toEqual([]);
    expect(sts.draft.extension.kind).toBe('statefulset');
    expect(sts.draft.workloadKind).toBe('StatefulSet');
    expect(sts.draft.mode).toBe('replicated');

    const deployment = ext({ kind: 'deployment' });
    expect(deployment.diagnostics).toEqual([]);
    expect(deployment.draft.extension.kind).toBe('deployment');
    expect(deployment.draft.workloadKind).toBe('Deployment');

    expect(only(ext({ kind: 'job' }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.kind',
      message: 'expected one of deployment, statefulset',
      hint: HINT,
    });
  });

  test('XD-02 publish is stored; without an ingress-mode published port it has no effect', () => {
    const hostport = ext({ publish: 'hostport' });
    expect(hostport.diagnostics).toEqual([]);
    expect(hostport.draft.extension.publish).toBe('hostport');
    expect(ext({ publish: 'loadbalancer' }).draft.extension.publish).toBe('loadbalancer');

    const unused = run({ image: 'nginx:1.27', 'x-dockflow': { publish: 'none' } });
    expect(unused.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'extension.publish-unused',
        path: 'services.web.x-dockflow.publish',
        message: 'x-dockflow.publish has no effect: web publishes no port in ingress mode',
        hint: 'Remove `x-dockflow.publish`, or publish a port with `ports`.',
      },
    ]);
    expect(unused.draft.extension.publish).toBe('none');

    // node-bound and container-only ports are not ingress-mode published ports
    for (const p of [port({ mode: 'host' }), port({ published: null })]) {
      const r = run({ image: 'nginx:1.27', 'x-dockflow': { publish: 'loadbalancer' } }, { prepare: (d) => (d.ports = [p]) });
      expect(r.rows).toEqual([['warning', 'extension.publish-unused', 'services.web.x-dockflow.publish']]);
    }
  });

  test('XD-03 lb_source_ranges: sorted unique with IPv6 lower-cased; not a CIDR; without a load balancer', () => {
    const ranges = ext({ lb_source_ranges: ['10.0.0.0/8', '2001:DB8::/32', '10.0.0.0/8'] });
    expect(ranges.diagnostics).toEqual([]);
    expect(ranges.draft.extension.loadBalancerSourceRanges).toEqual(['10.0.0.0/8', '2001:db8::/32']);

    expect(only(ext({ lb_source_ranges: ['10.0.0.1'] }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.lb_source_ranges[0]',
      message: '10.0.0.1 is not a CIDR range such as 10.0.0.0/8',
      hint: HINT,
    });

    for (const publish of ['none', 'hostport']) {
      expect(only(ext({ publish, lb_source_ranges: ['10.0.0.0/8'] }))).toEqual({
        severity: 'error',
        code: 'extension.lb-source-ranges-without-lb',
        path: 'services.web.x-dockflow.lb_source_ranges',
        message: 'lb_source_ranges requires publish: loadbalancer',
        hint: 'Remove `lb_source_ranges`, or set `publish: loadbalancer`.',
      });
    }
    expect(ext({ publish: 'loadbalancer', lb_source_ranges: ['10.0.0.0/8'] }).diagnostics).toEqual([]);
    expect(ext({ lb_source_ranges: [] }).diagnostics).toEqual([]);

    const noPort = run({ image: 'nginx:1.27', 'x-dockflow': { lb_source_ranges: ['10.0.0.0/8'] } });
    expect(noPort.rows).toEqual([['warning', 'extension.publish-unused', 'services.web.x-dockflow.lb_source_ranges']]);
    expect(noPort.diagnostics[0].message).toBe('x-dockflow.lb_source_ranges has no effect: web publishes no port in ingress mode');
  });

  test('XD-04 probes: handler, disabled healthcheck (X7), nothing to configure (X8), use none (X9), http and tcp together', () => {
    const http = ext({ probes: { http: { path: '/healthz', port: 8080 } } });
    expect(http.diagnostics).toEqual([]);
    expect(http.draft.extension.probes).toEqual({ use: 'both', handler: { type: 'http', path: '/healthz', port: 8080, scheme: 'HTTP' } });

    const tcp = ext({ probes: { use: 'liveness', tcp: { port: 5432 } } });
    expect(tcp.diagnostics).toEqual([]);
    expect(tcp.draft.extension.probes).toEqual({ use: 'liveness', handler: { type: 'tcp', port: 5432 } });
    expect(ext({ probes: { http: { path: '/', port: 443, scheme: 'HTTPS' } } }).draft.extension.probes?.handler).toEqual({
      type: 'http',
      path: '/',
      port: 443,
      scheme: 'HTTPS',
    });

    const disabled = ext({ probes: { http: { path: '/healthz', port: 8080 } } }, { prepare: (d) => (d.healthcheckDisabled = true) });
    expect(only(disabled)).toEqual({
      severity: 'error',
      code: 'extension.probes-disabled-healthcheck',
      path: 'services.web.x-dockflow.probes',
      message: 'x-dockflow.probes defines a check but the healthcheck is disabled',
      hint: 'Remove `healthcheck.disable` (or `test: NONE`), or remove `x-dockflow.probes`.',
    });

    expect(only(ext({ probes: { use: 'readiness' } }))).toEqual({
      severity: 'warning',
      code: 'extension.probes-without-check',
      path: 'services.web.x-dockflow.probes',
      message: 'x-dockflow.probes has nothing to configure: the service has no healthcheck and no http or tcp check',
    });
    expect(ext({ probes: { use: 'readiness' } }, { prepare: (d) => (d.healthcheck = HEALTHCHECK) }).diagnostics).toEqual([]);

    const none = ext({ probes: { use: 'none' } }, { prepare: (d) => (d.healthcheck = HEALTHCHECK) });
    expect(only(none)).toEqual({
      severity: 'info',
      code: 'extension.probes-none',
      path: 'services.web.x-dockflow.probes.use',
      message: 'the healthcheck is not turned into probes (x-dockflow.probes.use: none)',
    });
    expect(none.draft.extension.probes).toEqual({ use: 'none', handler: null });
    // design-02 5.6: a handler without a healthcheck and use none is unused
    expect(only(ext({ probes: { use: 'none', tcp: { port: 5432 } } }))).toMatchObject({
      severity: 'info',
      code: 'extension.probes-none',
      message: 'the tcp check is not used (x-dockflow.probes.use: none)',
    });

    const both = ext({ probes: { http: { path: '/healthz', port: 8080 }, tcp: { port: 1 } } });
    expect(only(both)).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.probes.tcp',
      message: 'set http or tcp, not both',
      hint: HINT,
    });
    expect(both.draft.extension.probes).toBeNull();
  });

  test('XD-04 probe fields are validated', () => {
    expect(ext({ probes: { http: { port: 8080 } } }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'extension.invalid',
        path: 'services.web.x-dockflow.probes.http.path',
        message: 'is required: expected string',
        hint: HINT,
      },
    ]);
    expect(only(ext({ probes: { http: { path: 'healthz', port: 8080 } } })).message).toBe('must start with "/" and contain no spaces');
    expect(only(ext({ probes: { tcp: { port: 0 } } }))).toMatchObject({ path: 'services.web.x-dockflow.probes.tcp.port', message: 'must be at least 1' });
    expect(only(ext({ probes: { tcp: { port: 65_536 } } })).message).toBe('must be at most 65535');
    expect(only(ext({ probes: { use: 'startup' } })).message).toBe('expected one of both, readiness, liveness, none');
    expect(only(ext({ probes: { http: { path: '/', port: 80, scheme: 'http' } } })).path).toBe('services.web.x-dockflow.probes.http.scheme');
  });

  test('XD-05 node_selector: label keys and values', () => {
    const r = ext({ node_selector: { disktype: 'ssd', 'topology.kubernetes.io/zone': 'eu-1' } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension.nodeSelector).toEqual({ disktype: 'ssd', 'topology.kubernetes.io/zone': 'eu-1' });

    expect(only(ext({ node_selector: { 'bad key': 'x' } }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.node_selector["bad key"]',
      message: 'key bad key must be a Kubernetes label key: an optional DNS prefix and "/", then at most 63 letters, digits, "-", "_" or "."',
      hint: HINT,
    });
    expect(only(ext({ node_selector: { disktype: 'fast ssd' } }))).toMatchObject({
      path: 'services.web.x-dockflow.node_selector.disktype',
      message: 'must be a Kubernetes label value: at most 63 letters, digits, "-", "_" or ".", starting and ending with a letter or digit',
    });
    const prefix = `${'a'.repeat(254)}/zone`;
    expect(only(ext({ node_selector: { [prefix]: 'x' } })).message).toBe(`key ${prefix} the prefix must be at most 253 characters`);
  });

  test('XD-05 node_selector values keep their source text through the loader (K71)', () => {
    const r = run(
      `
      image: nginx:1.27
      ports: ["8080:80"]
      x-dockflow:
        node_selector:
          ssd: true
          rack: 010
      `,
      { prepare: (d) => (d.ports = [port()]) },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension.nodeSelector).toEqual({ ssd: 'true', rack: '010' });
  });

  test('XD-06 tolerations: defaults filled in declaration order; the three refinements', () => {
    const r = ext({
      tolerations: [
        { key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoSchedule' },
        { operator: 'Exists' },
        { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', toleration_seconds: 30 },
        { key: 'gpu' },
      ],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension.tolerations).toEqual([
      { key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoSchedule', tolerationSeconds: null },
      { key: null, operator: 'Exists', value: null, effect: null, tolerationSeconds: null },
      { key: 'node.kubernetes.io/unreachable', operator: 'Exists', value: null, effect: 'NoExecute', tolerationSeconds: 30 },
      { key: 'gpu', operator: 'Equal', value: null, effect: null, tolerationSeconds: null },
    ]);

    expect(only(ext({ tolerations: [{ operator: 'Exists', value: 'x' }] }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.tolerations[0].value',
      message: 'must not be set when operator is Exists',
      hint: HINT,
    });
    expect(only(ext({ tolerations: [{ key: 'a', toleration_seconds: 30 }] }))).toMatchObject({
      path: 'services.web.x-dockflow.tolerations[0].toleration_seconds',
      message: 'requires effect: NoExecute',
    });
    expect(only(ext({ tolerations: [{ effect: 'NoSchedule' }] }))).toMatchObject({
      path: 'services.web.x-dockflow.tolerations[0].operator',
      message: 'must be Exists when key is not set',
    });
    expect(only(ext({ tolerations: [{ key: 'a', effect: 'NoRun' }] })).path).toBe('services.web.x-dockflow.tolerations[0].effect');
    expect(only(ext({ tolerations: { key: 'a' } }))).toMatchObject({
      path: 'services.web.x-dockflow.tolerations',
      message: 'expected list, got mapping',
    });
  });

  test('XD-07 fs_group: integer; a quoted number gets its own hint', () => {
    const r = ext({ fs_group: 999 });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension.fsGroup).toBe(999);
    expect(ext({ fs_group: 0 }).draft.extension.fsGroup).toBe(0);

    expect(only(ext({ fs_group: '999' }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.fs_group',
      message: 'expected number, got string',
      hint: 'Write the number without quotes.',
    });
    expect(only(ext({ fs_group: 'staff' }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.fs_group',
      message: 'expected number, got string',
      hint: HINT,
    });
    expect(only(ext({ fs_group: -1 })).message).toBe('must be at least 0');
    expect(only(ext({ fs_group: 2_147_483_648 })).message).toBe('must be at most 2147483647');
    expect(only(ext({ fs_group: 1.5 })).message).toBe('expected integer, got number');
  });

  test('XD-08 pod_labels: label keys and values, reserved prefixes refused', () => {
    const r = ext({ pod_labels: { tier: 'db', 'example.com/team': 'shop' } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension.podLabels).toEqual({ tier: 'db', 'example.com/team': 'shop' });

    const reserved = `must not use the reserved prefixes ${DOCKFLOW_K8S_PREFIX}/ and app.kubernetes.io/`;
    expect(only(ext({ pod_labels: { 'app.kubernetes.io/name': 'x' } }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.pod_labels["app.kubernetes.io/name"]',
      message: `key app.kubernetes.io/name ${reserved}`,
      hint: HINT,
    });
    expect(only(ext({ pod_labels: { [`${DOCKFLOW_K8S_PREFIX}/role`]: 'app' } })).message).toBe(`key ${DOCKFLOW_K8S_PREFIX}/role ${reserved}`);

    // design-07 B-04: 63 characters accepted, 64 refused
    expect(ext({ pod_labels: { tier: 'a'.repeat(63) } }).diagnostics).toEqual([]);
    expect(only(ext({ pod_labels: { tier: 'a'.repeat(64) } }))).toMatchObject({
      path: 'services.web.x-dockflow.pod_labels.tier',
      message: 'must be at most 63',
    });
  });
});

describe('services.<key>.x-dockflow shape (XD-12..17)', () => {
  test('XD-12 kind requires deploy.mode replicated (X1)', () => {
    const global = run({ image: 'x:1', deploy: { mode: 'global' }, 'x-dockflow': { kind: 'statefulset' } });
    expect(global.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'extension.kind-mode',
        path: 'services.web.x-dockflow.kind',
        message: 'x-dockflow.kind statefulset requires deploy.mode: replicated',
        hint: 'Remove `x-dockflow.kind`, or use `deploy.mode: replicated`.',
      },
    ]);
    expect(global.draft.workloadKind).toBe('DaemonSet');

    const job = run({ image: 'x:1', deploy: { mode: 'replicated-job' }, 'x-dockflow': { kind: 'deployment' } });
    expect(job.rows).toEqual([['error', 'extension.kind-mode', 'services.web.x-dockflow.kind']]);
    expect(job.diagnostics[0].message).toBe('x-dockflow.kind deployment requires deploy.mode: replicated');
    expect(job.draft.workloadKind).toBe('Job');
  });

  test('XD-13 an unknown key is refused at its own path, at every level', () => {
    expect(only(ext({ replicas: 2 }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.replicas',
      message: 'is not an x-dockflow key',
      hint: HINT,
    });
    const nested = ext({ probes: { http: { path: '/', port: 80, method: 'HEAD' } }, tolerations: [{ key: 'a', seconds: 3 }] });
    expect(nested.rows).toEqual([
      ['error', 'extension.invalid', 'services.web.x-dockflow.probes.http.method'],
      ['error', 'extension.invalid', 'services.web.x-dockflow.tolerations[0].seconds'],
    ]);
    expect(ext({ 'x-note': 'why', 'Kind': 'statefulset' }).rows).toEqual([
      ['error', 'extension.invalid', 'services.web.x-dockflow.Kind'],
      ['error', 'extension.invalid', 'services.web.x-dockflow.x-note'],
    ]);
  });

  test('XD-14 an enum value names the accepted values (DESIGN-CORE 7.3 wording)', () => {
    expect(only(ext({ publish: 'public' }))).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'services.web.x-dockflow.publish',
      message: 'expected one of loadbalancer, hostport, none',
      hint: HINT,
    });
  });

  test('XD-15 x-dockflow: null or {} keeps the defaults without a diagnostic', () => {
    for (const value of [null, {}]) {
      const r = ext(value);
      expect(r.diagnostics).toEqual([]);
      expect(r.draft.extension).toEqual(DEFAULT_EXTENSION);
      expect(r.draft.workloadKind).toBe('Deployment');
    }
    const absent = run('image: nginx:1.27');
    expect(absent.diagnostics).toEqual([]);
    expect(absent.draft.extension).toEqual(DEFAULT_EXTENSION);
  });

  test('XD-16 x-dockflow that is not a mapping is values.invalid-type', () => {
    expect(only(ext(['a']))).toEqual({
      severity: 'error',
      code: 'values.invalid-type',
      path: 'services.web.x-dockflow',
      message: 'expected mapping, got list',
      hint: HINT,
    });
    expect(only(ext('statefulset')).message).toBe('expected mapping, got string');
  });

  test('XD-17 only services.<key>.x-dockflow is read; a misplaced one is left to the key walker', () => {
    const r = run({ image: 'x:1', deploy: { 'x-dockflow': { kind: 'statefulset' } }, healthcheck: { 'x-dockflow': {} } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.extension).toEqual(DEFAULT_EXTENSION);
    expect(r.draft.workloadKind).toBe('Deployment');
  });

  test('an invalid extension is applied as a whole or not at all', () => {
    const r = ext({ kind: 'statefulset', publish: 'public', fs_group: 1000 });
    expect(r.codes).toEqual(['extension.invalid']);
    expect(r.draft.extension).toEqual(DEFAULT_EXTENSION);
    expect(r.draft.workloadKind).toBe('Deployment');

    // every issue is reported in one pass
    const many = ext({ kind: 'job', publish: 'public', fs_group: '1', extra: true });
    expect(many.rows).toEqual([
      ['error', 'extension.invalid', 'services.web.x-dockflow.extra'],
      ['error', 'extension.invalid', 'services.web.x-dockflow.fs_group'],
      ['error', 'extension.invalid', 'services.web.x-dockflow.kind'],
      ['error', 'extension.invalid', 'services.web.x-dockflow.publish'],
    ]);
  });
});

describe('volumes.<key>.x-dockflow (XD-09..11)', () => {
  function volume(value: unknown, options: { external?: boolean; overrides?: NormalizeInputOverrides } = {}) {
    const ctx = normalizeContext({
      ...options.overrides,
      compose: { services: { web: { image: 'x:1' } }, volumes: { data: { 'x-dockflow': value } } },
    });
    const draft = newVolumeDraft('data', ctx);
    draft.external = options.external ?? false;
    volumeExtension(draft, ctx.input.compose.volumes?.data, ctx);
    const diagnostics = ctx.sink.list();
    return { draft, diagnostics, rows: diagnostics.map((d): Row => [d.severity, d.code, d.path]) };
  }

  test('XD-09 size and storage_class; the size is only recorded by the default class', () => {
    const r = volume({ size: '10Gi', storage_class: 'fast-ssd' });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft).toMatchObject({ size: '10Gi', storageClass: 'fast-ssd', accessMode: 'ReadWriteOnce', perReplica: false });

    const recorded = volume({ size: '10Gi' });
    expect(recorded.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'volumes.size-not-enforced',
        path: 'volumes.data.x-dockflow.size',
        message: `the size 10Gi is recorded but not enforced by the storage class ${K8S_STORAGE_CLASS}`,
      },
    ]);
    expect(recorded.draft.storageClass).toBe(K8S_STORAGE_CLASS);

    // R-S1-04: the quantity is kept in canonical form
    expect(volume({ size: '1024Mi', storage_class: 'fast-ssd' }).draft.size).toBe('1Gi');
    expect(volume({ size: '1Ki', storage_class: 'fast-ssd' }).diagnostics).toEqual([]);

    for (const size of ['10G', '0Gi', '1Ei', '1.5Gi', 10]) {
      const bad = volume({ size });
      expect(bad.rows).toEqual([['error', 'extension.invalid', 'volumes.data.x-dockflow.size']]);
      expect(bad.draft.size).toBe('1Gi');
    }
    expect(volume({ size: '10G' }).diagnostics[0]).toEqual({
      severity: 'error',
      code: 'extension.invalid',
      path: 'volumes.data.x-dockflow.size',
      message: 'must be a whole number followed by Ki, Mi, Gi or Ti, for example 10Gi',
      hint: HINT,
    });
    expect(volume({ storage_class: 'Fast_SSD' }).diagnostics[0]).toMatchObject({
      path: 'volumes.data.x-dockflow.storage_class',
      message: 'must be a lowercase DNS name',
    });
  });

  test('XD-10 external volumes: size, storage_class and per_replica refused (X4), access_mode declared', () => {
    const r = volume({ size: '5Gi', storage_class: 'fast-ssd', per_replica: true }, { external: true });
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'extension.external-volume',
        path: 'volumes.data.x-dockflow.per_replica',
        message: 'x-dockflow.per_replica has no effect on the external volume data',
        hint: 'Remove `x-dockflow.per_replica`; the existing claim keeps its own settings.',
      },
      {
        severity: 'error',
        code: 'extension.external-volume',
        path: 'volumes.data.x-dockflow.size',
        message: 'x-dockflow.size has no effect on the external volume data',
        hint: 'Remove `x-dockflow.size`; the existing claim keeps its own settings.',
      },
      {
        severity: 'error',
        code: 'extension.external-volume',
        path: 'volumes.data.x-dockflow.storage_class',
        message: 'x-dockflow.storage_class has no effect on the external volume data',
        hint: 'Remove `x-dockflow.storage_class`; the existing claim keeps its own settings.',
      },
    ]);
    expect(r.draft).toMatchObject({ size: '1Gi', storageClass: K8S_STORAGE_CLASS, perReplica: false });

    const rwx = volume({ access_mode: 'ReadWriteMany' }, { external: true });
    expect(rwx.diagnostics).toEqual([]);
    expect(rwx.draft.accessMode).toBe('ReadWriteMany');
    expect(volume({ per_replica: false }, { external: true }).diagnostics).toEqual([]);

    // X10 (the default class cannot serve RWX) is decided by the translator on the model
    const local = volume({ access_mode: 'ReadWriteMany' });
    expect(local.diagnostics).toEqual([]);
    expect(local.draft).toMatchObject({ accessMode: 'ReadWriteMany', storageClass: K8S_STORAGE_CLASS });
    expect(volume({ access_mode: 'ReadWriteOncePod' }).draft.accessMode).toBe('ReadWriteOncePod');
    expect(volume({ access_mode: 'ReadOnlyMany' }).diagnostics[0]).toMatchObject({
      code: 'extension.invalid',
      message: 'expected one of ReadWriteOnce, ReadWriteOncePod, ReadWriteMany',
    });
  });

  test('XD-11 per_replica needs every service mounting the volume to be a StatefulSet (X2)', () => {
    const ctx = normalizeContext({ compose: { services: { web: { image: 'x:1' }, db: { image: 'postgres:16' }, cache: { image: 'redis:7' } } } });
    const table = new Map<string, VolumeDraft>([
      ['data', { ...newVolumeDraft('data', ctx), perReplica: true }],
      ['logs', newVolumeDraft('logs', ctx)],
    ]);
    const web = serviceDraft('web', ctx);
    web.mounts = [volumeMount('data', 'web'), volumeMount('logs', 'web')];
    const db = serviceDraft('db', ctx);
    db.workloadKind = 'StatefulSet';
    db.mounts = [volumeMount('data', 'db')];
    const cache = serviceDraft('cache', ctx);
    cache.workloadKind = 'StatefulSet';
    cache.mounts = [volumeMount('data', 'cache')];

    checkPerReplicaVolumes([web, db, cache], table, ctx);
    // two StatefulSets on one per-replica volume is the translator's volumes.per-replica-shared (X3)
    expect(ctx.sink.list()).toEqual([
      {
        severity: 'error',
        code: 'extension.per-replica-kind',
        path: 'services.web.volumes[0]',
        message: 'volume data has per_replica: true but web is not a StatefulSet',
        hint: 'Add `x-dockflow: {kind: statefulset}` to `web`.',
      },
    ]);

    const fatal = normalizeContext();
    const draft = serviceDraft('web', fatal);
    draft.mounts = [volumeMount('data')];
    fatal.markFatal(draft.path);
    checkPerReplicaVolumes([draft], table, fatal);
    expect(fatal.sink.list()).toEqual([]);
  });

  test('XD-11 per_replica is stored on a non-external volume', () => {
    const r = volume({ per_replica: true });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.perReplica).toBe(true);
    expect(volume({ per_replica: 'yes' }).rows).toEqual([['error', 'extension.invalid', 'volumes.data.x-dockflow.per_replica']]);
  });

  test('XD-15/16/13 at volume level: null, not a mapping, unknown key', () => {
    const empty = volume(null);
    expect(empty.diagnostics).toEqual([]);
    expect(empty.draft).toMatchObject({ size: '1Gi', storageClass: K8S_STORAGE_CLASS, accessMode: 'ReadWriteOnce', perReplica: false });
    expect(volume('10Gi').diagnostics).toEqual([
      { severity: 'error', code: 'values.invalid-type', path: 'volumes.data.x-dockflow', message: 'expected mapping, got string', hint: HINT },
    ]);
    expect(volume({ kind: 'statefulset' }).diagnostics).toEqual([
      { severity: 'error', code: 'extension.invalid', path: 'volumes.data.x-dockflow.kind', message: 'is not an x-dockflow key', hint: HINT },
    ]);
  });

  test('volumeExtensions applies each declared volume and skips undeclared keys', () => {
    const ctx = normalizeContext({
      compose: {
        services: { web: { image: 'x:1' } },
        volumes: { data: { 'x-dockflow': { size: '5Gi' } }, cache: null, 'pg-data': { 'x-dockflow': { storage_class: 'fast' } } },
      },
    });
    const table = new Map<string, VolumeDraft>([
      ['data', newVolumeDraft('data', ctx)],
      ['cache', newVolumeDraft('cache', ctx)],
    ]);
    volumeExtensions(ctx.input.compose.raw.volumes, table, ctx);
    expect(table.get('data')?.size).toBe('5Gi');
    expect(table.get('cache')).toMatchObject({ size: '1Gi', storageClass: K8S_STORAGE_CLASS });
    expect(ctx.sink.list().map((d) => [d.code, d.path])).toEqual([['volumes.size-not-enforced', 'volumes.data.x-dockflow.size']]);
    expect(() => volumeExtensions(null, table, ctx)).not.toThrow();
  });
});

describe('handler contract', () => {
  test('never throws on hostile values and keeps the defaults', () => {
    const hostile = [0, -1, 'x', true, [], [1, [2]], { a: { b: [] } }];
    for (const value of hostile) {
      const service = {
        kind: value,
        publish: value,
        lb_source_ranges: value,
        probes: value,
        node_selector: value,
        tolerations: [value],
        fs_group: value,
        pod_labels: value,
      };
      const r = ext(service);
      expect(r.codes.every((c) => c === 'extension.invalid')).toBe(true);
      expect(r.draft.extension).toEqual(DEFAULT_EXTENSION);
      expect(() => volume(value)).not.toThrow();
      expect(() => ext(value)).not.toThrow();
    }

    function volume(value: unknown) {
      const ctx = normalizeContext();
      volumeExtension(newVolumeDraft('data', ctx), { [EXTENSION_KEY]: { size: value, storage_class: value, access_mode: value, per_replica: value } }, ctx);
      volumeExtension(newVolumeDraft('data', ctx), value, ctx);
    }
  });

  test('a service already marked fatal is left untouched', () => {
    const ctx = normalizeContext({ compose: { image: 'x:1', 'x-dockflow': { kind: 'statefulset', publish: 'public' } } });
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    extension(draft, ctx.input.compose.services.web, ctx);
    expect(ctx.sink.list()).toEqual([]);
    expect(draft.workloadKind).toBe('Deployment');
    expect(draft.extension).toEqual(DEFAULT_EXTENSION);
  });

  test('every code extension.ts emits is exercised by this file (keys.test.ts step 3)', () => {
    const source = readFileSync(join(import.meta.dir, '../../../services/orchestrator/kubernetes/normalize/extension.ts'), 'utf8');
    const self = readFileSync(join(import.meta.dir, 'extension.test.ts'), 'utf8');
    const emitted = [...source.matchAll(/sink\.(?:error|warn|info)\(\s*'([a-z_]+\.[a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(new Set(emitted).size).toBeGreaterThanOrEqual(11);
    const missing = [...new Set(emitted)].filter((code) => !self.includes(`'${code}'`));
    expect(missing).toEqual([]);
  });
});
