// design-07 4.2 row catalogue, group N-ID (identity, image, process, hooks; deploy replicas/mode
// rows are grouped here too, as design-07 4.2 lists them under this file). Every row runs the full
// pipeline (PD-11 (a)).
//
// Differences from the design-07 proposal, resolved by the actual identity.ts/deploy.ts/extension.ts
// code (design-01 finalizes normalizer codes; the row asserts the real decision):
// - N-INT/S1 rows are not here; interpolation is interpolate.rows.test.ts.
// - N-ID-16: the shipped code is `image.missing` (the design-07 proposal name), not a distinct
//   `identity.image-missing`.
// - N-ID-19: an empty `command` (no `entrypoint`) is `process.empty-command`, an ERROR, not the
//   proposed warning `identity.empty-command`.
// - N-ID-26 (conflict): `deploy.scale-conflict` is an ERROR, not a warning; `deploy.replicas` wins
//   the precedence (`replicas ?? scale ?? 1`).
// - N-ID-28: the shipped code is `extension.kind-mode` (x-dockflow.kind requires
//   `deploy.mode: replicated`), not `extension.invalid`.

import { sha256Hex } from '../../../../utils/hash';
import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const HEX64 = 'a'.repeat(64);
const LONG_KEY = 'a'.repeat(53);
const LONG_NAME = `${'a'.repeat(45)}-${sha256Hex(LONG_KEY).slice(0, 6)}`;

