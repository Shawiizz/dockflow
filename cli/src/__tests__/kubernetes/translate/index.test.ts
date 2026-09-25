import { afterEach, describe, expect, test } from 'bun:test';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { CanonicalService, PortSpec, VolumeMountSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { isNormalizeCode } from '../../../services/orchestrator/kubernetes/normalize/keys';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { isTranslatorCode } from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import { emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson } from '../../../utils/hash';
import { canonicalFileSource, canonicalService, canonicalStack, canonicalVolume, proxyIntent, type StackOverrides } from '../support/builders';
import { runTranslateRows, translateRow } from '../support/rows';
import { translateChecked } from '../support/translate';

function port(service: string, published: number | null, target = 80, index = 0): PortSpec {
  return { target, published, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path: `services.${service}.ports[${index}]` };
}

function volumeMount(service: string, volume: string, target: string): VolumeMountSpec {
  return { type: 'volume', volume, target, readOnly: false, subpath: null, path: `services.${service}.volumes[0]` };
}

function keys(objects: readonly ManifestObject[]): string[] {
  return objects.map((o) => `${o.kind}/${o.metadata.name}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function find<K extends ManifestObject['kind']>(objects: readonly ManifestObject[], kind: K, name: string): Extract<ManifestObject, { kind: K }> {
  const found = objects.find((o) => o.kind === kind && o.metadata.name === name);
  if (found === undefined) throw new Error(`${kind}/${name} was not rendered`);
  return found as Extract<ManifestObject, { kind: K }>;
}

function expectBug(run: () => unknown, fragment: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeployError);
  const error = caught as DeployError;
  expect(error.message).toContain(fragment);
  expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
  expect(error.suggestion).toBe('Report this as a Dockflow bug.');
}

/** web (env, secret, published port), db (StatefulSet with a per-replica volume), a pulled worker and a Job. */
function composedStack(overrides: StackOverrides = {}): StackOverrides {
  return {
    services: [
      canonicalService({
        composeName: 'web',
        environment: [{ name: 'MODE', value: 'production' }],
        ports: [port('web', 8080)],
        files: [{ kind: 'secret', source: 'api_key', target: '/run/secrets/api_key', mode: 0o444, uid: null, gid: null, path: 'services.web.secrets[0]' }],
      }),
      canonicalService({ composeName: 'db', extension: { kind: 'statefulset' }, mounts: [volumeMount('db', 'data', '/var/lib/data')] }),
      canonicalService({ composeName: 'migrate', mode: 'replicated-job' }),
    ],
    volumes: [canonicalVolume({ key: 'data', perReplica: true, usedBy: ['db'] })],
    files: [canonicalFileSource()],
    ...overrides,
  };
}

describe('translateStack composition (design-02 1.1)', () => {
  test('each module result reaches the next: env Secret into the pod, claim templates into the StatefulSet', () => {
    const { objects, diagnostics } = translateChecked(canonicalStack(composedStack()));
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const envSecret = objects.find((o) => o.kind === 'Secret' && o.metadata.name.startsWith('web-env-'));
    const fileSecret = objects.find((o) => o.kind === 'Secret' && o.metadata.name.startsWith('api-key-secret-'));
    expect(envSecret).toBeDefined();
    expect(fileSecret).toBeDefined();
    const job = objects.find((o) => o.kind === 'Job');
    expect(keys(objects)).toEqual(
      [
        `${job?.kind}/${job?.metadata.name}`,
        `Secret/${envSecret?.metadata.name}`,
        `Secret/${fileSecret?.metadata.name}`,
        'Deployment/web',
        'Service/db',
        'Service/db-hl',
        'Service/migrate',
        'Service/web',
        'Service/web-lb',
        'StatefulSet/db',
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );

    const web = find(objects, 'Deployment', 'web') as Deployment;
    expect(web.spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: envSecret?.metadata.name ?? '' } }]);
    const db = find(objects, 'StatefulSet', 'db') as StatefulSet;
    expect(db.spec.volumeClaimTemplates?.map((t) => t.metadata.name)).toEqual(['data']);
    // a per-replica volume is claimed by the StatefulSet's templates, never by a standalone claim
    expect(objects.filter((o) => o.kind === 'PersistentVolumeClaim')).toEqual([]);
  });

  test('a Job with 0 replicas is not created', () => {
    const stack = canonicalStack({ services: [canonicalService({ composeName: 'migrate', mode: 'replicated-job', replicas: 0 })] });
    // design-02 4.6/6.1 keep the Service of a Job that is not created: no workload is emitted
    const { objects, diagnostics } = translateChecked(stack);
    expect(objects.filter((o) => o.kind === 'Job')).toEqual([]);
    expect(objects.some((o) => o.kind === 'Service' && o.metadata.name === 'migrate')).toBe(true);
    expect(diagnostics.map((d) => [d.severity, d.code, d.path])).toEqual([['info', 'deploy.job-zero-replicas', 'services.migrate.deploy.replicas']]);
  });

  test('the order of the stack services changes nothing: two translations emit the same bytes', () => {
    const stack = canonicalStack(composedStack());
    const reversed = { ...stack, services: [...stack.services].reverse() };
    const header = { format: 'k8s-manifests/1' as const, stackName: 'shop-production', role: 'app' as const, version: '1.4.2' };
    const first = translateChecked(stack);
    const second = translateChecked(stack);
    const third = translateChecked(reversed);
    const text = emitManifests(first.objects, header);
    expect(emitManifests(second.objects, header)).toBe(text);
    expect(emitManifests(third.objects, header)).toBe(text);
    expect(third.diagnostics).toEqual(first.diagnostics);
  });

  test('objects of either role do not depend on the release version', () => {
    const accessory = (version: string): string =>
      canonicalJson(translateChecked(canonicalStack({ role: 'accessory', identity: { version }, services: [canonicalService({ role: 'accessory', composeName: 'db' })] })).objects);
    expect(accessory('2.0.0')).toBe(accessory('1.0.0'));

    const app = (version: string): string => canonicalJson(translateChecked(canonicalStack({ identity: { version } })).objects);
    expect(app('2.0.0')).toBe(app('1.0.0'));
  });
});

describe('diagnostics (DESIGN-CORE 8.2, design-02 11)', () => {
  const proto = DiagnosticSink.prototype;
  const originals = { error: proto.error, warn: proto.warn, info: proto.info };
  afterEach(() => {
    Object.assign(proto, originals);
  });

  /** Records every sink a report went to while `run` executes. */
  function recordSinks(run: () => void): Set<DiagnosticSink> {
    const sinks = new Set<DiagnosticSink>();
    for (const name of ['error', 'warn', 'info'] as const) {
      const original = originals[name];
      proto[name] = function (this: DiagnosticSink, ...args: Parameters<DiagnosticSink['error']>): void {
        sinks.add(this);
        original.apply(this, args);
      };
    }
    run();
    Object.assign(proto, originals);
    return sinks;
  }

  /** privileged, node network, an unpublished port and init: translator-owned conditions only */
  function noisy(): CanonicalService[] {
    return [
      canonicalService({ composeName: 'web', security: { privileged: true }, ports: [port('web', null, 3000)] }),
      canonicalService({ composeName: 'agent', network: { hostNetwork: true }, process: { init: true } }),
    ];
  }

  test('every report goes to options.sink; the translator creates no sink of its own', () => {
    const sink = new DiagnosticSink();
    let diagnostics: Diagnostic[] = [];
    const sinks = recordSinks(() => {
      diagnostics = translateChecked(canonicalStack({ services: noisy() }), { sink }).diagnostics;
    });
    expect(diagnostics.length).toBeGreaterThan(2);
    expect([...sinks]).toEqual([sink]);
  });

  test('every code the translator emits is in TRANSLATOR_CODES and none is a normalizer code', () => {
    const { diagnostics } = translateChecked(canonicalStack({ services: noisy() }));
    const codes = [...new Set(diagnostics.map((d) => d.code))].sort();
    expect(codes).toEqual(['network.host-network', 'ports.no-published-port', 'process.init-shared-pid', 'security.privileged', 'update.surge-disabled']);
    for (const code of codes) expect(`${code} ${isTranslatorCode(code)} ${isNormalizeCode(code)}`).toBe(`${code} true false`);
  });
});

describe('defensive re-checks throw (U-DIAG-05, T6)', () => {
  test('an empty command or entrypoint throws instead of reporting process.empty-command', () => {
    const sink = new DiagnosticSink();
    expectBug(
      () => translateChecked(canonicalStack({ services: [canonicalService({ process: { command: [] } })] }), { sink }),
      'Service web reached the translator with an empty command',
    );
    expect(sink.list().filter((d) => d.code === 'process.empty-command')).toEqual([]);
    expectBug(
      () => translateChecked(canonicalStack({ services: [canonicalService({ process: { entrypoint: [] } })] })),
      'Service web reached the translator with an empty entrypoint',
    );
  });

  test('a route reaching the translator with the proxy disabled throws', () => {
    const route = { router: 'api', rule: 'Host(`api.example.com`)', entryPoints: ['websecure'], tls: null, middlewares: [], priority: null, port: 80, origin: 'labels' as const, path: 'services.web.labels["traefik.http.routers.api.rule"]' };
    expectBug(
      () => translateChecked(canonicalStack({ proxy: null, services: [canonicalService({ routes: [route], ports: [port('web', null)] })] })),
      'reached the translator with the proxy disabled',
    );
    // the same route is translated once the proxy exists
    const { objects } = translateChecked(canonicalStack({ proxy: proxyIntent(), services: [canonicalService({ routes: [route], ports: [port('web', null)] })] }));
    expect(objects.some((o) => o.kind === 'IngressRoute')).toBe(true);
  });

  test('a node.hostname outside serverNames throws', () => {
    const constraint = { attribute: 'node.hostname' as const, operator: '==' as const, value: 'ghost', path: 'services.web.deploy.placement.constraints[0]' };
    expectBug(
      () => translateChecked(canonicalStack({ services: [canonicalService({ placement: { constraints: [constraint] } })] })),
      'node.hostname ghost, which is not a server of the environment',
    );
  });

  test('an environment name that is not a Secret key throws', () => {
    expectBug(
      () => translateChecked(canonicalStack({ services: [canonicalService({ environment: [{ name: 'A B', value: 'x' }] })] })),
      'is not a valid Secret key',
    );
  });
});

describe('object keys are unique (design-02 1.1)', () => {
  test('two services rendering one (kind, name) throw', () => {
    const web = canonicalService({ composeName: 'web' });
    const twin = canonicalService({ composeName: 'Web', name: 'web', path: 'services.Web' });
    expectBug(() => translateChecked(canonicalStack({ services: [web, twin] })), 'The render produced Deployment/web twice');
  });

  test('an alias equal to another service name throws', () => {
    const web = canonicalService({ composeName: 'web', network: { aliases: ['api'] } });
    const api = canonicalService({ composeName: 'api' });
    expectBug(() => translateChecked(canonicalStack({ services: [api, web] })), 'The render produced Service/api twice');
  });
});

describe('translator rows (design-07 5.1)', () => {
  test('a row gives exactly one of compose and stack', () => {
    expect(() => translateRow({ id: 'T-SUPPORT-X', title: 'neither', expect: { kinds: [] } })).toThrow('give exactly one of compose and stack');
  });

  test('a compose row shares one sink between the two layers, as render() does', () => {
    const { diagnostics } = translateRow({ id: 'T-SUPPORT-Y', title: 'both layers', compose: 'image: nginx:1.27\nports: ["3000"]\ntty: yes', expect: { kinds: [] } });
    expect(diagnostics.map((d) => d.code)).toEqual(['ports.no-published-port', 'values.yaml11-boolean']);
  });
});

runTranslateRows('runTranslateRows (design-07 5.1)', [
  {
    id: 'T-SUPPORT-01',
    title: 'a compose row: kinds and diagnostics of both layers',
    compose: 'image: nginx:1.27\nports: ["3000"]\ntty: yes',
    expect: [
      { kinds: ['Deployment/web', 'Service/web'] },
      {
        diagnostics: [
          { severity: 'warning', code: 'values.yaml11-boolean', path: 'services.web.tty' },
          { severity: 'warning', code: 'ports.no-published-port', path: 'services.web.ports[0]' },
        ],
      },
    ],
  },
  {
    id: 'T-SUPPORT-02',
    title: 'a builder row: pointers and absent objects',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ replicas: 3 })] }),
    expect: [
      { object: 'Deployment/web', pointer: '/spec/replicas', equals: 3 },
      { object: 'Deployment/web', pointer: '/spec/template/spec/hostNetwork', absent: true },
      { object: 'Service/web-lb', absent: true },
    ],
  },
  {
    id: 'T-SUPPORT-03',
    title: 'options reach the translator',
    stack: (b) => b.canonicalStack(),
    options: { revisionHistoryLimit: 7 },
    expect: { object: 'Deployment/web', pointer: '/spec/revisionHistoryLimit', equals: 7 },
  },
  {
    id: 'T-SUPPORT-04',
    title: 'a normalizer error stops the row before the translator',
    compose: 'image: Nginx',
    expect: [{ kinds: [] }, { diagnostics: [{ severity: 'error', code: 'image.invalid-reference', path: 'services.web.image' }], exact: true }],
  },
]);
