import { describe, expect, test } from 'bun:test';
import { injectAccessoriesDefaults, loadFromString, type ParsedCompose, syncNonTargetedImageTags } from '../../../services/compose';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { importedImageRef } from '../../../services/orchestrator/kubernetes/naming';
import { DOCKER_UPDATE_DEFAULTS, DOCKFLOW_UPDATE_DEFAULTS } from '../../../services/orchestrator/kubernetes/normalize/context';
import { normalizeStack } from '../../../services/orchestrator/kubernetes/normalize';
import { COMPOSE_SPEC_PIN } from '../../../services/orchestrator/kubernetes/normalize/keys';
import { renderStackArtifact } from '../../../services/orchestrator/kubernetes/render';
import { canonicalJson } from '../../../utils/hash';
import { ConfigError } from '../../../utils/errors';
import { deployInput, normalizeInput, traits } from '../support/builders';
import { canonicalStackViolations, expectRowDiagnostics, jsonPointer, normalizeChecked } from '../support/normalize';
import { runNormalizeRows } from '../support/rows';

/** A compose document from its lines, loaded through the real loader (YAML-* rows). */
function load(...lines: string[]): ParsedCompose {
  return loadFromString(`${lines.join('\n')}\n`, 'docker-compose.yml');
}

function loadError(...lines: string[]): ConfigError {
  try {
    load(...lines);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('the document loaded without error');
}

/** A document built by hand, bypassing the loader (values the loader would never produce). */
function handBuilt(raw: Record<string, unknown>): ParsedCompose {
  return { raw, services: (raw.services ?? {}) as ParsedCompose['services'] };
}

function at(diagnostics: readonly Diagnostic[], code: string): Diagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

describe('YAML level through Compose.loadFromString (design-01 2.1)', () => {
  test('YAML-01 an anchor under an x- key is copied into the service that aliases it', () => {
    const { stack } = normalizeChecked({ compose: load('x-base: &a {image: nginx}', 'services:', '  web: *a') });
    expect(stack.services[0].image.composeRef).toBe('nginx');
  });

  test('YAML-02 an alias without an anchor is refused at load', () => {
    expect(loadError('services:', '  web: *nope').message).toContain('unresolved alias *nope');
  });

  test('YAML-03 a merge key copies the other keys; an explicit key wins', () => {
    const { stack } = normalizeChecked({
      compose: load(
        'x-base: &base',
        '  image: nginx:1.26',
        '  environment: {MODE: base}',
        'services:',
        '  web:',
        '    <<: *base',
        '    image: nginx:1.27',
      ),
    });
    expect(stack.services[0].image.composeRef).toBe('nginx:1.27');
    expect(stack.services[0].environment).toEqual([{ name: 'MODE', value: 'base' }]);
  });

  test('YAML-04 with a sequence of merges, the first map that defines a key wins', () => {
    const { stack } = normalizeChecked({
      compose: load('x-a: &a {image: "nginx:1.27"}', 'x-b: &b {image: "httpd:2.4"}', 'services:', '  web:', '    <<: [*a, *b]'),
    });
    expect(stack.services[0].image.composeRef).toBe('nginx:1.27');
  });

  test('YAML-05 a duplicate key is refused at load with its line', () => {
    expect(loadError('services:', '  web:', '    image: a', '    image: b').message).toBe('docker-compose.yml: duplicate key image at line 4');
  });

  test('YAML-06 several documents are refused at load', () => {
    expect(loadError('services: {}', '---', 'services: {}').message).toContain('several YAML documents');
  });

  test('YAML-07 Compose merge tags are refused at load', () => {
    const error = loadError('services:', '  web:', '    image: nginx:1.27', '    ports: !reset []');
    expect(error.message).toContain('tag !reset at line 4 is only meaningful in Compose override files');
    expect(error.suggestion).toBe('Remove the tag and write the final value.');
  });

  test('YAML-08 other tags are refused at load; a non-plain value reaching the normalizer is yaml.unsupported-value', () => {
    expect(loadError('services:', '  web:', '    image: nginx:1.27', '    labels: !!binary aGk=').message).toContain('unsupported YAML tag !!binary');

    const { stack, diagnostics } = normalizeChecked({
      compose: handBuilt({
        services: {
          web: {
            image: 'nginx:1.27',
            labels: new Uint8Array([104, 105]),
            annotations: new Map([['a', 'b']]),
            group_add: new Set([1]),
            stop_grace_period: new Date(0),
          },
        },
      }),
    });
    const unsupported = at(diagnostics, 'yaml.unsupported-value');
    expect(unsupported.map((d) => [d.path, d.message])).toEqual([
      ['services.web.annotations', 'value of type Map is not supported'],
      ['services.web.group_add', 'value of type Set is not supported'],
      ['services.web.labels', 'value of type Uint8Array is not supported'],
      ['services.web.stop_grace_period', 'value of type Date is not supported'],
    ]);
    expect(unsupported[0]).toMatchObject({ severity: 'error', hint: 'Write a plain string, number, boolean, list or mapping.' });
    // the refused value is treated as absent: no second diagnostic for the same condition
    expectRowDiagnostics(diagnostics, [{ diagnostics: unsupported.map(({ severity, code, path }) => ({ severity, code, path })) }]);
    expect(stack.services[0].containerLabels).toEqual({});
  });

  test('YAML-09 core schema tags are plain values', () => {
    const { stack } = normalizeChecked({ compose: load('services:', '  web:', '    image: nginx:1.27', '    deploy:', '      replicas: !!int "3"') });
    expect(stack.services[0].replicas).toBe(3);
  });

  test('YAML-10 a number written in an environment map keeps its source text', () => {
    const { stack } = normalizeChecked({ compose: load('services:', '  web:', '    image: nginx:1.27', '    environment: {PORT: 010}') });
    expect(stack.services[0].environment).toEqual([{ name: 'PORT', value: '010' }]);
  });

  test('YAML-11 floats and booleans keep their source text; null unsets the variable', () => {
    const { stack } = normalizeChecked({
      compose: load('services:', '  web:', '    image: nginx:1.27', '    environment: {V: 1.10, B: true, N: ~}'),
    });
    expect(stack.services[0].environment).toEqual([
      { name: 'B', value: 'true' },
      { name: 'V', value: '1.10' },
    ]);
  });

  test('YAML-12 an octal file mode is read in base 8', () => {
    const { stack } = normalizeChecked({
      compose: load('services:', '  web:', '    image: nginx:1.27', '    secrets: [{source: s, mode: 0440}]', 'secrets:', '  s: {file: ./s.txt}'),
      files: { 's.txt': 'value' },
    });
    expect(stack.services[0].files[0].mode).toBe(288);
  });

  test('YAML-13 a non-finite number is yaml.unsupported-value, reported once', () => {
    const { diagnostics } = normalizeChecked({ compose: load('services:', '  web:', '    image: nginx:1.27', '    cpus: .inf') });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [{ severity: 'error', code: 'yaml.unsupported-value', path: 'services.web.cpus' }] }]);
    expect(at(diagnostics, 'yaml.unsupported-value')[0].message).toBe('value of type number (Infinity) is not supported');

    const nan = normalizeChecked({ compose: handBuilt({ services: { web: { image: 'nginx:1.27', cpus: Number.NaN } } }) });
    expect(at(nan.diagnostics, 'yaml.unsupported-value')[0].message).toBe('value of type number (NaN) is not supported');
  });

  test('YAML-14 a YAML 1.1 boolean word is read with a warning', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: load('services:', '  web:', '    image: nginx:1.27', '    tty: yes') });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [{ severity: 'warning', code: 'values.yaml11-boolean', path: 'services.web.tty' }] }]);
    expect(stack.services[0].process.tty).toBe(true);
  });

  test('YAML-15 an empty file, services: ~ or no services key is a stack without services', () => {
    for (const compose of [load(''), load('services:'), load('volumes: {}')]) {
      const { stack, diagnostics } = normalizeChecked({ compose });
      expect(stack.services).toEqual([]);
      expectRowDiagnostics(diagnostics, [{ diagnostics: [], exact: true }]);
    }
  });

  test('YAML-16 the string-typed maps of x-dockflow keep their source text', () => {
    const { stack, diagnostics } = normalizeChecked({
      compose: load(
        'services:',
        '  web:',
        '    image: nginx:1.27',
        '    x-dockflow:',
        '      node_selector: {ssd: true}',
        '      pod_labels: {tier: 1}',
        '      tolerations: [{key: a, value: 2, effect: NoSchedule}]',
      ),
    });
    expect(at(diagnostics, 'extension.invalid')).toEqual([]);
    const { extension } = stack.services[0];
    expect(extension.nodeSelector).toEqual({ ssd: 'true' });
    expect(extension.podLabels).toEqual({ tier: '1' });
    expect(extension.tolerations[0].value).toBe('2');
  });

  test('a document that is not a mapping is yaml.not-a-mapping and an empty stack', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: { raw: [] as unknown as Record<string, unknown>, services: {} } });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'yaml.not-a-mapping',
        path: '',
        message: 'the compose file must be a mapping with a services key',
        hint: 'Start the file with `services:`.',
      },
    ]);
    expect(stack.services).toEqual([]);
  });

  test('top-level x- subtrees are anchor holders: never checked, walked or interpolated', () => {
    const { diagnostics } = normalizeChecked({
      compose: handBuilt({ 'x-common': { cpus: Number.POSITIVE_INFINITY, image: '$UNSET', bogus: 1 }, services: { web: { image: 'nginx:1.27' } } }),
    });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [], exact: true }]);
  });
});

