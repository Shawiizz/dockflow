import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import { ANNOTATIONS, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import { selectorLabels, serviceObjectLabels, volumeClaimLabels } from '../../../services/orchestrator/kubernetes/labels';
import type {
  AnonymousMountSpec,
  BindMountSpec,
  CanonicalFileSource,
  CanonicalService,
  CanonicalVolume,
  EnvVar,
  FileMountSpec,
  PlacementConstraint,
  PortSpec,
  RouteSpec,
  TmpfsMountSpec,
  VolumeMountSpec,
} from '../../../services/orchestrator/kubernetes/model/types';
import { hashedObjectName } from '../../../services/orchestrator/kubernetes/naming';
import type { Container, PodSpec, Volume, VolumeMount } from '../../../services/orchestrator/kubernetes/resources/core';
import type { EnvSecretResult, PodTemplate, TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import { buildPodTemplate, configHash, ENGINE_SOCKETS } from '../../../services/orchestrator/kubernetes/translate/pod';
import { DeployError } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import {
  canonicalFileSource,
  canonicalService,
  canonicalStack,
  canonicalVolume,
  type ServiceOverrides,
  type StackOverrides,
  type TranslateOptionsOverrides,
  translateContext,
} from '../support/builders';
import { k8sExpand } from '../support/k8s-expand';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

// ---------------------------------------------------------------------------
// Harness: build one pod template, wrap it in the workload of its kind, validate the artifact
// ---------------------------------------------------------------------------

interface RenderOptions {
  volumes?: CanonicalVolume[];
  files?: CanonicalFileSource[];
  env?: EnvSecretResult | null;
  options?: TranslateOptionsOverrides;
  stack?: Omit<StackOverrides, 'services' | 'volumes' | 'files'>;
}

interface Rendered {
  svc: CanonicalService;
  ctx: TranslateContext;
  env: EnvSecretResult | null;
  template: PodTemplate;
  spec: PodSpec;
  container: Container;
  diagnostics: Diagnostic[];
}

function render(svc: CanonicalService, o: RenderOptions = {}): Rendered {
  const stack = canonicalStack({ role: svc.role, ...o.stack, services: [svc], volumes: o.volumes ?? [], files: o.files ?? [] });
  const ctx = translateContext(stack, o.options);
  const env = o.env ?? null;
  const template = buildPodTemplate(svc, env, ctx);
  return { svc, ctx, env, template, spec: template.spec, container: template.spec.containers[0], diagnostics: ctx.sink.list() };
}

function codes(r: Rendered): [string, string, string][] {
  return r.diagnostics.map((d) => [d.severity, d.code, d.path]);
}

function errors(r: Rendered): Diagnostic[] {
  return r.diagnostics.filter((d) => d.severity === 'error');
}

/** The workload of the service's kind around the template, with the minimum the semantic rules need. */
function artifact(r: Rendered): Record<string, unknown>[] {
  const { svc, ctx, template } = r;
  const id = ctx.stack.identity;
  const metadata = (name: string): Record<string, unknown> => ({
    name,
    namespace: ctx.namespace,
    labels: serviceObjectLabels(id, svc.role, svc.name),
    annotations: { [ANNOTATIONS.composeService]: svc.composeName },
  });
  const selector = { matchLabels: selectorLabels(id, svc.name) };
  const bindsNode = template.spec.hostNetwork === true || template.spec.containers.some((c) => (c.ports ?? []).some((p) => p.hostPort !== undefined));
  switch (svc.workloadKind) {
    case 'Deployment':
      return [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: metadata(svc.name),
          spec: {
            progressDeadlineSeconds: 240,
            replicas: svc.replicas,
            revisionHistoryLimit: 3,
            selector,
            strategy: { type: 'RollingUpdate', rollingUpdate: bindsNode ? { maxSurge: 0, maxUnavailable: 1 } : { maxSurge: 1, maxUnavailable: 0 } },
            template,
          },
        },
      ];
    case 'DaemonSet':
      return [
        {
          apiVersion: 'apps/v1',
          kind: 'DaemonSet',
          metadata: metadata(svc.name),
          spec: { revisionHistoryLimit: 3, selector, template, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } } },
        },
      ];
    case 'Job':
      return [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: metadata(`${svc.name}-0c1d2e3f`),
          spec: { backoffLimit: 6, completions: svc.replicas, parallelism: svc.replicas, template },
        },
      ];
    case 'StatefulSet': {
      const keys = [...new Set(svc.mounts.flatMap((m) => (m.type === 'volume' ? [m.volume] : [])))];
      const claimTemplates = keys
        .map((key) => ctx.volumes.get(key))
        .filter((v): v is CanonicalVolume => v !== undefined && v.perReplica)
        .map((v) => ({
          metadata: { name: v.name, labels: volumeClaimLabels(id, svc.role, v.name, v.labels), annotations: { [ANNOTATIONS.composeVolume]: v.key } },
          spec: { accessModes: [v.accessMode], resources: { requests: { storage: v.size } }, storageClassName: v.storageClass },
        }));
      return [
        {
          apiVersion: 'apps/v1',
          kind: 'StatefulSet',
          metadata: metadata(svc.name),
          spec: {
            persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
            podManagementPolicy: 'Parallel',
            replicas: svc.replicas,
            revisionHistoryLimit: 3,
            selector,
            serviceName: `${svc.name}-hl`,
            template,
            updateStrategy: { type: 'RollingUpdate' },
            ...(claimTemplates.length > 0 ? { volumeClaimTemplates: claimTemplates } : {}),
          },
        },
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: metadata(`${svc.name}-hl`),
          spec: { clusterIP: 'None', ports: [{ name: 'placeholder', port: 9, protocol: 'TCP' }], selector: selectorLabels(id, svc.name) },
        },
      ];
    }
  }
}

/** Structural and semantic validation of the wrapped template (PD-11 (e), design-02 14). */
function expectValid(r: Rendered): void {
  const externalNames = [
    ...[...r.ctx.volumes.values()].map((v) => v.name),
    ...[...r.ctx.files.values()].map((f) => f.objectName),
    ...(r.env === null ? [] : [r.env.secret.metadata.name]),
  ];
  const issues = failures(
    validateArtifact(artifact(r), { namespace: r.ctx.namespace, externalNames, serverNames: r.ctx.options.serverNames, traits: r.ctx.traits }),
  );
  expect(formatIssues(issues)).toBe('');
}

/** Renders, asserts no error diagnostic and a valid artifact. */
function checked(svc: CanonicalService, o: RenderOptions = {}): Rendered {
  const r = render(svc, o);
  expect(errors(r)).toEqual([]);
  expectValid(r);
  return r;
}

function expectTranslatorBug(run: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeployError);
  expect((caught as DeployError).message).toMatch(message);
  expect((caught as DeployError).suggestion).toBe('Report this as a Dockflow bug.');
}

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

function port(overrides: Partial<PortSpec> = {}): PortSpec {
  return { target: 80, published: null, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: 'services.web.ports[0]', ...overrides };
}

function bind(overrides: Partial<BindMountSpec> = {}): BindMountSpec {
  return {
    type: 'bind',
    source: '/srv/shop/data',
    target: '/srv/data',
    readOnly: false,
    createHostPath: true,
    propagation: null,
    recursive: 'enabled',
    path: 'services.web.volumes[0]',
    ...overrides,
  };
}

function volumeMount(overrides: Partial<VolumeMountSpec> = {}): VolumeMountSpec {
  return { type: 'volume', volume: 'data', target: '/data', readOnly: false, subpath: null, path: 'services.web.volumes[0]', ...overrides };
}

function tmpfs(overrides: Partial<TmpfsMountSpec> = {}): TmpfsMountSpec {
  return { type: 'tmpfs', target: '/tmp', sizeBytes: null, path: 'services.web.tmpfs[0]', ...overrides };
}

function anonymous(overrides: Partial<AnonymousMountSpec> = {}): AnonymousMountSpec {
  return { type: 'anonymous', target: '/cache', path: 'services.web.volumes[1]', ...overrides };
}

function fileMount(overrides: Partial<FileMountSpec> = {}): FileMountSpec {
  return { kind: 'secret', source: 'api_key', target: '/run/secrets/api_key', mode: 0o444, uid: null, gid: null, path: 'services.web.secrets[0]', ...overrides };
}

function route(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    router: 'shop-production-web',
    rule: 'Host(`shop.example.com`)',
    entryPoints: ['websecure'],
    tls: { certResolver: 'letsencrypt' },
    middlewares: [],
    priority: null,
    port: 8081,
    origin: 'injected',
    path: 'services.web',
    ...overrides,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ConstraintInput = DistributiveOmit<PlacementConstraint, 'path'>;

function constraint(c: ConstraintInput, index = 0): PlacementConstraint {
  return { path: `services.web.deploy.placement.constraints[${index}]`, ...c } as PlacementConstraint;
}

function envSecret(svc: CanonicalService, vars: EnvVar[]): EnvSecretResult {
  const checksum = sha256Hex(canonicalJson(vars));
  return {
    checksum,
    secret: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: hashedObjectName(svc.name, 'env', checksum), namespace: 'dockflow-shop-production' },
      data: Object.fromEntries(vars.map((v) => [v.name, Buffer.from(v.value, 'utf8').toString('base64')])),
      immutable: true,
    },
  };
}

function volumeNamed(r: Rendered, name: string): Volume | undefined {
  return r.spec.volumes?.find((v) => v.name === name);
}

function mountAt(r: Rendered, mountPath: string): VolumeMount | undefined {
  return r.container.volumeMounts?.find((m) => m.mountPath === mountPath);
}

