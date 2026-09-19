import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { ImageSpec, PlacementConstraint } from '../../../services/orchestrator/kubernetes/model/types';
import { loadBalancerServiceName } from '../../../services/orchestrator/kubernetes/naming';
import type { NormalizeContext, ServiceDraft } from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  ANNOTATIONS_MAX_BYTES,
  identity as normalizeIdentity,
  parseImageRef,
  shellSyntaxWord,
  shlexSplit,
} from '../../../services/orchestrator/kubernetes/normalize/identity';
import { type NormalizeInputOverrides, normalizeContext, serviceDraft } from '../support/builders';

/** design-01 codes identity.ts may emit (5.1, 5.2, 5.12, the value layer it reads through, 1.5 file reads) */
const IDENTITY_CODES = new Set([
  'names.sanitized',
  'image.missing',
  'image.missing-for-build',
  'image.invalid-reference',
  'image.pull-policy-imported',
  'image.pull-never',
  'image.pull-policy-build',
  'image.pull-policy-periodic',
  'image.invalid-pull-policy',
  'image.pull-refresh-ignored',
  'image.platform-constraint',
  'image.platform-variant-ignored',
  'image.invalid-platform',
  'image.unsupported-platform-os',
  'build.accessory-not-built',
  'unsupported.container-name',
  'labels.reserved',
  'labels.invalid-key',
  'labels.too-large',
  'label_file.parse-error',
  'unsupported.profiles',
  'unsupported.provider',
  'unsupported.extends',
  'unsupported.models',
  'unsupported.pre-start',
  'keys.develop-ignored',
  'keys.attach-ignored',
  'extension.ignored',
  'process.invalid-shell-words',
  'process.shell-syntax',
  'process.empty-program',
  'process.empty-entrypoint',
  'process.empty-command',
  'process.relative-working-dir',
  'process.stop-signal-ignored',
  'hooks.too-many',
  'hooks.option-unsupported',
  'interpolate.unset',
  'interpolate.required',
  'interpolate.invalid',
  'files.not-found',
  'files.not-a-file',
  'files.outside-project',
  'files.unreadable',
  'files.absolute-path',
  'files.backslash-path',
  'values.invalid-type',
  'values.invalid-boolean',
  'values.yaml11-boolean',
  'values.invalid-duration',
  'values.negative-duration',
  'values.duration-too-large',
  'values.empty',
  'values.empty-key',
  'values.duplicate-key',
]);

const emitted = new Set<string>();

interface Run {
  draft: ServiceDraft;
  diagnostics: Diagnostic[];
  ctx: NormalizeContext;
}

function run(node: Record<string, unknown>, overrides: NormalizeInputOverrides = {}, key = 'web'): Run {
  const ctx = normalizeContext(overrides);
  const draft = serviceDraft(key, ctx);
  normalizeIdentity(draft, node, ctx);
  const diagnostics = ctx.sink.list();
  for (const d of diagnostics) emitted.add(d.code);
  return { draft, diagnostics, ctx };
}

const brief = (ds: Diagnostic[]): [string, string, string][] => ds.map((d) => [d.severity, d.code, d.path]);
const HEX64 = 'a'.repeat(64);

describe('service names (design-01 5.1)', () => {
  test('ID-01: a sanitized key warns with the Kubernetes name', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27' }, {}, 'web_app');
    expect(draft.name).toBe('web-app');
    expect(draft.composeName).toBe('web_app');
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'names.sanitized',
        path: 'services.web_app',
        message: 'is deployed as Kubernetes service web-app; clients using the name web_app will not resolve it',
        hint: 'Rename the service to `web-app` (lowercase letters, digits and `-`).',
      },
    ]);
  });

  test('ID-05: a key starting with a digit gets the s- prefix and a warning', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27' }, {}, '2fa');
    expect(draft.name).toBe('s-2fa');
    expect(brief(diagnostics)).toEqual([['warning', 'names.sanitized', 'services["2fa"]']]);
  });

  test('ID-02: two keys sanitizing to one name get that name; the collision is a stack check (design-01 10 S1)', () => {
    const first = run({ image: 'nginx:1.27' }, {}, 'Api.V2');
    const second = run({ image: 'nginx:1.27' }, {}, 'api-v2');
    expect(first.draft.name).toBe('api-v2');
    expect(second.draft.name).toBe('api-v2');
    expect(brief(first.diagnostics)).toEqual([['warning', 'names.sanitized', 'services["Api.V2"]']]);
    expect(second.diagnostics.map((d) => d.code)).not.toContain('names.sanitize-collision');
    expect(second.diagnostics).toEqual([]);
  });

  test('ID-03: a key also present in the sibling file is left to the stack checks', () => {
    const { draft, diagnostics } = run(
      { image: 'postgres:16' },
      { sibling: { services: [{ key: 'db', name: 'db', aliases: [], published: [] }] } },
      'db',
    );
    expect(draft.name).toBe('db');
    expect(diagnostics.map((d) => d.code)).not.toContain('names.role-collision');
  });

  test('ID-04: a name equal to a derived Service name is kept for the stack checks to refuse', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27' }, {}, 'web-lb');
    expect(draft.name).toBe(loadBalancerServiceName('web'));
    expect(diagnostics.map((d) => d.code)).not.toContain('names.derived-collision');
  });
});