describe('top-level keys (design-01 3)', () => {
  test('TOP-01 version is obsolete: info only', () => {
    const { diagnostics } = normalizeChecked({ compose: load('version: "3.8"', 'services:', '  web: {image: nginx:1.27}') });
    expect(diagnostics).toEqual([{ severity: 'info', code: 'keys.version-ignored', path: 'version', message: 'version is obsolete and ignored' }]);
  });

  test('TOP-02 name is ignored with a warning naming the stack and the namespace', () => {
    const { diagnostics } = normalizeChecked({ compose: load('name: shop', 'services:', '  web: {image: nginx:1.27}') });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'keys.name-ignored',
        path: 'name',
        message: 'name is ignored: the stack is always named shop-production and deployed to namespace dockflow-shop-production',
        hint: 'Remove `name`; `project_name` and the environment decide the names.',
      },
    ]);
  });

  test('TOP-03 include is refused', () => {
    const { diagnostics } = normalizeChecked({ compose: load('include: [a.yml]', 'services:', '  web: {image: nginx:1.27}') });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unsupported.include',
        path: 'include',
        message: 'include is not supported: Dockflow deploys a single compose file',
        hint: 'Inline the included services, or share fragments with a Nunjucks `{% include %}`.',
      },
    ]);
  });

  test('TOP-04 services must be a mapping', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: load('services: []') });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services',
        message: 'expected mapping, got list',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
    expect(stack.services).toEqual([]);
  });

  test('TOP-05 a service key outside [a-zA-Z0-9._-] is refused and the service skipped', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: load('services:', '  "web app": {image: nginx:1.27}', '  api: {image: nginx:1.27}') });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'names.invalid-service-key',
        path: 'services["web app"]',
        message: 'web app is not a valid service name',
        hint: 'Use letters, digits, `.`, `_` and `-` only.',
      },
    ]);
    expect(stack.services.map((s) => s.composeName)).toEqual(['api']);
  });

  test('TOP-06 a service that is null or not a mapping is refused and skipped', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: load('services:', '  web:', '  api: [x]', '  ok: {image: nginx:1.27}') });
    expect(diagnostics).toEqual(
      ['services.api', 'services.web'].map((path) => ({
        severity: 'error',
        code: 'services.not-a-mapping',
        path,
        message: 'must be a mapping',
        hint: 'Declare at least `image:` for the service.',
      })),
    );
    expect(stack.services.map((s) => s.composeName)).toEqual(['ok']);
  });

  test('TOP-07 models is refused', () => {
    const { diagnostics } = normalizeChecked({ compose: load('models: {m: {model: ai/x}}', 'services:', '  web: {image: nginx:1.27}') });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unsupported.models',
        path: 'models',
        message: 'models is not supported on Kubernetes deploys',
        hint: 'Run the model server as a regular service with an image.',
      },
    ]);
  });

  test('TOP-08 jobs is refused as a whole: nothing below it is walked', () => {
    const { diagnostics } = normalizeChecked({
      compose: load('jobs: {j: {image: x, triggers: {manual: true}, bogus: 1}}', 'services:', '  web: {image: nginx:1.27}'),
    });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unsupported.jobs',
        path: 'jobs',
        message: 'jobs is not supported in this Dockflow version',
        hint: 'For a run-to-completion task use a service with `deploy.mode: replicated-job`; scheduled jobs are not supported yet.',
      },
    ]);
  });

  test('TOP-09 an x- anchor holder with an unset variable produces no diagnostic', () => {
    const { diagnostics } = normalizeChecked({ compose: load('x-common: &c {image: "nginx:$VAR"}', 'services:', '  web: {image: nginx:1.27}') });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [], exact: true }]);
  });

  test('TOP-10 a top-level x-dockflow is misplaced', () => {
    const { diagnostics } = normalizeChecked({ compose: load('x-dockflow: {}', 'services:', '  web: {image: nginx:1.27}') });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [{ severity: 'error', code: 'extension.misplaced', path: 'x-dockflow' }], exact: true }]);
  });

  test('TOP-11 an unknown top-level key names the vendor date and suggests the key', () => {
    const { diagnostics } = normalizeChecked({ compose: load('servics: {}', 'services:', '  web: {image: nginx:1.27}') });
    const [unknown] = at(diagnostics, 'keys.unknown');
    expect(unknown.path).toBe('servics');
    expect(unknown.message).toContain(COMPOSE_SPEC_PIN.date);
    expect(unknown.hint?.startsWith('Did you mean `services`?')).toBe(true);
  });

  test('null include, models and jobs are absent', () => {
    const { diagnostics } = normalizeChecked({ compose: load('include:', 'models:', 'jobs:', 'services:', '  web: {image: nginx:1.27}') });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [], exact: true }]);
  });
});