const sha8 = (value: string): string => sha256Hex(value).slice(0, 8);

// ---------------------------------------------------------------------------
// Pod-level constants and metadata (design-02 5.1, 1.3; T-WORK-04..07)
// ---------------------------------------------------------------------------

describe('pod-level constants and metadata', () => {
  test('a default service carries every mandatory field and nothing else', () => {
    const r = checked(canonicalService());
    expect(r.template).toEqual({
      metadata: {
        annotations: { [ANNOTATIONS.composeService]: 'web', 'kubectl.kubernetes.io/default-container': 'web' },
        labels: {
          'app.kubernetes.io/instance': 'dockflow-shop-production',
          'app.kubernetes.io/name': 'web',
          'dockflow.shawiizz.dev/role': 'app',
          'dockflow.shawiizz.dev/service': 'web',
          'dockflow.shawiizz.dev/stack': 'dockflow-shop-production',
        },
      },
      spec: {
        automountServiceAccountToken: false,
        containers: [{ name: 'web', image: 'nginx:1.27', imagePullPolicy: 'IfNotPresent' }],
        enableServiceLinks: false,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        terminationGracePeriodSeconds: 10,
        topologySpreadConstraints: [
          {
            labelSelector: { matchLabels: { 'dockflow.shawiizz.dev/service': 'web', 'dockflow.shawiizz.dev/stack': 'dockflow-shop-production' } },
            matchLabelKeys: ['pod-template-hash'],
            maxSkew: 1,
            topologyKey: 'kubernetes.io/hostname',
            whenUnsatisfiable: 'ScheduleAnyway',
          },
        ],
      },
    });
    expect(r.diagnostics).toEqual([]);
  });

  test.each([
    [10_000, 10],
    [60_000, 60],
    [1_500, 2],
    [0, 0],
  ])('stop_grace_period %p ms -> terminationGracePeriodSeconds %p', (ms, seconds) => {
    expect(checked(canonicalService({ process: { stopGracePeriodMs: ms } })).spec.terminationGracePeriodSeconds).toBe(seconds);
  });

  test('imagePullSecrets names the pull Secret on every pod template, accessories included', () => {
    const options = { pullSecretName: 'dockflow-registry' };
    expect(checked(canonicalService(), { options }).spec.imagePullSecrets).toEqual([{ name: 'dockflow-registry' }]);
    const accessory = checked(canonicalService({ composeName: 'db', role: 'accessory', image: { ref: 'postgres:16' } }), { options });
    expect(accessory.spec.imagePullSecrets).toEqual([{ name: 'dockflow-registry' }]);
    expect(accessory.template.metadata.labels?.['dockflow.shawiizz.dev/role']).toBe('accessory');
  });

  test('Jobs restart Never; long-running kinds leave restartPolicy out (4.5, K35)', () => {
    const job = checked(canonicalService({ composeName: 'migrate', mode: 'replicated-job', restart: { condition: 'none' } }));
    expect(job.spec.restartPolicy).toBe('Never');
    for (const svc of [canonicalService(), canonicalService({ mode: 'global' }), canonicalService({ extension: { kind: 'statefulset' } })]) {
      expect(checked(svc).spec.restartPolicy).toBeUndefined();
    }
  });

  test('pod labels are the selector labels, name, instance, role and x-dockflow.pod_labels only (T-WORK-04)', () => {
    const r = checked(canonicalService({ extension: { podLabels: { tier: 'frontend' } } }));
    expect(r.template.metadata.labels).toEqual({
      tier: 'frontend',
      ...selectorLabels(r.ctx.stack.identity, 'web'),
      'app.kubernetes.io/name': 'web',
      'app.kubernetes.io/instance': 'dockflow-shop-production',
      'dockflow.shawiizz.dev/role': 'app',
    });
  });

  test('compose labels and annotations become pod annotations; annotations win a conflict (T-WORK-05)', () => {
    const r = render(
      canonicalService({
        containerLabels: { team: 'shop', 'com.example.owner': 'ops', same: 'x' },
        podAnnotations: { team: 'payments', 'com.example.owner': 'sre', same: 'x', extra: 'y' },
      }),
    );
    expect(r.template.metadata.annotations).toEqual({
      team: 'payments',
      'com.example.owner': 'sre',
      same: 'x',
      extra: 'y',
      [ANNOTATIONS.composeService]: 'web',
      [ANNOTATIONS.defaultContainer]: 'web',
    });
    expect(codes(r)).toEqual([
      ['warning', 'labels.annotation-conflict', 'services.web.annotations.team'],
      ['warning', 'labels.annotation-conflict', 'services.web.annotations["com.example.owner"]'],
    ]);
    expect(r.diagnostics[0].message).toBe('Key team of service web is set by labels and annotations with different values; annotations win');
    expectValid(r);
  });

  test('the compose-service annotation keeps the compose key; the container and default-container use the Kubernetes name', () => {
    const svc = canonicalService({ composeName: 'web_app' });
    const r = checked(svc);
    expect(r.container.name).toBe('web-app');
    expect(r.template.metadata.annotations?.[ANNOTATIONS.composeService]).toBe('web_app');
    expect(r.template.metadata.annotations?.[ANNOTATIONS.defaultContainer]).toBe('web-app');
  });

  test('a version change leaves the pod template byte-identical (T-WORK-06)', () => {
    const svc = canonicalService({ environment: [{ name: 'A', value: '1' }] });
    const env = envSecret(svc, svc.environment);
    const a = render(svc, { env, stack: { identity: { version: '1.4.2' } } });
    const b = render(svc, { env, stack: { identity: { version: '2.0.0' } } });
    expect(canonicalJson(a.template)).toBe(canonicalJson(b.template));
    expect(canonicalJson(a.template)).not.toContain('1.4.2');
  });
});

// ---------------------------------------------------------------------------
// Image and process (design-02 5.2, D12, DV5; T-PULL, T-SEC-03)
// ---------------------------------------------------------------------------