describe('image and build (design-01 5.1, D12)', () => {
  test('IMG-01: no image and no build', () => {
    const { draft, diagnostics } = run({});
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'image.missing',
        path: 'services.web',
        message: 'has no image',
        hint: 'Set `image:`, or add a `build:` section together with the `image:` name Dockflow tags the build with.',
      },
    ]);
    expect(draft.image).toEqual({ ref: '', composeRef: '', origin: 'pulled', pullPolicy: 'IfNotPresent' });
  });

  test('IMG-02: a build without an image name', () => {
    const { diagnostics } = run({ build: '.' }, {}, 'api');
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'image.missing-for-build',
        path: 'services.api',
        message: 'has a build section but no image name, so the built image cannot be tagged and deployed',
        hint: 'Set `image:` to a name for the built image, for example `image: api`.',
      },
    ]);
  });

  test('IMG-03: a built image delivered by import runs under dockflow.invalid/', () => {
    const { draft, diagnostics } = run({ build: '.', image: 'shop-api-production:1.4.2' }, { imageDelivery: 'import' });
    expect(draft.image).toEqual({
      ref: 'dockflow.invalid/shop-api-production:1.4.2',
      composeRef: 'shop-api-production:1.4.2',
      origin: 'built',
      pullPolicy: 'IfNotPresent',
    });
    expect(diagnostics).toEqual([]);
  });

  test('IMG-04: a built image delivered by a registry keeps its reference', () => {
    const image = 'registry.example.com/team/shop-api-production:1.4.2';
    const { draft } = run({ build: { context: '.' }, image }, { imageDelivery: 'registry' });
    expect(draft.image).toEqual({ ref: image, composeRef: image, origin: 'built', pullPolicy: 'IfNotPresent' });
  });

  test('IMG-05: a pulled image with a tag', () => {
    expect(run({ image: 'postgres:16' }).draft.image).toEqual({
      ref: 'postgres:16',
      composeRef: 'postgres:16',
      origin: 'pulled',
      pullPolicy: 'IfNotPresent',
    });
  });

  test('IMG-06: latest and untagged images are always pulled', () => {
    expect(run({ image: 'itzg/rcon:latest' }).draft.image.pullPolicy).toBe('Always');
    expect(run({ image: 'redis' }).draft.image.pullPolicy).toBe('Always');
    expect(run({ image: 'registry.example.com:5000/team/app' }).draft.image.pullPolicy).toBe('Always');
  });

  test('IMG-07: a digest pins the image', () => {
    expect(run({ image: `app@sha256:${HEX64}` }).draft.image.pullPolicy).toBe('IfNotPresent');
  });

  test('IMG-08: an accessory build is ignored and the image pulled', () => {
    const { draft, diagnostics } = run({ build: '.', image: 'postgres:16' }, { role: 'accessory' });
    expect(draft.image).toEqual({ ref: 'postgres:16', composeRef: 'postgres:16', origin: 'pulled', pullPolicy: 'IfNotPresent' });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'build.accessory-not-built',
        path: 'services.web.build',
        message: 'build is ignored in accessories.yml: Dockflow only builds images of docker-compose.yml, so postgres:16 is pulled',
        hint: 'Move the service to `docker-compose.yml` to build it, or remove `build`.',
      },
    ]);
  });

  test('IMG-09: builder keys are build.ts business; a build of another type is refused', () => {
    expect(run({ build: { context: '.', target: 'prod' }, image: 'shop-api:1' }).diagnostics).toEqual([]);
    const { diagnostics } = run({ build: 3, image: 'shop-api:1' });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.build',
        message: 'expected string or mapping, got number',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
  });

  test('image references that do not parse, and non-string images', () => {
    expect(run({ image: 'Nginx' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'image.invalid-reference',
        path: 'services.web.image',
        message: 'Nginx is not a valid image reference',
        hint: 'Use [registry/]name[:tag][@digest] with a lowercase name.',
      },
    ]);
    expect(brief(run({ image: 5 }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.image']]);
    expect(brief(run({ image: '' }).diagnostics)).toEqual([['error', 'values.empty', 'services.web.image']]);
  });

  describe('IMG-10: the pull policy table', () => {
    type Column = 'built-import' | 'built-registry' | 'pulled-pinned' | 'pulled-latest';
    const columns: Record<Column, [Record<string, unknown>, NormalizeInputOverrides]> = {
      'built-import': [{ build: '.', image: 'shop-api:1.4.2' }, { imageDelivery: 'import' }],
      'built-registry': [{ build: '.', image: 'registry.example.com/shop-api:1.4.2' }, { imageDelivery: 'registry' }],
      'pulled-pinned': [{ image: 'postgres:16' }, {}],
      'pulled-latest': [{ image: 'redis' }, {}],
    };
    type Cell = [ImageSpec['pullPolicy'], string | null];
    const table: [string | undefined, Record<Column, Cell>][] = [
      [
        undefined,
        {
          'built-import': ['IfNotPresent', null],
          'built-registry': ['IfNotPresent', null],
          'pulled-pinned': ['IfNotPresent', null],
          'pulled-latest': ['Always', null],
        },
      ],
      [
        'always',
        {
          'built-import': ['IfNotPresent', 'image.pull-policy-imported'],
          'built-registry': ['Always', null],
          'pulled-pinned': ['Always', null],
          'pulled-latest': ['Always', null],
        },
      ],
      [
        'never',
        {
          'built-import': ['Never', null],
          'built-registry': ['Never', null],
          'pulled-pinned': ['Never', 'image.pull-never'],
          'pulled-latest': ['Never', 'image.pull-never'],
        },
      ],
      ...(['missing', 'if_not_present'] as const).map((policy): [string, Record<Column, Cell>] => [
        policy,
        {
          'built-import': ['IfNotPresent', null],
          'built-registry': ['IfNotPresent', null],
          'pulled-pinned': ['IfNotPresent', null],
          'pulled-latest': ['Always', null],
        },
      ]),
      [
        'build',
        {
          'built-import': ['IfNotPresent', null],
          'built-registry': ['IfNotPresent', null],
          'pulled-pinned': ['IfNotPresent', 'image.pull-policy-build'],
          'pulled-latest': ['Always', 'image.pull-policy-build'],
        },
      ],
      ...(['refresh', 'daily', 'weekly', 'every_2h', 'every_1d12h'] as const).map((policy): [string, Record<Column, Cell>] => [
        policy,
        {
          'built-import': ['IfNotPresent', 'image.pull-policy-imported'],
          'built-registry': ['Always', 'image.pull-policy-periodic'],
          'pulled-pinned': ['Always', 'image.pull-policy-periodic'],
          'pulled-latest': ['Always', 'image.pull-policy-periodic'],
        },
      ]),
      ...(['sometimes', 'Always', 'every_'] as const).map((policy): [string, Record<Column, Cell>] => [
        policy,
        {
          'built-import': ['IfNotPresent', 'image.invalid-pull-policy'],
          'built-registry': ['IfNotPresent', 'image.invalid-pull-policy'],
          'pulled-pinned': ['IfNotPresent', 'image.invalid-pull-policy'],
          'pulled-latest': ['Always', 'image.invalid-pull-policy'],
        },
      ]),
    ];

    for (const [policy, cells] of table) {
      for (const [column, [expected, code]] of Object.entries(cells) as [Column, Cell][]) {
        test(`${policy ?? 'absent'} x ${column} -> ${expected}${code === null ? '' : ` + ${code}`}`, () => {
          const [node, overrides] = columns[column];
          const { draft, diagnostics } = run(policy === undefined ? node : { ...node, pull_policy: policy }, overrides);
          expect(draft.image.pullPolicy).toBe(expected);
          expect(diagnostics.map((d) => [d.code, d.path])).toEqual(code === null ? [] : [[code, 'services.web.pull_policy']]);
        });
      }
    }

    test('the messages of the table', () => {
      const texts = (node: Record<string, unknown>, overrides: NormalizeInputOverrides = {}) =>
        run(node, overrides).diagnostics.map((d) => [d.message, d.hint]);
      expect(texts({ build: '.', image: 'shop-api:1', pull_policy: 'always' })).toEqual([
        [
          'pull_policy always cannot be honoured for an image Dockflow builds and imports into the nodes: no registry holds it',
          'Remove `pull_policy`, or enable `registry` in `config.yml`.',
        ],
      ]);
      expect(texts({ image: 'postgres:16', pull_policy: 'never' })).toEqual([
        [
          'pull_policy never requires postgres:16 to be present on every node that may run the service, otherwise pods fail with ErrImageNeverPull',
          'Remove `pull_policy` unless the image is preloaded on every node.',
        ],
      ]);
      expect(texts({ image: 'postgres:16', pull_policy: 'build' })).toEqual([
        ['pull_policy build requires a build section', 'Add `build:`, or remove `pull_policy`.'],
      ]);
      expect(texts({ image: 'postgres:16', pull_policy: 'daily' })).toEqual([
        [
          'pull_policy daily is not supported on Kubernetes; the image is pulled whenever a pod starts (imagePullPolicy Always)',
          'Pin a tag and redeploy to update the image.',
        ],
      ]);
      expect(texts({ image: 'postgres:16', pull_policy: 'sometimes' })).toEqual([
        ['sometimes is not a pull policy', 'Use `always`, `never`, `missing`, `build`, `daily`, `weekly` or `every_<duration>`.'],
      ]);
    });

    test('pull_refresh_after is ignored with a warning', () => {
      expect(run({ image: 'postgres:16', pull_refresh_after: '1h' }).diagnostics).toEqual([
        {
          severity: 'warning',
          code: 'image.pull-refresh-ignored',
          path: 'services.web.pull_refresh_after',
          message: 'pull_refresh_after is ignored: Kubernetes pulls according to imagePullPolicy only',
          hint: 'Remove `pull_refresh_after`.',
        },
      ]);
    });
  });

  test('IMG-11: platform appends OS and architecture constraints after the existing ones', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    const written: PlacementConstraint = { attribute: 'node.role', operator: '==', value: 'worker', path: 'services.web.deploy.placement.constraints[0]' };
    draft.placement.constraints.push(written);
    normalizeIdentity(draft, { image: 'nginx:1.27', platform: 'linux/arm64' }, ctx);
    expect(draft.placement.constraints).toEqual([
      written,
      { attribute: 'node.platform.os', operator: '==', value: 'linux', path: 'services.web.platform' },
      { attribute: 'node.platform.arch', operator: '==', value: 'arm64', path: 'services.web.platform' },
    ]);
    const list = ctx.sink.list();
    for (const d of list) emitted.add(d.code);
    expect(list).toEqual([
      {
        severity: 'info',
        code: 'image.platform-constraint',
        path: 'services.web.platform',
        message: 'platform linux/arm64 schedules pods only on linux/arm64 nodes',
      },
    ]);
  });

  test('IMG-12: variant, non-Linux OS and malformed platforms', () => {
    const variant = run({ image: 'nginx:1.27', platform: 'linux/arm/v7' });
    expect(brief(variant.diagnostics)).toEqual([
      ['info', 'image.platform-constraint', 'services.web.platform'],
      ['warning', 'image.platform-variant-ignored', 'services.web.platform'],
    ]);
    expect(variant.diagnostics[1].message).toBe('the variant v7 of platform linux/arm/v7 is ignored: nodes are selected by OS and architecture only');
    expect(variant.draft.placement.constraints.map((c) => c.value)).toEqual(['linux', 'arm']);

    const windows = run({ image: 'nginx:1.27', platform: 'windows/amd64' });
    expect(windows.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'image.unsupported-platform-os',
        path: 'services.web.platform',
        message: 'windows nodes are not supported',
        hint: 'Use `linux/amd64`.',
      },
    ]);
    expect(windows.draft.placement.constraints).toEqual([]);

    for (const platform of ['amd64', 'linux/mips', 'linux/arm/v7/x']) {
      const { diagnostics, draft } = run({ image: 'nginx:1.27', platform });
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'image.invalid-platform',
          path: 'services.web.platform',
          message: `${platform} is not a platform`,
          hint: 'Use `os/arch`, for example `linux/amd64`.',
        },
      ]);
      expect(draft.placement.constraints).toEqual([]);
    }
  });

  test('IMG-13: container_name is ignored with a warning naming the service name', () => {
    expect(run({ image: 'nginx:1.27', container_name: 'web' }, {}, 'web_app').diagnostics.filter((d) => d.code !== 'names.sanitized')).toEqual([
      {
        severity: 'warning',
        code: 'unsupported.container-name',
        path: 'services.web_app.container_name',
        message: 'container_name is ignored: pod names are generated by Kubernetes',
        hint: 'Remove `container_name`; other services reach this one by the name `web-app`.',
      },
    ]);
  });
});