describe('Dockflow-injected keys (design-01 4)', () => {
  const env = { traits: traits(), imageDelivery: 'import' as const, extraReservedHostPorts: [] };

  test('INJ-01 a built app image rewritten by updateImageTags is origin built, without diagnostic', () => {
    const { stack, diagnostics } = normalizeChecked({ compose: load('services:', '  api: {build: ., image: shop-api-production:1.4.2}') });
    expect(stack.services[0].image).toMatchObject({
      origin: 'built',
      composeRef: 'shop-api-production:1.4.2',
      ref: importedImageRef('shop-api-production:1.4.2'),
    });
    expectRowDiagnostics(diagnostics, [{ diagnostics: [] }]);
  });

  test('INJ-02 an image taken from the current release for --only reaches the model like a written one', () => {
    const local = load('services:', '  api: {image: "shop-api:1.4.2"}', '  web: {image: "nginx:1.27"}');
    const current = load('services:', '  api: {image: "shop-api:1.4.1"}', '  web: {image: "nginx:1.26"}');
    const synced = normalizeChecked({ compose: syncNonTargetedImageTags(local, current, ['web']) }).stack;
    const written = normalizeChecked({ compose: load('services:', '  api: {image: "shop-api:1.4.1"}', '  web: {image: "nginx:1.27"}') }).stack;
    expect(canonicalJson(synced.services)).toBe(canonicalJson(written.services));
  });

  test('INJ-03 accessory defaults: replicas 1 without diagnostic, and nothing injected for a global service', () => {
    const compose = load('services:', '  db: {image: "postgres:16"}', '  agent: {image: "busybox:1.36", deploy: {mode: global}}');
    injectAccessoriesDefaults(compose, 'k3s');
    const { stack, diagnostics } = normalizeChecked({ compose, role: 'accessory' });
    expect(stack.services.map((s) => [s.composeName, s.workloadKind, s.replicas])).toEqual([
      ['agent', 'DaemonSet', 1],
      ['db', 'Deployment', 1],
    ]);
    expect(at(diagnostics, 'deploy.replicas-global')).toEqual([]);
    expectRowDiagnostics(diagnostics, [{ diagnostics: [] }]);
  });

  test('INJ-04 restart_policy is warned for written values only (the translator owns the code)', () => {
    const render = (body: string): Diagnostic[] => {
      const compose = load('services:', `  db: {image: "postgres:16"${body}}`);
      injectAccessoriesDefaults(compose, 'k3s');
      return renderStackArtifact(deployInput({ ref: { role: 'accessory' }, compose }), env).artifact.diagnostics;
    };
    expect(at(render(', deploy: {restart_policy: {max_attempts: 3}}'), 'deploy.restart-policy-unsupported').map((d) => [d.severity, d.path])).toEqual([
      ['warning', 'services.db.deploy.restart_policy.max_attempts'],
    ]);
    expect(at(render(''), 'deploy.restart-policy-unsupported')).toEqual([]);
  });

  test('INJ-05 update_config falls back to the defaults of the role, without diagnostic', () => {
    const app = normalizeChecked({ compose: load('services:', '  web: {image: nginx:1.27}') });
    expect(app.stack.services[0].update).toEqual(DOCKFLOW_UPDATE_DEFAULTS);
    expect(app.stack.services[0].update).toMatchObject({ parallelism: 1, delayMs: 10000, failureAction: 'rollback', monitorMs: 30000, order: 'start-first' });
    const accessory = normalizeChecked({ compose: load('services:', '  db: {image: "postgres:16"}'), role: 'accessory' });
    expect(accessory.stack.services[0].update).toEqual(DOCKER_UPDATE_DEFAULTS);
    expectRowDiagnostics([...app.diagnostics, ...accessory.diagnostics], [{ diagnostics: [] }]);
  });

  test('INJ-06 an app service with ports gets one injected route and no network diagnostic', () => {
    const { stack, diagnostics } = normalizeChecked({
      compose: load('services:', '  web: {image: nginx:1.27, ports: ["8080:80"]}'),
      proxy: { enabled: true, acme: true, domains: { production: 'shop.example.com' } },
    });
    expect(stack.services[0].routes.map((r) => [r.router, r.origin, r.port])).toEqual([['shop-production-web', 'injected', 80]]);
    expect(diagnostics.filter((d) => d.code.startsWith('network') || d.code.startsWith('networks'))).toEqual([]);
  });

  test('INJ-07 a build section is the built-image signal, never a key diagnostic', () => {
    const { diagnostics } = normalizeChecked({ compose: load('services:', '  web: {build: {context: ., dockerfile: Dockerfile}, image: shop-web-production:1.4.2}') });
    expect(diagnostics.filter((d) => d.code.startsWith('keys.'))).toEqual([]);
  });

  test('INJ-08 a Swarm Go template surviving Nunjucks is refused where it matters', () => {
    const { diagnostics } = normalizeChecked({ compose: load('services:', '  web:', '    image: nginx:1.27', '    hostname: "{{.Node.Hostname}}"') });
    expect(at(diagnostics, 'network.swarm-template').map((d) => [d.severity, d.path])).toEqual([['error', 'services.web.hostname']]);
  });
});