const rows: NormalizeRow[] = [
  {
    id: 'N-ID-01',
    title: 'a sanitized service key warns with the Kubernetes name',
    compose: 'services:\n  web_app:\n    image: nginx:1.29\n',
    expect: [
      { select: '/services/0/name', equals: 'web-app' },
      { select: '/services/0/composeName', equals: 'web_app' },
      { diagnostics: [{ severity: 'warning', code: 'names.sanitized', path: 'services.web_app' }] },
    ],
  },
  {
    id: 'N-ID-02',
    title: 'a key starting with a digit gets the s- prefix',
    compose: 'services:\n  2fa:\n    image: nginx:1.29\n',
    expect: [
      { select: '/services/0/name', equals: 's-2fa' },
      { diagnostics: [{ severity: 'warning', code: 'names.sanitized', path: 'services["2fa"]' }] },
    ],
  },
  {
    id: 'N-ID-03',
    title: 'a dotted key sanitizes to a DNS label',
    compose: 'services:\n  Api.V2:\n    image: nginx:1.29\n',
    expect: [
      { select: '/services/0/name', equals: 'api-v2' },
      { diagnostics: [{ severity: 'warning', code: 'names.sanitized', path: 'services["Api.V2"]' }] },
    ],
  },
  {
    id: 'N-ID-04',
    title: 'two keys sanitizing to one name collide',
    compose: 'services:\n  web-app:\n    image: nginx:1.29\n  web_app:\n    image: nginx:1.29\n',
    expect: [
      { select: '/services/0/composeName', equals: 'web-app' },
      { select: '/services/1/composeName', equals: 'web_app' },
      {
        diagnostics: [
          { severity: 'warning', code: 'names.sanitized', path: 'services.web_app' },
          { severity: 'error', code: 'names.sanitize-collision', path: 'services.web_app' },
        ],
      },
    ],
  },
  {
    id: 'N-ID-05',
    title: 'a service key over the DNS label length is truncated with a content hash',
    compose: `services:\n  ${LONG_KEY}:\n    image: nginx:1.29\n`,
    expect: [
      { select: '/services/0/name', equals: LONG_NAME },
      { diagnostics: [{ severity: 'warning', code: 'names.sanitized', path: `services.${LONG_KEY}` }] },
    ],
  },
  {
    id: 'N-ID-06',
    title: 'two keys that sanitize to nothing both become x and collide',
    compose: 'services:\n  "..":\n    image: nginx:1.29\n  __:\n    image: nginx:1.29\n',
    expect: [
      { select: '/services/0/name', equals: 'x' },
      { select: '/services/1/name', equals: 'x' },
      {
        diagnostics: [
          { severity: 'warning', code: 'names.sanitized', path: 'services[".."]' },
          { severity: 'warning', code: 'names.sanitized', path: 'services.__' },
          { severity: 'error', code: 'names.sanitize-collision', path: 'services.__' },
        ],
      },
    ],
  },
  {
    id: 'N-ID-07',
    title: 'a built image delivered by import runs under dockflow.invalid/',
    compose: 'image: shop-api:1.4.2\nbuild: .',
    images: { mode: 'import' },
    expect: {
      select: '/services/0/image',
      equals: { ref: 'dockflow.invalid/shop-api:1.4.2', composeRef: 'shop-api:1.4.2', origin: 'built', pullPolicy: 'IfNotPresent' },
    },
  },
  {
    id: 'N-ID-08',
    title: 'a built image delivered by a registry keeps its reference',
    compose: 'image: registry.example.com/shop-api:1.4.2\nbuild: .',
    images: { mode: 'registry' },
    expect: {
      select: '/services/0/image',
      equals: {
        ref: 'registry.example.com/shop-api:1.4.2',
        composeRef: 'registry.example.com/shop-api:1.4.2',
        origin: 'built',
        pullPolicy: 'IfNotPresent',
      },
    },
  },
  {
    id: 'N-ID-09',
    title: 'a pinned tag is pulled only if not present',
    compose: 'image: redis:8-alpine',
    expect: { select: '/services/0/image/pullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'N-ID-10',
    title: 'an untagged image is always pulled',
    compose: 'image: redis',
    expect: { select: '/services/0/image/pullPolicy', equals: 'Always' },
  },
  {
    id: 'N-ID-11',
    title: 'an explicit latest tag is always pulled',
    compose: 'image: redis:latest',
    expect: { select: '/services/0/image/pullPolicy', equals: 'Always' },
  },
  {
    id: 'N-ID-12',
    title: 'a digest pins the image',
    compose: `image: redis@sha256:${HEX64}`,
    expect: { select: '/services/0/image/pullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'N-ID-13',
    title: 'a registry port is not a tag: the image is untagged',
    compose: 'image: registry.example.com:5000/team/app',
    expect: { select: '/services/0/image/pullPolicy', equals: 'Always' },
  },
  {
    id: 'N-ID-14a',
    title: 'pull_policy always on a pinned pull',
    compose: 'image: redis:8-alpine\npull_policy: always',
    expect: { select: '/services/0/image/pullPolicy', equals: 'Always' },
  },
  {
    id: 'N-ID-14b',
    title: 'pull_policy never warns that the image must be preloaded',
    compose: 'image: redis:8-alpine\npull_policy: never',
    expect: [
      { select: '/services/0/image/pullPolicy', equals: 'Never' },
      { diagnostics: [{ severity: 'warning', code: 'image.pull-never', path: 'services.web.pull_policy' }] },
    ],
  },
  {
    id: 'N-ID-14c',
    title: 'pull_policy missing is the default',
    compose: 'image: redis:8-alpine\npull_policy: missing',
    expect: { select: '/services/0/image/pullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'N-ID-14d',
    title: 'pull_policy if_not_present is the default',
    compose: 'image: redis:8-alpine\npull_policy: if_not_present',
    expect: { select: '/services/0/image/pullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'N-ID-15a',
    title: 'pull_policy build without a build section is refused',
    compose: 'image: redis:8-alpine\npull_policy: build',
    expect: [
      { select: '/services/0/image/pullPolicy', equals: 'IfNotPresent' },
      { diagnostics: [{ severity: 'error', code: 'image.pull-policy-build', path: 'services.web.pull_policy' }] },
    ],
  },
  {
    id: 'N-ID-15b',
    title: 'pull_policy daily pulls on every pod start',
    compose: 'image: redis:8-alpine\npull_policy: daily',
    expect: [
      { select: '/services/0/image/pullPolicy', equals: 'Always' },
      { diagnostics: [{ severity: 'warning', code: 'image.pull-policy-periodic', path: 'services.web.pull_policy' }] },
    ],
  },
  {
    id: 'N-ID-15c',
    title: 'pull_policy every_2h is a periodic pull',
    compose: 'image: redis:8-alpine\npull_policy: every_2h',
    expect: [
      { select: '/services/0/image/pullPolicy', equals: 'Always' },
      { diagnostics: [{ severity: 'warning', code: 'image.pull-policy-periodic', path: 'services.web.pull_policy' }] },
    ],
  },
  {
    id: 'N-ID-16',
    title: 'no image and no build is refused',
    compose: '',
    expect: { diagnostics: [{ severity: 'error', code: 'image.missing', path: 'services.web' }] },
  },
  {
    id: 'N-ID-17',
    title: 'a string entrypoint is split into words (shlex, no shell)',
    compose: `image: nginx:1.27\nentrypoint: "/bin/app --flag 'a b'"`,
    expect: { select: '/services/0/process/entrypoint', equals: ['/bin/app', '--flag', 'a b'] },
  },
  {
    id: 'N-ID-18',
    title: 'a list command keeps $$ reduced to a literal $',
    compose: 'image: nginx:1.27\ncommand: ["sh", "-c", "echo $$HOME"]',
    expect: { select: '/services/0/process/command', equals: ['sh', '-c', 'echo $HOME'] },
  },
  {
    id: 'N-ID-19',
    title: 'an empty command cannot clear the image CMD',
    compose: 'image: nginx:1.27\ncommand: []',
    expect: [
      { select: '/services/0/process/command', equals: null },
      { diagnostics: [{ severity: 'error', code: 'process.empty-command', path: 'services.web.command' }] },
    ],
  },
  {
    id: 'N-ID-20a',
    title: 'a numeric user',
    compose: 'image: nginx:1.27\nuser: "1000"',
    expect: { select: '/services/0/process/user', equals: { uid: 1000, gid: null } },
  },
  {
    id: 'N-ID-20b',
    title: 'a numeric user and group',
    compose: 'image: nginx:1.27\nuser: "1000:1001"',
    expect: { select: '/services/0/process/user', equals: { uid: 1000, gid: 1001 } },
  },
  {
    id: 'N-ID-21a',
    title: 'a named user is refused',
    compose: 'image: nginx:1.27\nuser: node',
    expect: { diagnostics: [{ severity: 'error', code: 'security.user-name', path: 'services.web.user' }] },
  },
  {
    id: 'N-ID-21b',
    title: 'a named group is refused',
    compose: 'image: nginx:1.27\nuser: "1000:staff"',
    expect: { diagnostics: [{ severity: 'error', code: 'security.user-name', path: 'services.web.user' }] },
  },
  {
    id: 'N-ID-22',
    title: 'group_add is sorted, deduplicated numbers',
    compose: 'image: nginx:1.27\ngroup_add: ["1001", 1000, "1001"]',
    expect: { select: '/services/0/process/groupAdd', equals: [1000, 1001] },
  },
  {
    id: 'N-ID-23a',
    title: 'stop_grace_period defaults to 10s',
    compose: 'image: nginx:1.27',
    expect: { select: '/services/0/process/stopGracePeriodMs', equals: 10_000 },
  },
  {
    id: 'N-ID-23b',
    title: 'stop_grace_period 1m30s',
    compose: 'image: nginx:1.27\nstop_grace_period: 1m30s',
    expect: { select: '/services/0/process/stopGracePeriodMs', equals: 90_000 },
  },
  {
    id: 'N-ID-23c',
    title: 'stop_grace_period 0s',
    compose: 'image: nginx:1.27\nstop_grace_period: 0s',
    expect: { select: '/services/0/process/stopGracePeriodMs', equals: 0 },
  },
  {
    id: 'N-ID-24',
    title: 'init, tty, stdin_open, working_dir and hostname are mapped',
    compose: 'image: nginx:1.27\ninit: true\ntty: true\nstdin_open: true\nworking_dir: /app\nhostname: api',
    expect: [
      { select: '/services/0/process/init', equals: true },
      { select: '/services/0/process/tty', equals: true },
      { select: '/services/0/process/stdinOpen', equals: true },
      { select: '/services/0/process/workingDir', equals: '/app' },
      { select: '/services/0/process/hostname', equals: 'api' },
    ],
  },
  {
    id: 'N-ID-25',
    title: 'post_start and pre_stop hook commands',
    compose: 'image: nginx:1.27\npost_start:\n  - command: ["touch", "/tmp/up"]\npre_stop:\n  - command: sleep 5',
    expect: [
      { select: '/services/0/process/postStart', equals: ['touch', '/tmp/up'] },
      { select: '/services/0/process/preStop', equals: ['sleep', '5'] },
    ],
  },
  {
    id: 'N-ID-26a',
    title: 'deploy.replicas alone',
    compose: 'image: nginx:1.27\ndeploy:\n  replicas: 3',
    expect: { select: '/services/0/replicas', equals: 3 },
  },
  {
    id: 'N-ID-26b',
    title: 'scale alone',
    compose: 'image: nginx:1.27\nscale: 2',
    expect: { select: '/services/0/replicas', equals: 2 },
  },
  {
    id: 'N-ID-26c',
    title: 'deploy.replicas and scale disagreeing is an error; deploy.replicas wins',
    compose: 'image: nginx:1.27\nscale: 2\ndeploy:\n  replicas: 3',
    expect: [
      { select: '/services/0/replicas', equals: 3 },
      { diagnostics: [{ severity: 'error', code: 'deploy.scale-conflict', path: 'services.web.scale' }] },
    ],
  },
  {
    id: 'N-ID-26d',
    title: 'deploy.replicas: 0 is valid',
    compose: 'image: nginx:1.27\ndeploy:\n  replicas: 0',
    expect: { select: '/services/0/replicas', equals: 0 },
  },
  {
    id: 'N-ID-27a',
    title: 'deploy.mode global becomes a DaemonSet',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: global',
    expect: { select: '/services/0/workloadKind', equals: 'DaemonSet' },
  },
  {
    id: 'N-ID-27b',
    title: 'deploy.mode replicated-job becomes a Job',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: replicated-job',
    expect: { select: '/services/0/workloadKind', equals: 'Job' },
  },
  {
    id: 'N-ID-27c',
    title: 'deploy.mode global-job is refused',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: global-job',
    expect: { diagnostics: [{ severity: 'error', code: 'deploy.global-job', path: 'services.web.deploy.mode' }] },
  },
  {
    id: 'N-ID-28',
    title: 'x-dockflow.kind requires deploy.mode: replicated',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: global\nx-dockflow:\n  kind: statefulset',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.kind-mode', path: 'services.web.x-dockflow.kind' }] },
  },
  {
    id: 'N-ID-29',
    title: 'container_name, platform and profiles are never silent',
    compose: 'image: nginx:1.27\ncontainer_name: legacy\nplatform: linux/amd64\nprofiles: [debug]',
    expect: {
      diagnostics: [
        { severity: 'warning', code: 'unsupported.container-name', path: 'services.web.container_name' },
        { severity: 'info', code: 'image.platform-constraint', path: 'services.web.platform' },
        { severity: 'error', code: 'unsupported.profiles', path: 'services.web.profiles' },
      ],
      exact: true,
    },
  },
];

runNormalizeRows('normalize/identity (N-ID)', rows);