describe('labels and annotations (design-01 5.1)', () => {
  test('LBL-01: list form, a key alone is an empty value', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', labels: ['a=b', 'c'] });
    expect(draft.containerLabels).toEqual({ a: 'b', c: '' });
    expect(diagnostics).toEqual([]);
  });

  test('LBL-02: com.docker.* labels are dropped silently', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', labels: { 'com.docker.stack.namespace': 'x', 'com.example.team': 'y' } });
    expect(draft.containerLabels).toEqual({ 'com.example.team': 'y' });
    expect(diagnostics).toEqual([]);
  });

  test('LBL-03: the Dockflow prefix is reserved', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', labels: { 'dockflow.shawiizz.dev/x': 'y' } });
    expect(draft.containerLabels).toEqual({});
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'labels.reserved',
        path: 'services.web.labels["dockflow.shawiizz.dev/x"]',
        message: 'dockflow.shawiizz.dev/x uses the prefix dockflow.shawiizz.dev/, which is reserved for Dockflow',
        hint: 'Rename the label.',
      },
    ]);
  });

  test('LBL-04: an invalid key is dropped with a warning', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', labels: ['my label=1'] });
    expect(draft.containerLabels).toEqual({});
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'labels.invalid-key',
        path: 'services.web.labels[0]',
        message: 'label my label is not a valid Kubernetes annotation key and is dropped',
        hint: 'Use an optional DNS prefix and a name of letters, digits, `-`, `_` and `.` (at most 63 characters).',
      },
    ]);
  });

  test('LBL-05: label_file entries are merged under labels, labels win', () => {
    const { draft, diagnostics } = run(
      { image: 'nginx:1.27', label_file: 'app.labels', labels: { B: '3' } },
      { files: { 'app.labels': 'A=1\nB=2\n' } },
    );
    expect(draft.containerLabels).toEqual({ A: '1', B: '3' });
    expect(diagnostics).toEqual([]);
  });

  test('label files: list form, later files see earlier values, failures and parse errors', () => {
    const files = { 'a.labels': 'team=core\n', 'b.labels': 'owner=${team}-ops\ntier=$UNSET\n', 'bad.labels': 'BAD KEY=1\n' };
    const merged = run({ image: 'nginx:1.27', label_file: ['a.labels', 'b.labels'] }, { files });
    expect(merged.draft.containerLabels).toEqual({ team: 'core', owner: 'core-ops', tier: '' });
    expect(merged.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.unset',
        path: 'services.web.label_file[1]',
        message: 'b.labels: contains a $ placeholder that has no value (Dockflow does not pass a process environment)',
        hint: 'Use `{{ current.env.<name> }}` for a Dockflow value, or write `$$` for a literal `$` (for inserted values: `{{ value | replace("$", "$$") }}`).',
      },
    ]);

    const placeholders = run(
      { image: 'nginx:1.27', label_file: ['required.labels', 'invalid.labels'] },
      { files: { 'required.labels': 'a=${TOKEN:?set it}\n', 'invalid.labels': 'b=${TOKEN/x/y}\n' } },
    );
    expect(placeholders.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      [
        'interpolate.required',
        'services.web.label_file[0]',
        'required.labels: contains a ${...:?} placeholder whose variable has no value (Dockflow does not pass a process environment)',
      ],
      ['interpolate.invalid', 'services.web.label_file[1]', 'invalid.labels: contains an invalid ${...} placeholder'],
    ]);
    // neither the variable nor the `:?` text is printed: both are file content
    expect(JSON.stringify(placeholders.diagnostics)).not.toContain('TOKEN');
    expect(JSON.stringify(placeholders.diagnostics)).not.toContain('set it');

    const failures = run({ image: 'nginx:1.27', label_file: ['missing.labels', '/etc/app.labels', 'bad.labels'] }, { files });
    expect(failures.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'files.not-found',
        path: 'services.web.label_file[0]',
        message: 'file missing.labels was not found in the project',
        hint: 'Paths are relative to the directory of the compose file and must stay inside the project.',
      },
      {
        severity: 'error',
        code: 'files.absolute-path',
        path: 'services.web.label_file[1]',
        message: 'absolute paths are not supported: /etc/app.labels would be read on the machine running dockflow',
        hint: 'Put the file in the project and use a path relative to the compose file.',
      },
      {
        severity: 'error',
        code: 'label_file.parse-error',
        path: 'services.web.label_file[2]',
        message: 'bad.labels line 1: key cannot contain a space',
      },
    ]);
  });

  test('LBL-06: annotations go to the pod template, with the label key rules and no Traefik extraction', () => {
    const { draft, diagnostics } = run({
      image: 'nginx:1.27',
      annotations: { team: 'core', 'traefik.enable': 'true', 'com.docker.x': 'y', 'bad key': 'z' },
    });
    expect(draft.podAnnotations).toEqual({ team: 'core', 'traefik.enable': 'true' });
    expect(draft.routingLabels).toEqual([]);
    expect(brief(diagnostics)).toEqual([['warning', 'labels.invalid-key', 'services.web.annotations["bad key"]']]);
  });

  test('LBL-07: deploy.labels go to the workload; Traefik keys of both maps feed the routing set, deploy.labels last', () => {
    const { draft, diagnostics } = run({
      image: 'nginx:1.27',
      labels: { 'traefik.enable': 'false', team: 'core' },
      deploy: { labels: ['traefik.enable=true', 'owner=ops', 'com.docker.x=y'] },
    });
    expect(draft.serviceLabels).toEqual({ owner: 'ops' });
    expect(draft.containerLabels).toEqual({ team: 'core' });
    expect(draft.routingLabels).toEqual([
      { key: 'traefik.enable', value: 'false', path: 'services.web.labels["traefik.enable"]', source: 'labels' },
      { key: 'traefik.enable', value: 'true', path: 'services.web.deploy.labels[0]', source: 'deploy.labels' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('LBL-07: the traefik. prefix matches in any case and the key is kept as written', () => {
    const { draft, diagnostics } = run({
      image: 'nginx:1.27',
      labels: { 'Traefik.http.routers.api.rule': 'Host(`a.example.com`)' },
      deploy: { labels: { 'TRAEFIK.enable': 'true' } },
    });
    expect(draft.containerLabels).toEqual({});
    expect(draft.serviceLabels).toEqual({});
    expect(draft.routingLabels).toEqual([
      {
        key: 'Traefik.http.routers.api.rule',
        value: 'Host(`a.example.com`)',
        path: 'services.web.labels["Traefik.http.routers.api.rule"]',
        source: 'labels',
      },
      { key: 'TRAEFIK.enable', value: 'true', path: 'services.web.deploy.labels["TRAEFIK.enable"]', source: 'deploy.labels' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('LBL-08: labels and annotations above 256 KiB are refused', () => {
    const { diagnostics } = run({ image: 'nginx:1.27', labels: { big: 'x'.repeat(300 * 1024) } });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'labels.too-large',
        path: 'services.web',
        message: 'the labels and annotations of web exceed the Kubernetes limit of 256 KiB',
        hint: 'Move large values out of labels.',
      },
    ]);
    // the generated pod annotations count too, so a value just under the limit alone is refused
    const nearLimit = run({ image: 'nginx:1.27', annotations: { a: 'x'.repeat(ANNOTATIONS_MAX_BYTES - 1) } });
    expect(nearLimit.diagnostics.map((d) => d.code)).toEqual(['labels.too-large']);
    expect(run({ image: 'nginx:1.27', annotations: { a: 'x'.repeat(200 * 1024) } }).diagnostics).toEqual([]);
  });

  test('list_or_dict value layer: duplicates, empty keys and wrong types', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', labels: ['a=1', 'a=2', '=x', 7], annotations: 'team=core' });
    expect(draft.containerLabels).toEqual({ a: '2' });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.annotations',
        message: 'expected list or mapping, got string',
        hint: 'See the Compose specification for the accepted forms.',
      },
      { severity: 'info', code: 'values.duplicate-key', path: 'services.web.labels[1]', message: 'a is set more than once; the last value wins' },
      { severity: 'error', code: 'values.empty-key', path: 'services.web.labels[2]', message: 'an entry has an empty name' },
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.labels[3]',
        message: 'expected string, got number',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
  });
});

describe('keys refused or ignored as a whole (design-01 5.1 MISC)', () => {
  const rows: [string, string, unknown, 'error' | 'info', string, string][] = [
    [
      'MISC-01',
      'profiles',
      ['debug'],
      'error',
      'unsupported.profiles',
      'profiles is not supported: Dockflow activates no Compose profile, so this service would never start',
    ],
    ['MISC-02', 'provider', { type: 'model', options: { model: 'x' } }, 'error', 'unsupported.provider', 'provider services are not supported'],
    ['MISC-03', 'extends', { service: 'base', file: 'common.yml' }, 'error', 'unsupported.extends', 'extends is not supported'],
    [
      'MISC-04',
      'develop',
      { watch: [{ path: '.', action: 'sync', target: '/app' }] },
      'info',
      'keys.develop-ignored',
      'develop only configures local development (compose watch) and is ignored',
    ],
    ['MISC-05', 'attach', false, 'info', 'keys.attach-ignored', 'attach only affects local log output and is ignored'],
    ['MISC-06', 'x-future-key', { a: 1 }, 'info', 'extension.ignored', 'x-future-key is an extension field and is ignored'],
    ['MISC-07', 'models', ['llm'], 'error', 'unsupported.models', 'models is not supported on Kubernetes deploys'],
  ];
  for (const [id, key, value, severity, code, message] of rows) {
    test(`${id}: ${key}`, () => {
      const { diagnostics } = run({ image: 'nginx:1.27', [key]: value });
      expect(diagnostics.map((d) => [d.severity, d.code, d.path, d.message])).toEqual([[severity, code, `services.web.${key}`, message]]);
    });
  }

  test('x-dockflow belongs to extension.ts and empty lists request nothing', () => {
    expect(run({ image: 'nginx:1.27', 'x-dockflow': { kind: 'statefulset' }, profiles: [], models: [] }).diagnostics).toEqual([]);
  });
});

describe('process keys (design-01 5.2)', () => {
  const process = (node: Record<string, unknown>) => run({ image: 'nginx:1.27', ...node });

  test('PROC-01: a string command is split into words', () => {
    const { draft, diagnostics } = process({ command: 'redis-server --save 60 1' });
    expect(draft.process.command).toEqual(['redis-server', '--save', '60', '1']);
    expect(draft.process.entrypoint).toBeNull();
    expect(diagnostics).toEqual([]);
  });

  test('PROC-02: a list command is kept', () => {
    expect(process({ command: ['postgres', '-c', 'max_connections=200'] }).draft.process.command).toEqual(['postgres', '-c', 'max_connections=200']);
  });

  test('PROC-03: a string entrypoint', () => {
    const { draft } = process({ entrypoint: '/code/entrypoint.sh' });
    expect(draft.process.entrypoint).toEqual(['/code/entrypoint.sh']);
    expect(draft.process.command).toBeNull();
  });

  test('PROC-04: an empty entrypoint runs the command as the program', () => {
    const { draft, diagnostics } = process({ entrypoint: [], command: ['run'] });
    expect(draft.process.entrypoint).toEqual(['run']);
    expect(draft.process.command).toBeNull();
    expect(diagnostics).toEqual([]);
  });

  test('PROC-05: an empty entrypoint without a command', () => {
    for (const node of [{ entrypoint: '' }, { entrypoint: [], command: [] }, { entrypoint: '   ', command: '' }]) {
      const { draft, diagnostics } = process(node);
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'process.empty-entrypoint',
          path: 'services.web.entrypoint',
          message: 'an empty entrypoint without a command leaves nothing to run',
          hint: 'Set `command:` to the program to run, or remove `entrypoint`.',
        },
      ]);
      expect([draft.process.entrypoint, draft.process.command]).toEqual([null, null]);
    }
  });

  test('PROC-06: an empty command cannot clear the image CMD', () => {
    for (const command of [[], '']) {
      const { draft, diagnostics } = process({ command });
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'process.empty-command',
          path: 'services.web.command',
          message:
            'an empty command (clearing the image CMD but keeping its ENTRYPOINT) cannot be expressed on Kubernetes, where empty args mean "use the image CMD"',
          hint: 'Remove `command` to keep the image `CMD`, or set `entrypoint:` to the full command line.',
        },
      ]);
      expect(draft.process.command).toBeNull();
    }
  });

  test('PROC-07: an empty command after an entrypoint drops the image CMD', () => {
    const { draft, diagnostics } = process({ entrypoint: ['sh'], command: '' });
    expect(draft.process.entrypoint).toEqual(['sh']);
    expect(draft.process.command).toBeNull();
    expect(diagnostics).toEqual([]);
  });

  test('folding: null means the image default; entrypoint and command together', () => {
    expect(process({ entrypoint: null, command: null }).draft.process).toMatchObject({ entrypoint: null, command: null });
    expect(process({ entrypoint: ['tini', '--'], command: 'node server.js' }).draft.process).toMatchObject({
      entrypoint: ['tini', '--'],
      command: ['node', 'server.js'],
    });
  });

  test('PROC-08: shell syntax in a string command is kept as words, with a warning', () => {
    const { draft, diagnostics } = process({ command: 'echo a && echo b' });
    expect(draft.process.command).toEqual(['echo', 'a', '&&', 'echo', 'b']);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'process.shell-syntax',
        path: 'services.web.command',
        message: 'contains shell syntax (&&) that is passed to the program as a plain argument: no shell runs the command',
        hint: 'Write the command as a list starting with /bin/sh and -c if a shell is intended.',
      },
    ]);
    expect(process({ command: ['sh', '-c', 'a && b'] }).diagnostics).toEqual([]);
  });

  test('PROC-09: list items must be strings and the first must name a program', () => {
    const numbers = process({ command: [1, 2] });
    expect(brief(numbers.diagnostics)).toEqual([
      ['error', 'values.invalid-type', 'services.web.command[0]'],
      ['error', 'values.invalid-type', 'services.web.command[1]'],
    ]);
    expect(numbers.draft.process.command).toBeNull();
    expect(process({ command: [''] }).diagnostics).toEqual([
      { severity: 'error', code: 'process.empty-program', path: 'services.web.command[0]', message: 'the first element must name a program' },
    ]);
    expect(brief(process({ entrypoint: { a: 1 } }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.entrypoint']]);
  });

  test('unsplittable strings are refused', () => {
    expect(process({ command: 'echo "open' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'process.invalid-shell-words',
        path: 'services.web.command',
        message: 'cannot be split into words: unterminated quote',
        hint: 'Close the quote, or write the command as a list.',
      },
    ]);
    expect(process({ entrypoint: 'run \\' }).diagnostics.map((d) => d.message)).toEqual(['cannot be split into words: trailing backslash']);
  });

  test('PROC-10: working_dir must be absolute', () => {
    expect(process({ working_dir: '/app' }).draft.process.workingDir).toBe('/app');
    const { draft, diagnostics } = process({ working_dir: 'app' });
    expect(draft.process.workingDir).toBeNull();
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'process.relative-working-dir',
        path: 'services.web.working_dir',
        message: 'working_dir app must be an absolute path',
        hint: 'Write the full path, for example `/app`.',
      },
    ]);
  });

  test('PROC-11: tty and stdin_open, YAML 1.1 spellings warned', () => {
    const { draft, diagnostics } = process({ tty: 'true', stdin_open: 'yes' });
    expect(draft.process.tty).toBe(true);
    expect(draft.process.stdinOpen).toBe(true);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'values.yaml11-boolean',
        path: 'services.web.stdin_open',
        message: 'yes is read as true; YAML 1.2 only knows true and false',
        hint: 'Write `true`.',
      },
    ]);
    expect(process({ tty: 'maybe' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-boolean',
        path: 'services.web.tty',
        message: 'expected true or false, got maybe',
        hint: 'Write `true` or `false`.',
      },
    ]);
  });

  test("PROC-12: init is recorded; its shared-PID info is the translator's", () => {
    const { draft, diagnostics } = process({ init: true });
    expect(draft.process.init).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test('PROC-13: stop_grace_period', () => {
    expect(process({}).draft.process.stopGracePeriodMs).toBe(10_000);
    expect(process({ stop_grace_period: '60s' }).draft.process.stopGracePeriodMs).toBe(60_000);
    expect(process({ stop_grace_period: '1500ms' }).draft.process.stopGracePeriodMs).toBe(1500);
    expect(process({ stop_grace_period: '0s' }).draft.process.stopGracePeriodMs).toBe(0);
  });

  test('stop_grace_period values that are not durations keep the default', () => {
    const rows: [unknown, string, string, string | undefined][] = [
      [10, 'values.invalid-duration', '10 is not a duration', 'Use a duration such as `30s`, `1m30s` or `500ms`.'],
      ['-1s', 'values.negative-duration', '-1s must not be negative', undefined],
      ['9999999999h', 'values.duration-too-large', '9999999999h is too large', undefined],
    ];
    for (const [value, code, message, hint] of rows) {
      const { draft, diagnostics } = process({ stop_grace_period: value });
      expect(draft.process.stopGracePeriodMs).toBe(10_000);
      const expected: Diagnostic = { severity: 'error', code, path: 'services.web.stop_grace_period', message };
      expect(diagnostics).toEqual([hint === undefined ? expected : { ...expected, hint }]);
    }
  });

  test('PROC-14: stop_signal', () => {
    for (const signal of ['SIGTERM', 'TERM', 15, 'sigterm']) expect(process({ stop_signal: signal }).diagnostics).toEqual([]);
    expect(process({ stop_signal: 'SIGUSR1' }).diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'process.stop-signal-ignored',
        path: 'services.web.stop_signal',
        message: 'stop_signal SIGUSR1 is not supported on Kubernetes: the image STOPSIGNAL, or SIGTERM, is sent',
        hint: 'Set `STOPSIGNAL` in the Dockerfile, or handle `SIGTERM` in the program.',
      },
    ]);
  });
});