describe('one pass (design-01 1.2)', () => {
  const FORTY = [
    'include: [other.yml]',
    'models: {llm: {model: ai/example}}',
    'jobs: {nightly: {image: "busybox:1.36"}}',
    'x-dockflow: {}',
    'servics: {}',
    'volumes:',
    '  shared: {driver: nfs}',
    'secrets:',
    '  nosource: {}',
    'configs:',
    '  twice: {file: a.txt, content: b}',
    'services:',
    '  "web app": {image: nginx:1.27}',
    '  nothing:',
    '  s01: {image: nginx:1.27, environment: {P: "a$b"}}',
    '  s02: {image: Nginx}',
    '  s03: {command: [echo]}',
    '  s04: {image: nginx:1.27, ports: [abc]}',
    '  s05: {image: nginx:1.27, volumes: ["./data:/data"]}',
    '  s06: {image: nginx:1.27, secrets: [ghost]}',
    '  s08: {image: nginx:1.27, deploy: {mode: bogus}}',
    '  s09: {image: nginx:1.27, networks: [ghost]}',
    '  s10: {image: nginx:1.27, x-dockflow: {kind: bogus}}',
    '  s11: {image: nginx:1.27, user: nobody}',
    '  s13: {image: nginx:1.27, sysctls: {kernel.msgmax: "1"}}',
    '  s14: {image: nginx:1.27, devices: [/dev/fuse]}',
    '  s15: {image: nginx:1.27, runtime: runsc}',
    '  s17: {image: nginx:1.27, uts: host}',
    '  s18: {image: nginx:1.27, env_file: [missing.env]}',
    '  s19: {image: nginx:1.27, environment: {"A B": x}}',
    '  s20: {image: nginx:1.27, tty: maybe}',
    '  s21: {image: nginx:1.27, stop_grace_period: abc}',
    '  s22: {image: nginx:1.27, working_dir: relative}',
    '  s23: {image: nginx:1.27, profiles: [dev]}',
    '  s24: {image: nginx:1.27, extends: {service: s01}}',
    '  s25: {image: nginx:1.27, volumes_from: [s01]}',
    '  s26: {image: nginx:1.27, pre_start: [{command: [echo]}]}',
    '  s27: {image: nginx:1.27, dns: [not-an-ip]}',
    '  s28: {image: nginx:1.27, hostname: a.b}',
    '  s30: {image: nginx:1.27, network_mode: none}',
    '  s31: {image: nginx:1.27, deploy: {resources: {limits: {cpus: abc}}}}',
    '  s32: {image: nginx:1.27, mem_limit: 1xyz}',
    '  s34: {image: nginx:1.27, cpus: .inf}',
    '  s37: {image: nginx:1.27, bogus_key: 1}',
  ];
  const EXPECTED: [string, string][] = [
    ['configs.twice', 'files.several-sources'],
    ['include', 'unsupported.include'],
    ['jobs', 'unsupported.jobs'],
    ['models', 'unsupported.models'],
    ['secrets.nosource', 'files.no-source'],
    ['services.nothing', 'services.not-a-mapping'],
    ['services.s01.environment.P', 'interpolate.unset'],
    ['services.s02.image', 'image.invalid-reference'],
    ['services.s03', 'image.missing'],
    ['services.s04.ports[0]', 'ports.invalid'],
    ['services.s05.volumes[0]', 'mounts.relative-bind'],
    ['services.s06.secrets[0]', 'files.undeclared'],
    ['services.s08.deploy.mode', 'deploy.invalid-mode'],
    ['services.s09.networks[0]', 'network.undeclared'],
    ['services.s10.x-dockflow.kind', 'extension.invalid'],
    ['services.s11.user', 'security.user-name'],
    ['services.s13.sysctls["kernel.msgmax"]', 'security.unsafe-sysctl'],
    ['services.s14.devices', 'security.devices-unsupported'],
    ['services.s15.runtime', 'security.runtime-unsupported'],
    ['services.s17.uts', 'security.uts-host-unsupported'],
    ['services.s18.env_file[0]', 'files.not-found'],
    ['services.s19.environment["A B"]', 'env.invalid-name'],
    ['services.s20.tty', 'values.invalid-boolean'],
    ['services.s21.stop_grace_period', 'values.invalid-duration'],
    ['services.s22.working_dir', 'process.relative-working-dir'],
    ['services.s23.profiles', 'unsupported.profiles'],
    ['services.s24.extends', 'unsupported.extends'],
    ['services.s25.volumes_from', 'unsupported.volumes-from'],
    ['services.s26.pre_start', 'unsupported.pre-start'],
    ['services.s27.dns[0]', 'network.invalid-dns'],
    ['services.s28.hostname', 'network.invalid-hostname'],
    ['services.s30.network_mode', 'network.mode-none-unsupported'],
    ['services.s31.deploy.resources.limits.cpus', 'values.invalid-cpus'],
    ['services.s32.mem_limit', 'values.invalid-bytes'],
    ['services.s34.cpus', 'yaml.unsupported-value'],
    ['services.s37.bogus_key', 'keys.unknown'],
    ['services["web app"]', 'names.invalid-service-key'],
    ['servics', 'keys.unknown'],
    ['volumes.shared.driver', 'volumes.driver-unsupported'],
    ['x-dockflow', 'extension.misplaced'],
  ];

  test('a file with 40 independent errors reports all 40, and every service mapping still reaches the model', () => {
    expect(EXPECTED).toHaveLength(40);
    const { stack, diagnostics } = normalizeChecked({ compose: load(...FORTY) });
    const errors = diagnostics.filter((d) => d.severity === 'error').map((d): [string, string] => [d.path, d.code]);
    expect(errors).toEqual(EXPECTED);
    // partial services are kept so every diagnostic of a golden is complete; render throws anyway
    const keys = FORTY.flatMap((line) => /^ {2}(s\d\d):/.exec(line)?.[1] ?? []);
    expect(stack.services.map((s) => s.composeName)).toEqual(keys);
  });
});

