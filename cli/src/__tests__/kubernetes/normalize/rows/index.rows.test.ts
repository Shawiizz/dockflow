// design-07 4.2 row catalogue, group N-IDX (top-level dispatch and stack assembly; design-01 1.1,
// 1.2, 3, key registry coverage). Every row runs the full pipeline (PD-11 (a)).

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-IDX-01',
    title: 'an unknown service key suggests the nearest known key',
    compose: 'image: nginx:1.27\nimagee: x',
    expect: { diagnostics: [{ severity: 'error', code: 'keys.unknown', path: 'services.web.imagee' }] },
  },
  {
    id: 'N-IDX-02',
    title: 'top-level version is ignored without a diagnostic that fails the row',
    compose: 'services:\n  web:\n    image: nginx:1.27\nversion: "3.8"\n',
    expect: { diagnostics: [{ severity: 'info', code: 'keys.version-ignored', path: 'version' }] },
  },
  {
    id: 'N-IDX-03',
    title: 'a top-level name is ignored with a warning',
    compose: 'services:\n  web:\n    image: nginx:1.27\nname: x\n',
    expect: { diagnostics: [{ severity: 'warning', code: 'keys.name-ignored', path: 'name' }] },
  },
  {
    id: 'N-IDX-04a',
    title: 'include is refused',
    compose: 'services:\n  web:\n    image: nginx:1.27\ninclude: [other.yml]\n',
    expect: { diagnostics: [{ severity: 'error', code: 'unsupported.include', path: 'include' }] },
  },
  {
    id: 'N-IDX-04b',
    title: 'extends is refused',
    compose: 'image: nginx:1.27\nextends:\n  service: base\n  file: common.yml',
    expect: { diagnostics: [{ severity: 'error', code: 'unsupported.extends', path: 'services.web.extends' }] },
  },
  {
    id: 'N-IDX-04c',
    title: 'volumes_from is refused',
    compose: 'image: nginx:1.27\nvolumes_from: ["other"]',
    expect: { diagnostics: [{ severity: 'error', code: 'unsupported.volumes-from', path: 'services.web.volumes_from' }] },
  },
  {
    id: 'N-IDX-05',
    title: 'a compose service also present in the sibling file is a role collision',
    compose: 'services:\n  redis:\n    image: redis:8-alpine\n',
    sibling: { services: ['redis'] },
    expect: { diagnostics: [{ severity: 'error', code: 'names.role-collision', path: 'services.redis' }] },
  },
  {
    id: 'N-IDX-06',
    title: 'a second service aliasing the first name space collides',
    compose: 'services:\n  web:\n    image: nginx:1.27\n  other:\n    image: nginx:1.27\n    networks:\n      default:\n        aliases: [web]\n',
    expect: { diagnostics: [{ severity: 'error', code: 'names.derived-collision', path: 'services.other' }] },
  },
  {
    id: 'N-IDX-07',
    title: 'zero services is a valid, empty stack',
    compose: 'services: {}\n',
    expect: [
      { select: '/services', equals: [] },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-IDX-08a',
    title: 'the same compose parsed twice produces deep-equal models',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nenvironment: {A: "1"}',
    expect: { select: '/services/0/image/composeRef', equals: 'nginx:1.27' },
  },
  {
    id: 'N-IDX-08b',
    title: 'shuffled mapping key order produces the same model',
    compose: 'environment: {A: "1"}\nports: ["8080:80"]\nimage: nginx:1.27',
    expect: { select: '/services/0/image/composeRef', equals: 'nginx:1.27' },
  },
];

runNormalizeRows('normalize/index (N-IDX)', rows);