describe('lifecycle hooks (design-01 5.12)', () => {
  const hooks = (node: Record<string, unknown>) => run({ image: 'nginx:1.27', ...node });

  test('HOOK-01: post_start with a string command; an empty list is no hook', () => {
    expect(hooks({ post_start: [{ command: './warmup.sh' }] }).draft.process.postStart).toEqual(['./warmup.sh']);
    const empty = hooks({ post_start: [] });
    expect(empty.draft.process.postStart).toBeNull();
    expect(empty.diagnostics).toEqual([]);
  });

  test('HOOK-02: pre_stop with a list command', () => {
    const { draft, diagnostics } = hooks({ pre_stop: [{ command: ['nginx', '-s', 'quit'] }] });
    expect(draft.process.preStop).toEqual(['nginx', '-s', 'quit']);
    expect(diagnostics).toEqual([]);
  });

  test('HOOK-03: one handler per container', () => {
    const { draft, diagnostics } = hooks({ pre_stop: [{ command: 'a' }, { command: 'b' }] });
    expect(draft.process.preStop).toBeNull();
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'hooks.too-many',
        path: 'services.web.pre_stop',
        message: 'pre_stop has 2 hooks; Kubernetes runs one preStop handler per container',
        hint: 'Combine them into one command, for example `["/bin/sh", "-c", "first && second"]`.',
      },
    ]);
  });

  test('HOOK-04: hook options Kubernetes cannot honour', () => {
    const { draft, diagnostics } = hooks({ post_start: [{ command: 'x', user: 'root' }] });
    expect(draft.process.postStart).toBeNull();
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'hooks.option-unsupported',
        path: 'services.web.post_start[0].user',
        message:
          "post_start[0].user is not supported: Kubernetes runs lifecycle hooks with the container's user, working directory and environment",
        hint: 'Remove `user`, or wrap the command with `/bin/sh -c`.',
      },
    ]);
    const options = hooks({ post_start: [{ command: 'x', working_dir: '/app', environment: { A: '1' }, privileged: true }] });
    expect(brief(options.diagnostics)).toEqual([
      ['error', 'hooks.option-unsupported', 'services.web.post_start[0].environment'],
      ['error', 'hooks.option-unsupported', 'services.web.post_start[0].privileged'],
      ['error', 'hooks.option-unsupported', 'services.web.post_start[0].working_dir'],
    ]);
    const unprivileged = hooks({ post_start: [{ command: 'x', privileged: false }] });
    expect(unprivileged.draft.process.postStart).toEqual(['x']);
    expect(unprivileged.diagnostics).toEqual([]);
  });

  test('HOOK-05: a hook needs a command', () => {
    for (const hook of [{ user: 'root' }, { command: '' }, { command: [] }]) {
      const { diagnostics } = hooks({ post_start: [hook] });
      expect(diagnostics.filter((d) => d.code === 'values.empty')).toEqual([
        { severity: 'error', code: 'values.empty', path: 'services.web.post_start[0].command', message: 'must not be empty' },
      ]);
    }
    expect(brief(hooks({ post_start: 'x' }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.post_start']]);
    expect(brief(hooks({ pre_stop: ['x'] }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.pre_stop[0]']]);
  });

  test('HOOK-06: pre_start is refused', () => {
    expect(hooks({ pre_start: [{ command: ['migrate'] }] }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unsupported.pre-start',
        path: 'services.web.pre_start',
        message: 'pre_start is not supported in this Dockflow version',
        hint: 'Run the step in the container entrypoint, or as a separate service with `deploy.mode: replicated-job`.',
      },
    ]);
  });
});

describe('shlexSplit (design-01 2.10)', () => {
  test('UNIT-08: plain words', () => {
    expect(shlexSplit('bundle exec thin -p 3000')).toEqual({ words: ['bundle', 'exec', 'thin', '-p', '3000'] });
  });

  test('UNIT-09: double and single quotes', () => {
    expect(shlexSplit(`redis-server --requirepass "a b" --x 'c d'`)).toEqual({ words: ['redis-server', '--requirepass', 'a b', '--x', 'c d'] });
  });

  test('UNIT-10: empty quoted words, escapes and comments', () => {
    expect(shlexSplit('a "" b')).toEqual({ words: ['a', '', 'b'] });
    expect(shlexSplit('a\\ b')).toEqual({ words: ['a b'] });
    expect(shlexSplit('"a\\nb"')).toEqual({ words: ['anb'] });
    expect(shlexSplit('a#b #c')).toEqual({ words: ['a#b'] });
    expect(shlexSplit('a # c\nb')).toEqual({ words: ['a', 'b'] });
    expect(shlexSplit("'a\\b'")).toEqual({ words: ['a\\b'] });
    expect(shlexSplit('   ')).toEqual({ words: [] });
  });

  test('UNIT-11: unterminated quotes and trailing escapes', () => {
    expect(shlexSplit('echo "open')).toEqual({ error: 'unterminated-quote' });
    expect(shlexSplit("echo 'open")).toEqual({ error: 'unterminated-quote' });
    expect(shlexSplit('echo \\')).toEqual({ error: 'trailing-escape' });
    expect(shlexSplit('echo "a\\')).toEqual({ error: 'trailing-escape' });
  });

  test('UNIT-12: shell operators are plain words, flagged for the warning', () => {
    const split = shlexSplit('a && b');
    expect(split).toEqual({ words: ['a', '&&', 'b'] });
    expect(shellSyntaxWord(['a', '&&', 'b'])).toBe('&&');
    expect(shellSyntaxWord(['echo', '$(cat /run/secrets/token)'])).toBe('$(...)');
    expect(shellSyntaxWord(['echo', '`id`'])).toBe('`...`');
    expect(shellSyntaxWord(['echo', 'a&&b', '2>&1'])).toBe('2>&1');
    expect(shellSyntaxWord(['echo', 'hello'])).toBeNull();
  });
});

describe('parseImageRef (design-01 2.12)', () => {
  test('UNIT-17: valid references and their latest flag', () => {
    const rows: [string, boolean][] = [
      ['nginx', true],
      ['nginx:1.27', false],
      ['registry:5000/a/b:v1', false],
      [`a@sha256:${HEX64}`, false],
      ['localhost/app:latest', true],
      ['[::1]:5000/app', true],
    ];
    for (const [ref, latest] of rows) expect(parseImageRef(ref)?.latest).toBe(latest);
    expect(parseImageRef('registry:5000/a/b:v1')).toEqual({ name: 'registry:5000/a/b', tag: 'v1', digest: null, latest: false });
    expect(parseImageRef(`a:1@sha256:${HEX64}`)).toEqual({ name: 'a', tag: '1', digest: `sha256:${HEX64}`, latest: false });
  });

  test('UNIT-18: invalid references', () => {
    for (const ref of ['Nginx', 'app:', 'app:-x', 'a//b', 'a'.repeat(256)]) expect(parseImageRef(ref)).toBeNull();
    expect(parseImageRef('a'.repeat(255))).not.toBeNull();
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web_app', ctx);
    ctx.markFatal(draft.path);
    normalizeIdentity(draft, { labels: 'x' }, ctx);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('every code emitted in this file is a design-01 code of identity.ts', () => {
    expect([...emitted].filter((code) => !IDENTITY_CODES.has(code))).toEqual([]);
    // and the list is exercised: every code was emitted by some test (the resolver reasons other
    // than the two above are NormalizeContext.readFile's, covered by context.test.ts)
    const unexercised = [...IDENTITY_CODES].filter((code) => !emitted.has(code));
    expect(unexercised).toEqual(['files.not-a-file', 'files.outside-project', 'files.unreadable', 'files.backslash-path']);
  });
});