describe('normalizeStack', () => {
  test('writes to input.sink only and never lists it: dedup and order happen once, in render', () => {
    class CountingSink extends DiagnosticSink {
      lists = 0;
      override list(): Diagnostic[] {
        this.lists++;
        return super.list();
      }
    }
    const sink = new CountingSink();
    normalizeStack(normalizeInput({ compose: load('version: "3"', 'services:', '  web: {image: nginx:1.27, tty: yes}'), sink }));
    expect(sink.lists).toBe(0);
    expect(sink.list().map((d) => d.code)).toEqual(['values.yaml11-boolean', 'keys.version-ignored']);
  });

  test('never mutates the compose it reads', () => {
    const compose = load('x-a: &a {environment: {A: "$$x"}}', 'services:', '  web:', '    <<: *a', '    image: nginx:1.27', '    ports: ["8080:80"]');
    const before = structuredClone(compose);
    normalizeChecked({ compose, proxy: { enabled: true, domains: { production: 'shop.example.com' } } });
    expect(compose).toEqual(before);
  });

  test('volume x-dockflow settings are applied before the services mount the volume', () => {
    const { stack, diagnostics } = normalizeChecked({
      compose: load(
        'services:',
        '  db: {image: "postgres:16", volumes: ["data:/var/lib/postgresql/data"], x-dockflow: {kind: statefulset}}',
        'volumes:',
        '  data: {x-dockflow: {per_replica: true, access_mode: ReadWriteOncePod}}',
      ),
    });
    expect(stack.volumes.map((v) => [v.key, v.perReplica, v.accessMode, v.usedBy])).toEqual([['data', true, 'ReadWriteOncePod', ['db']]]);
    expectRowDiagnostics(diagnostics, [{ diagnostics: [] }]);
  });
});