describe('image and process', () => {
  test('T-PULL-01: a built image delivered by import keeps its dockflow.invalid reference, IfNotPresent, no pull Secret', () => {
    const r = checked(canonicalService({ image: { ref: 'dockflow.invalid/shop-api:1.4.2', composeRef: 'shop-api:1.4.2', origin: 'built' } }));
    expect(r.container.image).toBe('dockflow.invalid/shop-api:1.4.2');
    expect(r.container.imagePullPolicy).toBe('IfNotPresent');
    expect(r.spec.imagePullSecrets).toBeUndefined();
  });

  test('T-PULL-02: a built image delivered by a registry uses its reference and the pull Secret', () => {
    const image = { ref: 'registry.example.com/shop-api:1.4.2', composeRef: 'registry.example.com/shop-api:1.4.2', origin: 'built' as const };
    const r = checked(canonicalService({ image }), { options: { pullSecretName: 'dockflow-registry' } });
    expect(r.container.image).toBe('registry.example.com/shop-api:1.4.2');
    expect(r.container.imagePullPolicy).toBe('IfNotPresent');
    expect(r.spec.imagePullSecrets).toEqual([{ name: 'dockflow-registry' }]);
  });

  test.each([
    ['redis:7.2', 'IfNotPresent'],
    ['redis:latest', 'Always'],
    ['redis', 'Always'],
    ['redis@sha256:0000000000000000000000000000000000000000000000000000000000000000', 'IfNotPresent'],
    ['redis:7.2', 'Never'],
  ] as const)('T-PULL-03/04: %p with the normalizer policy %p is emitted verbatim', (ref, pullPolicy) => {
    const r = checked(canonicalService({ image: { ref, composeRef: ref, pullPolicy } }));
    expect(r.container.image).toBe(ref);
    expect(r.container.imagePullPolicy).toBe(pullPolicy);
  });

  test('T6: an imported image with pull policy Always throws', () => {
    const svc = canonicalService({ image: { ref: 'dockflow.invalid/shop-api:1.4.2', origin: 'built', pullPolicy: 'Always' } });
    expectTranslatorBug(() => render(svc), /^Image dockflow\.invalid\/shop-api:1\.4\.2 of service web is imported/);
  });

  test('entrypoint becomes command and command becomes args, every $ doubled (T4)', () => {
    const r = checked(canonicalService({ process: { entrypoint: ['/bin/sh', '-c'], command: ['echo', '$(HOME)', '$$', 'cost $5', 'no dollar', 'trailing $'] } }));
    expect(r.container.command).toEqual(['/bin/sh', '-c']);
    expect(r.container.args).toEqual(['echo', '$$(HOME)', '$$$$', 'cost $$5', 'no dollar', 'trailing $$']);
  });

  test('T-SEC-03: the kubelet expands the escaped args back to the literals, whatever the environment', () => {
    const literals = ['echo', '$(HOME)', '$$', 'cost $5', '$(UNDEFINED)', '$', 'a$(B'];
    const r = checked(canonicalService({ process: { entrypoint: literals, command: literals } }));
    expect(k8sExpand(r.container.args ?? [], { HOME: '/root', B: 'b' })).toEqual(literals);
    expect(k8sExpand(r.container.command ?? [], { HOME: '/root' })).toEqual(literals);
  });

  test('null entrypoint and command keep the image defaults', () => {
    const r = checked(canonicalService());
    expect('command' in r.container).toBe(false);
    expect('args' in r.container).toBe(false);
  });

  test.each([
    ['entrypoint', { entrypoint: [] }, /empty entrypoint$/],
    ['command', { command: [] }, /empty command$/],
  ] as [string, Partial<CanonicalService['process']>, RegExp][])('T6: an empty %s throws (Kubernetes reads [] as the image default)', (_field, process, message) => {
    expectTranslatorBug(() => render(canonicalService({ process })), message);
  });

  test('workingDir, tty and stdin are emitted when set', () => {
    const r = checked(canonicalService({ process: { workingDir: '/srv/app', tty: true, stdinOpen: true } }));
    expect(r.container).toMatchObject({ workingDir: '/srv/app', tty: true, stdin: true });
    const plain = checked(canonicalService());
    expect(['workingDir', 'tty', 'stdin'].filter((k) => k in plain.container)).toEqual([]);
  });

  test('lifecycle hooks are exec commands and are never escaped (5.7)', () => {
    const r = checked(canonicalService({ process: { postStart: ['sh', '-c', 'echo $(X) $HOME'], preStop: ['nginx', '-s', 'quit'] } }));
    expect(r.container.lifecycle).toEqual({
      postStart: { exec: { command: ['sh', '-c', 'echo $(X) $HOME'] } },
      preStop: { exec: { command: ['nginx', '-s', 'quit'] } },
    });
    expect(checked(canonicalService({ process: { preStop: ['stop'] } })).container.lifecycle).toEqual({ preStop: { exec: { command: ['stop'] } } });
    expect(checked(canonicalService()).container.lifecycle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Environment and P/config-hash (design-02 5.3, DESIGN-CORE 5.3; T-SECRET-01, 11..13)
// ---------------------------------------------------------------------------

describe('environment and config hash', () => {
  test('the env Secret arrives through envFrom only, never through env values', () => {
    const svc = canonicalService({ environment: [{ name: 'A', value: '1' }, { name: 'B', value: 'x y' }] });
    const env = envSecret(svc, svc.environment);
    const r = checked(svc, { env });
    expect(r.container.envFrom).toEqual([{ secretRef: { name: env.secret.metadata.name } }]);
    expect(r.container.env).toBeUndefined();
    expect(canonicalJson(r.template)).not.toContain('x y');
  });

  test('T-SECRET-12: no environment and no file mount -> no envFrom and no config-hash', () => {
    const r = checked(canonicalService());
    expect(r.container.envFrom).toBeUndefined();
    expect(r.template.metadata.annotations?.[ANNOTATIONS.configHash]).toBeUndefined();
    expect(configHash(r.svc, null, r.ctx)).toBeNull();
  });

  test('T-SECRET-11: the hash covers the env checksum and one [target, checksum] pair per file mount', () => {
    const secret = canonicalFileSource();
    const svc = canonicalService({ environment: [{ name: 'A', value: '1' }], files: [fileMount()] });
    const env = envSecret(svc, svc.environment);
    const r = checked(svc, { env, files: [secret] });
    expect(r.template.metadata.annotations?.[ANNOTATIONS.configHash]).toBe(
      sha256Hex(canonicalJson({ env: env.checksum, files: [['/run/secrets/api_key', secret.checksum]] })),
    );
  });

  test('file mounts alone produce a hash whose env term is null', () => {
    const secret = canonicalFileSource();
    const r = checked(canonicalService({ files: [fileMount()] }), { files: [secret] });
    expect(r.template.metadata.annotations?.[ANNOTATIONS.configHash]).toBe(
      sha256Hex(canonicalJson({ env: null, files: [['/run/secrets/api_key', secret.checksum]] })),
    );
  });

  test('T-SECRET-13: an external source contributes null, so its content never rolls the pods', () => {
    const svc = canonicalService({ files: [fileMount({ source: 'shared_tls', target: '/run/secrets/shared_tls' })] });
    const hashes = ['a'.repeat(64), 'b'.repeat(64)].map((checksum) => {
      const external = canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls', checksum });
      return render(svc, { files: [external] }).template.metadata.annotations?.[ANNOTATIONS.configHash];
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toBe(sha256Hex(canonicalJson({ env: null, files: [['/run/secrets/shared_tls', null]] })));
  });

  test('T-SECRET-03: a changed env value changes the pod template', () => {
    const one = canonicalService({ environment: [{ name: 'A', value: '1' }] });
    const two = canonicalService({ environment: [{ name: 'A', value: '2' }] });
    const a = render(one, { env: envSecret(one, one.environment) });
    const b = render(two, { env: envSecret(two, two.environment) });
    expect(a.template.metadata.annotations?.[ANNOTATIONS.configHash]).not.toBe(b.template.metadata.annotations?.[ANNOTATIONS.configHash]);
    expect(a.container.envFrom).not.toEqual(b.container.envFrom);
  });
});

// ---------------------------------------------------------------------------
// Container ports (design-02 5.4, 6.7)
// ---------------------------------------------------------------------------

describe('container ports', () => {
  test('union of ports, expose and route ports, keyed by (target, protocol), sorted by (port, protocol)', () => {
    const svc = canonicalService({
      ports: [
        port({ target: 53, published: 53, protocol: 'UDP', path: 'services.web.ports[0]' }),
        port({ target: 53, published: 53, protocol: 'TCP', path: 'services.web.ports[1]' }),
        port({ target: 3000, published: 8080, path: 'services.web.ports[2]' }),
        port({ target: 3000, published: 9090, path: 'services.web.ports[3]' }),
      ],
      expose: [
        { target: 3000, protocol: 'TCP', path: 'services.web.expose[0]' },
        { target: 9000, protocol: 'TCP', path: 'services.web.expose[1]' },
        { target: 5000, protocol: 'SCTP', path: 'services.web.expose[2]' },
      ],
      routes: [route({ port: 8081 }), route({ router: 'api', port: 3000, origin: 'labels' })],
    });
    const r = checked(svc);
    expect(r.container.ports).toEqual([
      { name: 'tcp-53', containerPort: 53, protocol: 'TCP' },
      { name: 'udp-53', containerPort: 53, protocol: 'UDP' },
      { name: 'tcp-3000', containerPort: 3000, protocol: 'TCP' },
      { name: 'sctp-5000', containerPort: 5000, protocol: 'SCTP' },
      { name: 'tcp-8081', containerPort: 8081, protocol: 'TCP' },
      { name: 'tcp-9000', containerPort: 9000, protocol: 'TCP' },
    ]);
  });

  test('T-EXPO-20: protocol is emitted on every container port, TCP included', () => {
    const r = checked(canonicalService({ ports: [port({ published: 8080 })], expose: [{ target: 81, protocol: 'TCP', path: 'services.web.expose[0]' }] }));
    expect(r.container.ports?.every((p) => p.protocol !== undefined)).toBe(true);
  });

  test('names: a requested name is kept by the first claimant, later claimants fall back (6.7, T-EXPO-07/19)', () => {
    const svc = canonicalService({
      ports: [
        port({ target: 80, published: 8080, name: 'http', path: 'services.web.ports[0]' }),
        port({ target: 443, published: 8443, name: 'HTTP', path: 'services.web.ports[1]' }),
        port({ target: 9000, published: 9000, path: 'services.web.ports[2]' }),
        port({ target: 9001, published: 9001, name: 'metrics', path: 'services.web.ports[3]' }),
        port({ target: 9100, published: null, name: 'Node_Exporter', path: 'services.web.ports[4]' }),
        port({ target: 9200, published: null, name: 'not a valid iana name', path: 'services.web.ports[5]' }),
      ],
    });
    const r = checked(svc);
    expect(r.container.ports?.map((p) => [p.containerPort, p.name])).toEqual([
      [80, 'http'],
      [443, 'tcp-443'],
      [9000, 'tcp-9000'],
      [9001, 'metrics'],
      [9100, 'node-exporter'],
      [9200, 'tcp-9200'],
    ]);
  });

  test('the name of a (target, protocol) is the first requested one in model order', () => {
    const svc = canonicalService({
      ports: [
        port({ target: 80, published: 8080, path: 'services.web.ports[0]' }),
        port({ target: 80, published: 8081, name: 'web', path: 'services.web.ports[1]' }),
        port({ target: 80, published: 8082, name: 'other', path: 'services.web.ports[2]' }),
      ],
    });
    expect(checked(svc).container.ports).toEqual([{ name: 'web', containerPort: 80, protocol: 'TCP' }]);
  });

  test('load-balancer and container-only ports bind no node port', () => {
    const svc = canonicalService({ ports: [port({ target: 80, published: 8080 }), port({ target: 81, published: null, path: 'services.web.ports[1]' })] });
    const r = checked(svc);
    expect(r.container.ports?.some((p) => 'hostPort' in p || 'hostIP' in p)).toBe(false);
    const none = checked(canonicalService({ ports: [port({ published: 8080 })], extension: { publish: 'none' } }));
    expect(none.container.ports).toEqual([{ name: 'tcp-80', containerPort: 80, protocol: 'TCP' }]);
  });

  test('T-EXPO-08: mode host binds hostPort and hostIP', () => {
    const r = checked(canonicalService({ ports: [port({ target: 5353, published: 5353, protocol: 'UDP', mode: 'host', hostIp: '10.0.0.5' })] }));
    expect(r.container.ports).toEqual([{ name: 'udp-5353', containerPort: 5353, protocol: 'UDP', hostPort: 5353, hostIP: '10.0.0.5' }]);
  });

  test('T-EXPO-09/10: publish hostport binds ingress ports on the node, a specific address included', () => {
    const r = checked(
      canonicalService({
        ports: [port({ target: 5432, published: 5432, hostIp: '127.0.0.1' }), port({ target: 6000, published: null, path: 'services.web.ports[1]' })],
        extension: { publish: 'hostport' },
      }),
    );
    expect(r.container.ports).toEqual([
      { name: 'tcp-5432', containerPort: 5432, protocol: 'TCP', hostPort: 5432, hostIP: '127.0.0.1' },
      { name: 'tcp-6000', containerPort: 6000, protocol: 'TCP' },
    ]);
  });

  test.each(['0.0.0.0', '::'])('host IP %p means every address: no hostIP', (hostIp) => {
    const r = checked(canonicalService({ ports: [port({ published: 8080, mode: 'host', hostIp })] }));
    expect(r.container.ports).toEqual([{ name: 'tcp-80', containerPort: 80, protocol: 'TCP', hostPort: 8080 }]);
  });

  test('SCTP is accepted on node-bound entries', () => {
    const r = checked(canonicalService({ ports: [port({ target: 5000, published: 5000, protocol: 'SCTP' })], extension: { publish: 'hostport' } }));
    expect(r.container.ports).toEqual([{ name: 'sctp-5000', containerPort: 5000, protocol: 'SCTP', hostPort: 5000 }]);
  });

  test('ports.host-duplicate-target: two node bindings of one target, whatever their addresses (K36)', () => {
    const r = render(
      canonicalService({
        ports: [
          port({ target: 80, published: 8080, mode: 'host', hostIp: '127.0.0.1', path: 'services.web.ports[0]' }),
          port({ target: 80, published: 8080, mode: 'host', hostIp: '10.0.0.5', path: 'services.web.ports[1]' }),
        ],
      }),
    );
    expect(codes(r)).toEqual([['error', 'ports.host-duplicate-target', 'services.web.ports[1]']]);
    expect(r.diagnostics[0].message).toBe('services.web.ports[1] binds container port 80/tcp on the node a second time');
    expect(r.container.ports).toEqual([{ name: 'tcp-80', containerPort: 80, protocol: 'TCP', hostPort: 8080, hostIP: '127.0.0.1' }]);
  });

  test('a node binding and a load-balancer publication of one target are fine', () => {
    const r = checked(
      canonicalService({
        ports: [port({ published: 8080, mode: 'host' }), port({ published: 9090, path: 'services.web.ports[1]' })],
      }),
    );
    expect(r.container.ports).toEqual([{ name: 'tcp-80', containerPort: 80, protocol: 'TCP', hostPort: 8080 }]);
  });

  test('ports.host-port-replicas: node ports with replicas > 1, never for global services', () => {
    const hostPorts = [port({ target: 3000, published: 8080, mode: 'host' })];
    const r = render(canonicalService({ replicas: 2, ports: hostPorts }));
    expect(codes(r)).toEqual([['error', 'ports.host-port-replicas', 'services.web.deploy.replicas']]);
    expect(r.diagnostics[0].message).toBe('web binds node port 8080/tcp and runs 2 replicas, but two pods cannot bind one port on one node');
    expect(errors(render(canonicalService({ replicas: 2, ports: [port({ published: 8080 })], extension: { publish: 'hostport' } }))).map((d) => d.code)).toEqual([
      'ports.host-port-replicas',
    ]);
    checked(canonicalService({ replicas: 1, ports: hostPorts }));
    checked(canonicalService({ mode: 'global', replicas: 3, ports: hostPorts }));
    checked(canonicalService({ replicas: 3, ports: [port({ published: 8080 })] }));
  });

  test('ports.host-port-replicas names the first node binding in model order, or the lowest port on the node network', () => {
    const r = render(
      canonicalService({
        replicas: 2,
        ports: [
          port({ target: 9000, published: 9000, mode: 'host', path: 'services.web.ports[0]' }),
          port({ target: 80, published: 8080, mode: 'host', path: 'services.web.ports[1]' }),
        ],
      }),
    );
    expect(r.diagnostics.map((d) => d.message)).toEqual(['web binds node port 9000/tcp and runs 2 replicas, but two pods cannot bind one port on one node']);
    const hostNetwork = render(
      canonicalService({
        replicas: 2,
        network: { hostNetwork: true },
        expose: [
          { target: 8080, protocol: 'TCP', path: 'services.web.expose[0]' },
          { target: 53, protocol: 'UDP', path: 'services.web.expose[1]' },
        ],
      }),
    );
    expect(errors(hostNetwork).map((d) => d.message)).toEqual(['web binds node port 53/udp and runs 2 replicas, but two pods cannot bind one port on one node']);
  });

  test('T-NET-04: the node network binds every container port as itself', () => {
    const r = checked(
      canonicalService({
        network: { hostNetwork: true },
        expose: [{ target: 8080, protocol: 'TCP', path: 'services.web.expose[0]' }],
      }),
    );
    expect(r.spec.hostNetwork).toBe(true);
    expect(r.spec.dnsPolicy).toBe('ClusterFirstWithHostNet');
    expect(r.container.ports).toEqual([{ name: 'tcp-8080', containerPort: 8080, protocol: 'TCP', hostPort: 8080 }]);
    expect(codes(r)).toEqual([['warning', 'network.host-network', 'services.web.network_mode']]);
  });
});

// ---------------------------------------------------------------------------
// Volumes and mounts (design-02 5.5, 8.4; T-STOR, T-SECRET-05/07/10)
// ---------------------------------------------------------------------------

describe('pod volumes and mounts', () => {
  test('T-STOR-01: a shared named volume mounts its claim through a pvc- pod volume', () => {
    const data = canonicalVolume({ key: 'postgres_data' });
    const r = checked(canonicalService({ mounts: [volumeMount({ volume: 'postgres_data', target: '/var/lib/postgresql/data' })] }), { volumes: [data] });
    expect(r.spec.volumes).toEqual([{ name: 'pvc-postgres-data', persistentVolumeClaim: { claimName: 'postgres-data' } }]);
    expect(r.container.volumeMounts).toEqual([{ name: 'pvc-postgres-data', mountPath: '/var/lib/postgresql/data' }]);
  });

  test('readOnly and subPath of a volume mount', () => {
    const r = checked(canonicalService({ mounts: [volumeMount({ readOnly: true, subpath: 'conf' })] }), { volumes: [canonicalVolume()] });
    expect(r.container.volumeMounts).toEqual([{ name: 'pvc-data', mountPath: '/data', readOnly: true, subPath: 'conf' }]);
  });

  test('T-STOR-02: an external volume mounts the claim by its external name', () => {
    const legacy = canonicalVolume({ key: 'legacy', name: 'legacy-data', external: true });
    const r = checked(canonicalService({ mounts: [volumeMount({ volume: 'legacy' })] }), { volumes: [legacy] });
    expect(r.spec.volumes).toEqual([{ name: 'pvc-legacy-data', persistentVolumeClaim: { claimName: 'legacy-data' } }]);
  });

  test('a per-replica volume mounts the claim template by name, without a pod volume', () => {
    const queueData = canonicalVolume({ key: 'queue_data', perReplica: true, usedBy: ['queue'] });
    const svc = canonicalService({ composeName: 'queue', extension: { kind: 'statefulset' }, mounts: [volumeMount({ volume: 'queue_data', path: 'services.queue.volumes[0]' })] });
    const r = checked(svc, { volumes: [queueData] });
    expect(r.spec.volumes).toBeUndefined();
    expect(r.container.volumeMounts).toEqual([{ name: 'queue-data', mountPath: '/data' }]);
  });

  test('T6: a per-replica volume outside a StatefulSet throws', () => {
    const queueData = canonicalVolume({ key: 'queue_data', perReplica: true });
    expectTranslatorBug(() => render(canonicalService({ mounts: [volumeMount({ volume: 'queue_data' })] }), { volumes: [queueData] }), /reached a Deployment$/);
  });

  test('T6: a mount of a volume missing from the stack throws', () => {
    expectTranslatorBug(() => render(canonicalService({ mounts: [volumeMount({ volume: 'ghost' })] })), /^Volume ghost of service web is not in the stack$/);
  });

  test('volumes.pod-volume-name-collision: a claim template named like a generated pod volume', () => {
    const template = canonicalVolume({ key: 'pvc_cache', perReplica: true, path: 'volumes.pvc_cache' });
    const shared = canonicalVolume({ key: 'cache', path: 'volumes.cache' });
    const svc = canonicalService({
      extension: { kind: 'statefulset' },
      mounts: [volumeMount({ volume: 'cache', target: '/a' }), volumeMount({ volume: 'pvc_cache', target: '/b', path: 'services.web.volumes[1]' })],
    });
    const r = render(svc, { volumes: [shared, template] });
    expect(codes(r)).toEqual([['error', 'volumes.pod-volume-name-collision', 'volumes.pvc_cache']]);
    expect(r.diagnostics[0].message).toBe('Volumes pvc_cache and cache of service web need the same pod volume name');
  });

  test('T-STOR-03: a bind is a hostPath without type, and must exist on every node', () => {
    const r = render(canonicalService({ mounts: [bind({ source: '/srv/shop/app.conf', target: '/etc/app/app.conf' })] }));
    const name = `host-${sha8('/srv/shop/app.conf')}`;
    expect(r.spec.volumes).toEqual([{ name, hostPath: { path: '/srv/shop/app.conf' } }]);
    expect(r.container.volumeMounts).toEqual([{ name, mountPath: '/etc/app/app.conf' }]);
    expect(codes(r)).toEqual([['info', 'volumes.bind-node-local', 'services.web.volumes[0]']]);
    expect(r.diagnostics[0].message).toBe('Bind source /srv/shop/app.conf must exist on every node that may run web');
    expectValid(r);
  });

  test('create_host_path: false is not enforceable: warning', () => {
    const r = render(canonicalService({ mounts: [bind({ createHostPath: false })] }));
    expect(codes(r)).toEqual([
      ['warning', 'volumes.bind-create-host-path', 'services.web.volumes[0]'],
      ['info', 'volumes.bind-node-local', 'services.web.volumes[0]'],
    ]);
    expect(r.spec.volumes?.[0].hostPath).toEqual({ path: '/srv/shop/data' });
  });

  test('pod volume names are stable hashes and one source shares one pod volume', () => {
    const svc = canonicalService({
      mounts: [bind({ target: '/a' }), bind({ target: '/b', readOnly: true, path: 'services.web.volumes[1]' }), volumeMount({ target: '/c', path: 'services.web.volumes[2]' }), volumeMount({ target: '/d', path: 'services.web.volumes[3]' })],
    });
    const volumes = [canonicalVolume()];
    const a = checked(svc, { volumes });
    const b = checked(svc, { volumes });
    expect(canonicalJson(a.template)).toBe(canonicalJson(b.template));
    expect(a.spec.volumes?.map((v) => v.name)).toEqual([`host-${sha8('/srv/shop/data')}`, 'pvc-data']);
    expect(a.container.volumeMounts?.map((m) => [m.mountPath, m.name])).toEqual([
      ['/a', `host-${sha8('/srv/shop/data')}`],
      ['/b', `host-${sha8('/srv/shop/data')}`],
      ['/c', 'pvc-data'],
      ['/d', 'pvc-data'],
    ]);
  });

  test('volumes are sorted by name and mounts by mountPath (core rule 4)', () => {
    const svc = canonicalService({
      mounts: [anonymous({ target: '/cache' }), volumeMount({ target: '/data' }), tmpfs({ target: '/tmp' })],
      files: [fileMount({ target: '/run/secrets/api_key' })],
    });
    const r = checked(svc, { volumes: [canonicalVolume()], files: [canonicalFileSource()] });
    const names = r.spec.volumes?.map((v) => v.name) ?? [];
    expect(names).toEqual([...names].sort());
    expect(r.container.volumeMounts?.map((m) => m.mountPath)).toEqual(['/cache', '/data', '/run/secrets/api_key', '/tmp']);
  });

  test('T-STOR-04: tmpfs, shm_size and anonymous volumes are emptyDirs', () => {
    const svc = canonicalService({
      mounts: [
        anonymous({ target: '/cache' }),
        tmpfs({ target: '/dev/shm', sizeBytes: 1024 ** 3, path: 'services.web.shm_size' }),
        tmpfs({ target: '/run', sizeBytes: null, path: 'services.web.tmpfs[1]' }),
        tmpfs({ target: '/tmp', sizeBytes: 64 * 1024 ** 2, path: 'services.web.tmpfs[0]' }),
      ],
    });
    const r = render(svc);
    expect(volumeNamed(r, `anon-${sha8('/cache')}`)).toEqual({ name: `anon-${sha8('/cache')}`, emptyDir: {} });
    expect(volumeNamed(r, `tmpfs-${sha8('/dev/shm')}`)?.emptyDir).toEqual({ medium: 'Memory', sizeLimit: '1Gi' });
    expect(volumeNamed(r, `tmpfs-${sha8('/tmp')}`)?.emptyDir).toEqual({ medium: 'Memory', sizeLimit: '64Mi' });
    expect(volumeNamed(r, `tmpfs-${sha8('/run')}`)?.emptyDir).toEqual({ medium: 'Memory' });
    expect(mountAt(r, '/dev/shm')).toEqual({ name: `tmpfs-${sha8('/dev/shm')}`, mountPath: '/dev/shm' });
    expect(codes(r)).toEqual([
      ['info', 'volumes.tmpfs-memory', 'services.web.shm_size'],
      ['info', 'volumes.tmpfs-memory', 'services.web.tmpfs[0]'],
      ['info', 'volumes.tmpfs-memory', 'services.web.tmpfs[1]'],
    ]);
    expectValid(r);
  });

  test('T-SECRET-05: a secret mount is a one-item secret volume with defaultMode, one volume per mode', () => {
    const secret = canonicalFileSource();
    const svc = canonicalService({
      files: [fileMount({ target: '/run/secrets/api_key', mode: 0o440 }), fileMount({ target: '/etc/app/key', mode: 0o444, path: 'services.web.secrets[1]' })],
    });
    const r = checked(svc, { files: [secret] });
    expect(r.spec.volumes).toEqual([
      { name: 'secret-api-key-440', secret: { defaultMode: 288, items: [{ key: 'api_key', path: 'api_key' }], secretName: secret.objectName } },
      { name: 'secret-api-key-444', secret: { defaultMode: 292, items: [{ key: 'api_key', path: 'api_key' }], secretName: secret.objectName } },
    ]);
    expect(r.container.volumeMounts).toEqual([
      { name: 'secret-api-key-444', mountPath: '/etc/app/key', readOnly: true, subPath: 'api_key' },
      { name: 'secret-api-key-440', mountPath: '/run/secrets/api_key', readOnly: true, subPath: 'api_key' },
    ]);
    expect(canonicalJson(r.spec.volumes)).not.toContain('"mode"');
  });

  test('a config mount is a one-item configMap volume; the same mode shares the volume', () => {
    const nginx = canonicalFileSource({ kind: 'config', key: 'nginx_conf', data: new TextEncoder().encode('server {}') });
    const svc = canonicalService({
      files: [
        fileMount({ kind: 'config', source: 'nginx_conf', target: '/etc/nginx/nginx.conf', path: 'services.web.configs[0]' }),
        fileMount({ kind: 'config', source: 'nginx_conf', target: '/nginx_conf', path: 'services.web.configs[1]' }),
      ],
    });
    const r = checked(svc, { files: [nginx] });
    expect(r.spec.volumes).toEqual([
      { name: 'config-nginx-conf-444', configMap: { defaultMode: 292, items: [{ key: 'nginx_conf', path: 'nginx_conf' }], name: nginx.objectName } },
    ]);
    expect(r.container.volumeMounts?.map((m) => m.name)).toEqual(['config-nginx-conf-444', 'config-nginx-conf-444']);
  });

  test('T-SECRET-07: an external secret is referenced by its name, with the compose key as item', () => {
    const external = canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls' });
    const r = checked(canonicalService({ files: [fileMount({ source: 'shared_tls', target: '/run/secrets/shared_tls' })] }), { files: [external] });
    expect(r.spec.volumes).toEqual([
      { name: 'secret-shared-tls-444', secret: { defaultMode: 292, items: [{ key: 'shared_tls', path: 'shared_tls' }], secretName: 'shared-tls' } },
    ]);
  });

  test('T6: a file mount whose source is missing from the stack throws', () => {
    expectTranslatorBug(() => render(canonicalService({ files: [fileMount()] })), /^Secret api_key of service web is not in the stack$/);
  });

  test('T-SECRET-10: long names keep every pod volume name within 63 characters', () => {
    const composeName = 'a'.repeat(52);
    const key = `k${'e'.repeat(70)}`;
    const secret = canonicalFileSource({ key });
    const volume = canonicalVolume({ key: `v${'o'.repeat(70)}` });
    const svc = canonicalService({
      composeName,
      environment: [{ name: 'A', value: '1' }],
      mounts: [volumeMount({ volume: volume.key })],
      files: [fileMount({ source: key, target: '/run/secrets/key' })],
    });
    const r = checked(svc, { volumes: [volume], files: [secret], env: envSecret(canonicalService({ composeName }), [{ name: 'A', value: '1' }]) });
    expect(r.spec.volumes?.every((v) => v.name.length <= 63)).toBe(true);
  });
});

describe('bind recursive read-only (design-02 5.5, K72)', () => {
  test.each([
    ['enabled', true, { readOnly: true, recursiveReadOnly: 'IfPossible' }],
    ['readonly', true, { readOnly: true, recursiveReadOnly: 'Enabled' }],
    ['writable', true, { readOnly: true }],
    ['enabled', false, {}],
    ['writable', false, {}],
  ] as const)('recursive %p on a readOnly=%p bind', (recursive, readOnly, expected) => {
    const r = checked(canonicalService({ mounts: [bind({ recursive, readOnly })] }));
    expect(r.container.volumeMounts).toEqual([{ name: `host-${sha8('/srv/shop/data')}`, mountPath: '/srv/data', ...expected }]);
  });

  test('rslave keeps plain readOnly under the default recursive mode', () => {
    const r = checked(canonicalService({ mounts: [bind({ readOnly: true, propagation: 'rslave' })] }));
    expect(r.container.volumeMounts?.[0]).toEqual({ name: `host-${sha8('/srv/shop/data')}`, mountPath: '/srv/data', readOnly: true, mountPropagation: 'HostToContainer' });
  });

  test('rslave with bind.recursive: readonly is refused', () => {
    const r = render(canonicalService({ mounts: [bind({ readOnly: true, recursive: 'readonly', propagation: 'rslave' })] }));
    expect(errors(r).map((d) => [d.code, d.path])).toEqual([['volumes.recursive-readonly-propagation', 'services.web.volumes[0]']]);
    expect(errors(r)[0].message).toBe(
      'Bind /srv/shop/data of service web asks for bind.recursive: readonly with rslave propagation, which Kubernetes cannot combine',
    );
    expect(r.container.volumeMounts?.[0].recursiveReadOnly).toBeUndefined();
  });

  test('T6: recursive read-only on a writable bind throws', () => {
    expectTranslatorBug(() => render(canonicalService({ mounts: [bind({ recursive: 'readonly', readOnly: false })] })), /recursive read-only on a writable mount$/);
  });
});

describe('container engine sockets', () => {
  test.each(ENGINE_SOCKETS.map((socket) => [socket]))('%p is refused and not mounted', (socket) => {
    const r = render(canonicalService({ mounts: [bind({ source: socket, target: socket })] }));
    expect(codes(r)).toEqual([['error', 'volumes.docker-socket', 'services.web.volumes[0]']]);
    expect(r.diagnostics[0].message).toBe(`Service web mounts the container engine socket ${socket}, which does not exist on Kubernetes nodes`);
    expect(r.diagnostics[0].hint).toBe('Remove the mount; use the Kubernetes API from a sidecar instead.');
    expect(r.spec.volumes).toBeUndefined();
    expect(r.container.volumeMounts).toBeUndefined();
  });

  test('the socket list is the four engine sockets', () => {
    expect([...ENGINE_SOCKETS].sort()).toEqual(['/run/docker.sock', '/run/podman/podman.sock', '/var/run/docker.sock', '/var/run/podman/podman.sock']);
  });
});

describe('bind propagation', () => {
  test.each([
    ['private', undefined],
    ['rprivate', undefined],
    [null, undefined],
    ['slave', 'HostToContainer'],
    ['rslave', 'HostToContainer'],
  ] as const)('%p -> mountPropagation %p', (propagation, expected) => {
    const r = checked(canonicalService({ mounts: [bind({ propagation })] }));
    expect(r.container.volumeMounts?.[0].mountPropagation).toBe(expected);
  });

  test.each(['shared', 'rshared'] as const)('%p is Bidirectional for a privileged container', (propagation) => {
    const r = render(canonicalService({ mounts: [bind({ propagation })], security: { privileged: true } }));
    expect(errors(r)).toEqual([]);
    expect(r.container.volumeMounts?.[0].mountPropagation).toBe('Bidirectional');
    expectValid(r);
  });

  test.each(['shared', 'rshared'] as const)('%p without privileged is refused', (propagation) => {
    const r = render(canonicalService({ mounts: [bind({ propagation })] }));
    expect(errors(r).map((d) => d.code)).toEqual(['volumes.propagation-bidirectional']);
    expect(errors(r)[0].message).toBe('Bind /srv/shop/data of service web uses shared propagation, which Kubernetes allows only for privileged containers');
  });
});

// ---------------------------------------------------------------------------
// Security context (design-02 5.8; T-SEC-01/02)
// ---------------------------------------------------------------------------

describe('security context', () => {
  test('T-SEC-01: pod and container fields from the model', () => {
    const svc = canonicalService({
      process: { user: { uid: 1000, gid: 1000 }, groupAdd: [20, 44] },
      security: {
        capAdd: ['NET_ADMIN', 'CHOWN'],
        capDrop: ['ALL'],
        readOnlyRootFilesystem: true,
        noNewPrivileges: true,
        seccomp: 'unconfined',
        apparmor: 'unconfined',
        sysctls: { 'net.ipv4.tcp_syncookies': '1', 'kernel.shm_rmid_forced': '1' },
        hostPid: true,
        hostIpc: true,
      },
      extension: { fsGroup: 2000 },
    });
    const r = checked(svc);
    expect(r.spec.securityContext).toEqual({
      seccompProfile: { type: 'Unconfined' },
      appArmorProfile: { type: 'Unconfined' },
      sysctls: [
        { name: 'kernel.shm_rmid_forced', value: '1' },
        { name: 'net.ipv4.tcp_syncookies', value: '1' },
      ],
      supplementalGroups: [20, 44],
      fsGroup: 2000,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    expect(r.container.securityContext).toEqual({
      capabilities: { add: ['CHOWN', 'NET_ADMIN'], drop: ['ALL'] },
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      runAsUser: 1000,
      runAsGroup: 1000,
    });
    expect(r.spec.hostPID).toBe(true);
    expect(r.spec.hostIPC).toBe(true);
  });

  test('localhost profiles name their profile; a user without group sets runAsUser only', () => {
    const r = checked(
      canonicalService({
        process: { user: { uid: 33, gid: null } },
        security: { seccomp: { localhostProfile: 'profiles/audit.json' }, apparmor: { localhostProfile: 'k8s-apparmor-example' } },
      }),
    );
    expect(r.spec.securityContext).toEqual({
      seccompProfile: { type: 'Localhost', localhostProfile: 'profiles/audit.json' },
      appArmorProfile: { type: 'Localhost', localhostProfile: 'k8s-apparmor-example' },
    });
    expect(r.container.securityContext).toEqual({ runAsUser: 33 });
  });

  test('defaults: RuntimeDefault seccomp, no AppArmor profile, no container security context', () => {
    const r = checked(canonicalService());
    expect(r.spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } });
    expect(r.container.securityContext).toBeUndefined();
    expect(r.spec.hostPID).toBeUndefined();
    expect(r.spec.hostIPC).toBeUndefined();
  });

  test('privileged is granted with a warning (Swarm ignored it)', () => {
    const r = render(canonicalService({ security: { privileged: true } }));
    expect(r.container.securityContext).toEqual({ privileged: true });
    expect(codes(r)).toEqual([['warning', 'security.privileged', 'services.web.privileged']]);
    expectValid(r);
  });

  test('no-new-privileges with privileged is refused', () => {
    const r = render(canonicalService({ security: { privileged: true, noNewPrivileges: true } }));
    expect(errors(r).map((d) => [d.code, d.path])).toEqual([['security.no-new-privileges-privileged', 'services.web.security_opt']]);
  });

  test('T-SEC-02: init shares the process namespace, with an info', () => {
    const r = render(canonicalService({ process: { init: true } }));
    expect(r.spec.shareProcessNamespace).toBe(true);
    expect(codes(r)).toEqual([['info', 'process.init-shared-pid', 'services.web.init']]);
    expectValid(r);
  });

  test('init with pid: host is refused', () => {
    const r = render(canonicalService({ process: { init: true }, security: { hostPid: true } }));
    expect(codes(r)).toEqual([['error', 'security.init-host-pid', 'services.web.init']]);
  });
});

// ---------------------------------------------------------------------------
// Resources (design-02 5.9; T-STOR-05, T-META-07)
// ---------------------------------------------------------------------------

describe('resources', () => {
  test('limits only: the requests are explicit zeros', () => {
    const r = checked(canonicalService({ resources: { limits: { cpu: 500, memory: 512 * 1024 ** 2 } } }));
    expect(r.container.resources).toEqual({ limits: { cpu: '500m', memory: '512Mi' }, requests: { cpu: '0', memory: '0' } });
  });

  test('reservations only: requests without limits', () => {
    const r = checked(canonicalService({ resources: { reservations: { cpu: 250, memory: 1000 } } }));
    expect(r.container.resources).toEqual({ requests: { cpu: '250m', memory: '1k' } });
  });

  test('both, in canonical quantities', () => {
    const r = checked(canonicalService({ resources: { limits: { cpu: 2000, memory: 1024 ** 3 }, reservations: { cpu: 1500, memory: 1_048_577 } } }));
    expect(r.container.resources).toEqual({ limits: { cpu: '2', memory: '1Gi' }, requests: { cpu: '1500m', memory: '1048577' } });
  });

  test('one resource limited, the other reserved', () => {
    const r = checked(canonicalService({ resources: { limits: { memory: 12 * 1024 ** 3 + 1 }, reservations: { cpu: 12500 } } }));
    expect(r.container.resources).toEqual({ limits: { memory: '12884901889' }, requests: { cpu: '12500m', memory: '0' } });
  });

  test('nothing set: resources omitted; pids never reach the container', () => {
    expect(checked(canonicalService()).container.resources).toBeUndefined();
    expect(checked(canonicalService({ resources: { limits: { pids: 100 } } })).container.resources).toBeUndefined();
  });

  test('memory quantities never end with m', () => {
    for (const memory of [1, 999, 1000, 1024, 1536, 536870912]) {
      const r = checked(canonicalService({ resources: { limits: { memory } } }));
      expect(r.container.resources?.limits?.memory).not.toMatch(/m$/);
    }
  });

  test.each([
    ['cpu', { limits: { cpu: 500 }, reservations: { cpu: 1000 } }, 'CPU'],
    ['memory', { limits: { memory: 1024 }, reservations: { memory: 2048 } }, 'memory'],
  ] as const)('a %s reservation above its limit is refused', (_resource, resources, word) => {
    const r = render(canonicalService({ resources }));
    expect(codes(r)).toEqual([['error', 'resources.request-exceeds-limit', 'services.web.deploy.resources']]);
    expect(r.diagnostics[0].message).toBe(`Service web reserves more ${word} than its limit`);
  });
});

// ---------------------------------------------------------------------------
// Placement (design-02 5.10; T-POD-01..07)
// ---------------------------------------------------------------------------

function placed(constraints: ConstraintInput[], overrides: ServiceOverrides = {}): Rendered {
  return render(
    canonicalService({ ...overrides, placement: { ...overrides.placement, constraints: constraints.map((c, i) => constraint(c, i)) } }),
    { options: { serverNames: ['server_1', 'agent_1', 'Worker_2'] } },
  );
}

const CP = 'node-role.kubernetes.io/control-plane';

function nodeTerms(r: Rendered): unknown {
  return r.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
}

describe('placement', () => {
  test('T-POD-01: node.role', () => {
    expect(placed([{ attribute: 'node.role', operator: '==', value: 'manager' }]).spec.nodeSelector).toEqual({ [CP]: 'true' });
    for (const r of [placed([{ attribute: 'node.role', operator: '!=', value: 'manager' }]), placed([{ attribute: 'node.role', operator: '==', value: 'worker' }])]) {
      expect(r.spec.nodeSelector).toBeUndefined();
      expect(nodeTerms(r)).toEqual([{ matchExpressions: [{ key: CP, operator: 'DoesNotExist' }] }]);
      expectValid(r);
    }
    expect(placed([{ attribute: 'node.role', operator: '!=', value: 'worker' }]).spec.nodeSelector).toEqual({ [CP]: 'true' });
  });

  test('T-POD-02: node.hostname goes through nodeNameFor', () => {
    const eq = placed([{ attribute: 'node.hostname', operator: '==', value: 'agent_1' }]);
    expect(eq.spec.nodeSelector).toEqual({ [KUBE_KEYS.hostname]: 'agent-1' });
    expectValid(eq);
    const ne = placed([{ attribute: 'node.hostname', operator: '!=', value: 'Worker_2' }]);
    expect(nodeTerms(ne)).toEqual([{ matchExpressions: [{ key: KUBE_KEYS.hostname, operator: 'NotIn', values: ['worker-2'] }] }]);
    expectValid(ne);
  });

  test('T6: a node.hostname outside serverNames throws', () => {
    expectTranslatorBug(() => placed([{ attribute: 'node.hostname', operator: '==', value: 'ghost' }]), /node\.hostname ghost, which is not a server of the environment$/);
  });

  test('T-POD-03: node labels', () => {
    expect(placed([{ attribute: 'node.labels', key: 'zone', operator: '==', value: 'a' }]).spec.nodeSelector).toEqual({ zone: 'a' });
    expect(nodeTerms(placed([{ attribute: 'node.labels', key: 'zone', operator: '!=', value: 'a' }]))).toEqual([
      { matchExpressions: [{ key: 'zone', operator: 'NotIn', values: ['a'] }] },
    ]);
  });

  test('T-POD-04: platform os and arch, the arch mapped through ARCH', () => {
    const r = placed([
      { attribute: 'node.platform.arch', operator: '==', value: 'x86_64' },
      { attribute: 'node.platform.os', operator: '==', value: 'linux' },
    ]);
    expect(r.spec.nodeSelector).toEqual({ [KUBE_KEYS.arch]: 'amd64', [KUBE_KEYS.os]: 'linux' });
    expect(placed([{ attribute: 'node.platform.arch', operator: '==', value: 'aarch64' }]).spec.nodeSelector).toEqual({ [KUBE_KEYS.arch]: 'arm64' });
    expect(nodeTerms(placed([{ attribute: 'node.platform.arch', operator: '!=', value: 'armv7l' }]))).toEqual([
      { matchExpressions: [{ key: KUBE_KEYS.arch, operator: 'NotIn', values: ['arm'] }] },
    ]);
    expect(nodeTerms(placed([{ attribute: 'node.platform.os', operator: '!=', value: 'windows' }]))).toEqual([
      { matchExpressions: [{ key: KUBE_KEYS.os, operator: 'NotIn', values: ['windows'] }] },
    ]);
  });

  test('T6: an unknown architecture throws', () => {
    expectTranslatorBug(() => placed([{ attribute: 'node.platform.arch', operator: '==', value: 'mips' }]), /unknown architecture mips$/);
  });

  test('!= on one key merge into one NotIn with sorted unique values; expressions sorted by (key, operator)', () => {
    const r = placed([
      { attribute: 'node.labels', key: 'zone', operator: '!=', value: 'b' },
      { attribute: 'node.role', operator: '!=', value: 'manager' },
      { attribute: 'node.labels', key: 'zone', operator: '!=', value: 'a' },
      { attribute: 'node.labels', key: 'zone', operator: '!=', value: 'b' },
      { attribute: 'node.labels', key: 'disk', operator: '!=', value: 'hdd' },
      { attribute: 'node.role', operator: '==', value: 'worker' },
    ]);
    expect(errors(r)).toEqual([]);
    expect(nodeTerms(r)).toEqual([
      {
        matchExpressions: [
          { key: 'disk', operator: 'NotIn', values: ['hdd'] },
          { key: CP, operator: 'DoesNotExist' },
          { key: 'zone', operator: 'NotIn', values: ['a', 'b'] },
        ],
      },
    ]);
    expectValid(r);
  });

  test('x-dockflow.node_selector merges with the constraints', () => {
    const r = placed([{ attribute: 'node.labels', key: 'zone', operator: '==', value: 'a' }], { extension: { nodeSelector: { disk: 'ssd' } } });
    expect(r.spec.nodeSelector).toEqual({ disk: 'ssd', zone: 'a' });
    expectValid(r);
  });

  test.each([
    [
      'two values for one key',
      [
        { attribute: 'node.labels', key: 'zone', operator: '==', value: 'a' },
        { attribute: 'node.labels', key: 'zone', operator: '==', value: 'b' },
      ],
      'node.labels.zone == b',
      'node.labels.zone == a',
    ],
    [
      '== X with != X',
      [
        { attribute: 'node.labels', key: 'zone', operator: '!=', value: 'a' },
        { attribute: 'node.labels', key: 'zone', operator: '==', value: 'a' },
      ],
      'node.labels.zone == a',
      'node.labels.zone != a',
    ],
    [
      'manager and not manager',
      [
        { attribute: 'node.role', operator: '==', value: 'manager' },
        { attribute: 'node.role', operator: '==', value: 'worker' },
      ],
      'node.role == worker',
      'node.role == manager',
    ],
  ] as [string, ConstraintInput[], string, string][])('placement.conflict: %s', (_title, constraints, text, other) => {
    const r = placed(constraints);
    expect(codes(r)).toEqual([['error', 'placement.conflict', 'services.web.deploy.placement.constraints[1]']]);
    expect(r.diagnostics[0].message).toBe(`Constraint ${text} of service web contradicts ${other}`);
  });

  test('placement.conflict against x-dockflow.node_selector', () => {
    const r = placed([{ attribute: 'node.labels', key: 'disk', operator: '==', value: 'hdd' }], { extension: { nodeSelector: { disk: 'ssd' } } });
    expect(codes(r)).toEqual([['error', 'placement.conflict', 'services.web.deploy.placement.constraints[0]']]);
    expect(r.diagnostics[0].message).toBe('Constraint node.labels.disk == hdd of service web contradicts x-dockflow.node_selector.disk: ssd');
  });

  test('T-POD-05: spread constraints follow the implicit hostname one, deduplicated by topology key', () => {
    const r = checked(canonicalService({ placement: { spreadLabels: ['zone', 'rack', 'zone', 'kubernetes.io/hostname'] } }));
    const matchLabels = selectorLabels(r.ctx.stack.identity, 'web');
    const entry = (topologyKey: string) => ({ labelSelector: { matchLabels }, matchLabelKeys: ['pod-template-hash'], maxSkew: 1, topologyKey, whenUnsatisfiable: 'ScheduleAnyway' as const });
    expect(r.spec.topologySpreadConstraints).toEqual([entry('kubernetes.io/hostname'), entry('zone'), entry('rack')]);
  });

  test('the implicit spread is the same for every replica count', () => {
    const one = checked(canonicalService({ replicas: 1 }));
    const three = checked(canonicalService({ replicas: 3 }));
    const zero = checked(canonicalService({ replicas: 0 }));
    expect(canonicalJson(one.template)).toBe(canonicalJson(three.template));
    expect(canonicalJson(one.template)).toBe(canonicalJson(zero.template));
  });

  test('StatefulSets spread without matchLabelKeys; Jobs have no implicit spread', () => {
    const sts = checked(canonicalService({ extension: { kind: 'statefulset' }, placement: { spreadLabels: ['zone'] } }));
    expect(sts.spec.topologySpreadConstraints?.map((c) => [c.topologyKey, 'matchLabelKeys' in c])).toEqual([
      ['kubernetes.io/hostname', false],
      ['zone', false],
    ]);
    const job = checked(canonicalService({ mode: 'replicated-job', placement: { spreadLabels: ['zone'] } }));
    expect(job.spec.topologySpreadConstraints?.map((c) => [c.topologyKey, 'matchLabelKeys' in c])).toEqual([['zone', false]]);
    expect(checked(canonicalService({ mode: 'replicated-job' })).spec.topologySpreadConstraints).toBeUndefined();
  });

  test('global services: no spread, no per-node cap, placement.global-ignored', () => {
    const r = render(canonicalService({ mode: 'global', placement: { spreadLabels: ['zone'], maxReplicasPerNode: 1 } }));
    expect(r.spec.topologySpreadConstraints).toBeUndefined();
    expect(r.spec.affinity).toBeUndefined();
    expect(codes(r)).toEqual([['warning', 'placement.global-ignored', 'services.web.deploy.placement']]);
    expectValid(r);
    expect(checked(canonicalService({ mode: 'global' })).spec.topologySpreadConstraints).toBeUndefined();
  });

  test('T-POD-06: max_replicas_per_node 1 is a required anti-affinity; more is approximated by spreading', () => {
    const one = checked(canonicalService({ replicas: 3, placement: { maxReplicasPerNode: 1 } }));
    expect(one.spec.affinity).toEqual({
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          { labelSelector: { matchLabels: selectorLabels(one.ctx.stack.identity, 'web') }, matchLabelKeys: ['pod-template-hash'], topologyKey: 'kubernetes.io/hostname' },
        ],
      },
    });
    const sts = checked(canonicalService({ extension: { kind: 'statefulset' }, placement: { maxReplicasPerNode: 1 } }));
    expect(sts.spec.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.[0].matchLabelKeys).toBeUndefined();
    const two = render(canonicalService({ placement: { maxReplicasPerNode: 2 } }));
    expect(two.spec.affinity).toBeUndefined();
    expect(codes(two)).toEqual([['warning', 'placement.max-replicas-approximate', 'services.web.deploy.placement.max_replicas_per_node']]);
    expect(two.diagnostics[0].message).toBe('max_replicas_per_node: 2 of service web cannot be enforced; replicas are spread across nodes instead');
  });

  test('T-POD-07: tolerations in declaration order, Equal omitted, tolerationSeconds only with NoExecute', () => {
    const r = checked(
      canonicalService({
        extension: {
          tolerations: [
            { key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoSchedule', tolerationSeconds: null },
            { key: null, operator: 'Exists', value: null, effect: null, tolerationSeconds: null },
            { key: 'node.kubernetes.io/unreachable', operator: 'Exists', value: null, effect: 'NoExecute', tolerationSeconds: 30 },
            { key: 'maintenance', operator: 'Exists', value: null, effect: 'PreferNoSchedule', tolerationSeconds: 60 },
          ],
        },
      }),
    );
    expect(r.spec.tolerations).toEqual([
      { key: 'dedicated', value: 'db', effect: 'NoSchedule' },
      { operator: 'Exists' },
      { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 30 },
      { key: 'maintenance', operator: 'Exists', effect: 'PreferNoSchedule' },
    ]);
  });

  test('node affinity and pod anti-affinity share one affinity object', () => {
    const r = placed([{ attribute: 'node.role', operator: '!=', value: 'manager' }], { replicas: 2, placement: { maxReplicasPerNode: 1 } });
    expect(Object.keys(r.spec.affinity ?? {}).sort()).toEqual(['nodeAffinity', 'podAntiAffinity']);
    expectValid(r);
  });
});

// ---------------------------------------------------------------------------
// DNS, hosts, hostname (design-02 5.11; T-NET-01..05)
// ---------------------------------------------------------------------------

describe('DNS, hosts and hostname', () => {
  test('T-NET-01: extra_hosts grouped by ip (code-unit order), hostnames lowercased, sorted and unique', () => {
    const r = checked(
      canonicalService({
        network: {
          extraHosts: [
            { hostname: 'db.internal', ip: '10.0.0.20' },
            { hostname: 'Registry.Internal', ip: '10.0.0.20' },
            { hostname: 'a.internal', ip: '10.0.0.3' },
            { hostname: 'registry.internal', ip: '10.0.0.20' },
          ],
        },
      }),
    );
    expect(r.spec.hostAliases).toEqual([
      { ip: '10.0.0.20', hostnames: ['db.internal', 'registry.internal'] },
      { ip: '10.0.0.3', hostnames: ['a.internal'] },
    ]);
  });

  test('T-NET-02: search domains and options (last value wins, first position kept); dnsPolicy unchanged', () => {
    const r = checked(canonicalService({ network: { dnsSearch: ['corp.example', 'example.com'], dnsOptions: ['ndots:2', 'use-vc', 'ndots:3', 'timeout:1'] } }));
    expect(r.spec.dnsConfig).toEqual({
      searches: ['corp.example', 'example.com'],
      options: [{ name: 'ndots', value: '3' }, { name: 'use-vc' }, { name: 'timeout', value: '1' }],
    });
    expect(r.spec.dnsPolicy).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  test('T-NET-03: nameservers are appended to cluster DNS verbatim, never truncated, with a warning', () => {
    const r = render(canonicalService({ network: { dns: ['9.9.9.9', '1.1.1.1'] } }));
    expect(r.spec.dnsConfig).toEqual({ nameservers: ['9.9.9.9', '1.1.1.1'] });
    expect(r.spec.dnsPolicy).toBeUndefined();
    expect(codes(r)).toEqual([['warning', 'network.dns-secondary', 'services.web.dns']]);
    expectValid(r);
  });

  test('T6: more nameservers than the cluster DNS leaves room for throws; the room follows the trait', () => {
    const three = canonicalService({ network: { dns: ['1.1.1.1', '8.8.8.8', '9.9.9.9'] } });
    expectTranslatorBug(() => render(three), /with 3 nameservers, more than the 2 that fit next to the cluster DNS$/);
    expect(render(three, { options: { traits: { clusterDnsNameservers: 0 } } }).spec.dnsConfig?.nameservers).toHaveLength(3);
  });

  test('no DNS settings: no dnsConfig', () => {
    expect(checked(canonicalService()).spec.dnsConfig).toBeUndefined();
  });

  test('T-NET-05: hostname', () => {
    expect(checked(canonicalService({ process: { hostname: 'api' } })).spec.hostname).toBe('api');
  });

  test('hostname is dropped with the node network', () => {
    const r = render(canonicalService({ process: { hostname: 'api' }, network: { hostNetwork: true } }));
    expect(r.spec.hostname).toBeUndefined();
    expect(codes(r)).toEqual([
      ['warning', 'network.hostname-host-network', 'services.web.hostname'],
      ['warning', 'network.host-network', 'services.web.network_mode'],
    ]);
  });

  test('hostname is dropped on a StatefulSet', () => {
    const r = render(canonicalService({ process: { hostname: 'queue' }, extension: { kind: 'statefulset' } }));
    expect(r.spec.hostname).toBeUndefined();
    expect(codes(r)).toEqual([['warning', 'network.hostname-statefulset', 'services.web.hostname']]);
    expect(r.diagnostics[0].message).toBe('hostname of StatefulSet service web is ignored; each replica is named after its pod');
    expectValid(r);
  });
});

// ---------------------------------------------------------------------------
// Workload kinds end to end
// ---------------------------------------------------------------------------

describe('every workload kind validates', () => {
  test('a service with every section set validates as each kind', () => {
    const secret = canonicalFileSource();
    const data = canonicalVolume();
    const base = {
      process: { entrypoint: ['/app'], command: ['--port', '$(PORT)'], workingDir: '/srv', user: { uid: 1000, gid: 1000 }, groupAdd: [10], preStop: ['sleep', '5'] },
      expose: [{ target: 3000, protocol: 'TCP' as const, path: 'services.web.expose[0]' }],
      mounts: [bind({ readOnly: true }), tmpfs(), anonymous()] as (BindMountSpec | TmpfsMountSpec | AnonymousMountSpec)[],
      files: [fileMount()],
      healthcheck: {
        test: { type: 'shell' as const, command: 'wget -qO- http://127.0.0.1:3000/health || exit 1' },
        intervalMs: 10_000,
        timeoutMs: 3_000,
        retries: 5,
        startPeriodMs: 40_000,
        startIntervalMs: 5_000,
        path: 'services.web.healthcheck',
      },
      resources: { limits: { cpu: 500, memory: 512 * 1024 ** 2 } },
      security: { capDrop: ['ALL'], noNewPrivileges: true, sysctls: { 'net.ipv4.ip_local_port_range': '1024 65000' } },
      network: { dns: ['1.1.1.1'], dnsSearch: ['corp.example'], extraHosts: [{ hostname: 'db.internal', ip: '10.0.0.20' }] },
      extension: { tolerations: [{ key: 'dedicated', operator: 'Equal' as const, value: 'web', effect: 'NoSchedule' as const, tolerationSeconds: null }], fsGroup: 1000 },
      placement: { spreadLabels: ['zone'], constraints: [constraint({ attribute: 'node.role', operator: '!=', value: 'manager' })] },
    };
    const kinds = [
      canonicalService({ ...base, replicas: 2 }),
      canonicalService({ ...base, extension: { ...base.extension, kind: 'statefulset' }, mounts: [...base.mounts, volumeMount()] }),
      canonicalService({ ...base, mode: 'global' }),
      canonicalService({ ...base, mode: 'replicated-job', replicas: 2 }),
    ];
    for (const svc of kinds) {
      const volumes = svc.workloadKind === 'StatefulSet' ? [canonicalVolume({ perReplica: true })] : [data];
      const r = render(svc, { files: [secret], volumes, options: { pullSecretName: 'dockflow-registry' } });
      expect(errors(r)).toEqual([]);
      expectValid(r);
    }
  });
});

// ---------------------------------------------------------------------------
// support/k8s-expand.ts (kubelet expansion reference)
// ---------------------------------------------------------------------------

describe('k8sExpand (kubelet $(VAR) expansion)', () => {
  test.each([
    ['$$', {}, '$'],
    ['$$$$', {}, '$$'],
    ['$(A)', { A: 'x' }, 'x'],
    ['$(A)', {}, '$(A)'],
    ['$(A)$(B)', { A: '1', B: '2' }, '12'],
    ['$HOME', { HOME: '/root' }, '$HOME'],
    ['cost $5', {}, 'cost $5'],
    ['trailing $', {}, 'trailing $'],
    ['$(', {}, '$('],
    ['a$(B', { B: 'x' }, 'a$(B'],
    ['$()', {}, '$()'],
    ['$$(A)', { A: 'x' }, '$(A)'],
    ['no dollar', {}, 'no dollar'],
    ['', {}, ''],
  ] as const)('%p with %p -> %p', (input, env, expected) => {
    expect(k8sExpand(input, env)).toBe(expected);
  });

  test('arrays expand element by element', () => {
    expect(k8sExpand(['$(A)', '$$'], { A: 'a' })).toEqual(['a', '$']);
  });
});