describe('normalizeChecked and the row contract (design-07 4.1)', () => {
  function model() {
    return normalizeChecked({
      compose: load(
        'services:',
        '  web: {image: nginx:1.27, environment: {B: "2", A: "1"}, ports: ["8080:80", "9090:90"], volumes: ["data:/data"]}',
        '  api: {image: nginx:1.27}',
        'volumes:',
        '  data: {}',
      ),
    }).stack;
  }

  test('canonicalStackViolations accepts a normalized stack and names each broken invariant', () => {
    expect(canonicalStackViolations(model())).toEqual([]);
    const broken = model();
    broken.services.reverse();
    broken.services[0].environment.reverse();
    broken.services[0].ports[0].path = '';
    broken.volumes[0].usedBy = [];
    expect(canonicalStackViolations(broken)).toEqual([
      'services is not sorted at index 1',
      'services[0].environment is not sorted unique at index 1',
      'services[0].ports[0].path is empty',
      'volumes[0].usedBy is [], mounted by ["web"]',
    ]);
    const undefinedField = model() as unknown as { services: Record<string, unknown>[] };
    undefinedField.services[0].hostname = undefined;
    expect(canonicalStackViolations(undefinedField as never)).toEqual(['stack.services[0].hostname is undefined']);
    const unmounted = model();
    unmounted.services[1].mounts = [];
    expect(canonicalStackViolations(unmounted)).toContain('volumes[0] (data) is not mounted by any service');
  });

  test('extra infos are tolerated, extra warnings and errors fail, exact lists everything', () => {
    const info: Diagnostic = { severity: 'info', code: 'keys.version-ignored', path: 'version', message: 'm' };
    const warning: Diagnostic = { severity: 'warning', code: 'values.yaml11-boolean', path: 'services.web.tty', message: 'm' };
    expect(() => expectRowDiagnostics([info], [])).not.toThrow();
    expect(() => expectRowDiagnostics([info, warning], [])).toThrow();
    expect(() => expectRowDiagnostics([info], [{ diagnostics: [], exact: true }])).toThrow();
    expect(() => expectRowDiagnostics([info, warning], [{ diagnostics: [warning] }])).not.toThrow();
    expect(() => expectRowDiagnostics([], [{ diagnostics: [warning] }])).toThrow();
  });

  test('jsonPointer follows RFC 6901', () => {
    const doc = { a: [{ 'b/c': 1, 'd~e': 2 }] };
    expect(jsonPointer(doc, '/a/0/b~1c')).toEqual({ found: true, value: 1 });
    expect(jsonPointer(doc, '/a/0/d~0e')).toEqual({ found: true, value: 2 });
    expect(jsonPointer(doc, '/a/1')).toEqual({ found: false, value: undefined });
    expect(jsonPointer(doc, '')).toEqual({ found: true, value: doc });
  });
});

runNormalizeRows('runNormalizeRows (design-07 4.1)', [
  { id: 'N-SUPPORT-01', title: 'a pointer into the model', compose: 'image: nginx:1.27\ntty: true', expect: { select: '/services/0/process/tty', equals: true } },
  {
    id: 'N-SUPPORT-02',
    title: 'listed diagnostics, extra infos tolerated',
    compose: 'image: nginx:1.27\ntty: yes\ndevelop: {}',
    expect: [{ diagnostics: [{ severity: 'warning', code: 'values.yaml11-boolean', path: 'services.web.tty' }] }, { select: '/services/0/healthcheck', equals: null }],
  },
  {
    id: 'N-SUPPORT-03',
    title: 'sibling keys and role',
    role: 'accessory',
    compose: 'services:\n  web: {image: "nginx:1.27"}',
    sibling: { services: ['web'] },
    expect: { diagnostics: [{ severity: 'error', code: 'names.role-collision', path: 'services.web' }], exact: true },
  },
  { id: 'N-SUPPORT-04', title: 'an absent pointer', compose: 'image: nginx:1.27', expect: { select: '/services/1', absent: true } },
  {
    id: 'N-SUPPORT-05',
    title: 'files, proxy and image delivery',
    proxy: { domains: { production: 'shop.example.com' } },
    images: { mode: 'registry' },
    compose: 'build: .\nimage: shop-web-production:1.4.2\nports: ["8080:80"]\nenv_file: [web.env]',
    files: { 'web.env': 'A=1\n' },
    expect: [
      { select: '/services/0/environment', equals: [{ name: 'A', value: '1' }] },
      { select: '/services/0/routes/0/origin', equals: 'injected' },
      { select: '/services/0/image/ref', equals: 'shop-web-production:1.4.2' },
    ],
  },
]);
