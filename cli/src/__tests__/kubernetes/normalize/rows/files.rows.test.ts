// design-07 4.2 row catalogue, group N-FILE (top-level `secrets`/`configs` and service
// secrets/configs; design-01 5.6, 6.3). Every row runs the full pipeline (PD-11 (a)).
//
// Difference from the design-07 proposal, resolved by the actual files.ts code:
// - N-FILE-14: the write-bit mask (`mode & 0o555`) is applied by the NORMALIZER's `readMode`
//   (files.ts), not solely by the translator as design-07's note states; the row asserts the
//   already-clamped values (0o777 -> 0o555 = 365, 0o000 -> 0).

import { sha256Hex } from '../../../../utils/hash';
import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const SECRET_CONTENT = 'secret-value';
const SECRET_CHECKSUM = sha256Hex(new TextEncoder().encode(SECRET_CONTENT));

const rows: NormalizeRow[] = [
  {
    id: 'N-FILE-01',
    title: 'a secret mounted under /run/secrets by default',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    secrets: [api_key]\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: [
      {
        select: '/services/0/files/0',
        equals: { kind: 'secret', source: 'api_key', target: '/run/secrets/api_key', mode: 292, uid: null, gid: null, path: 'services.web.secrets[0]' },
      },
      { select: '/files/0/checksum', equals: SECRET_CHECKSUM },
    ],
  },
  {
    id: 'N-FILE-02',
    title: 'a config mounted at its own root path by default',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    configs: [app_conf]\nconfigs:\n  app_conf:\n    content: "x=1"\n',
    expect: { select: '/services/0/files/0/target', equals: '/app_conf' },
  },
  {
    id: 'N-FILE-03',
    title: 'a long entry with an octal mode: the model carries it once, on the mount',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets:\n      - source: api_key\n        target: /etc/key\n        mode: 0440\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: { select: '/services/0/files/0', equals: { kind: 'secret', source: 'api_key', target: '/etc/key', mode: 288, uid: null, gid: null, path: 'services.web.secrets[0]' } },
  },
  {
    id: 'N-FILE-04a',
    title: 'an octal mode literal is read as octal',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets:\n      - source: api_key\n        mode: 288\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: { select: '/services/0/files/0/mode', equals: 288 },
  },
  {
    id: 'N-FILE-04b',
    title: 'a quoted zero-prefixed mode string is read as octal',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets:\n      - source: api_key\n        mode: "0440"\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: { select: '/services/0/files/0/mode', equals: 288 },
  },
  {
    id: 'N-FILE-14',
    title: 'modes 0777 and 0000 are carried verbatim, without a translator clamp',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets:\n      - source: a\n        mode: "0777"\n      - source: b\n        mode: "0000"\n        target: /run/secrets/b\nsecrets:\n  a:\n    file: ./a.txt\n  b:\n    file: ./b.txt\n',
    files: { 'a.txt': 'x', 'b.txt': 'y' },
    expect: [
      { select: '/services/0/files/0/mode', equals: 365 },
      { select: '/services/0/files/1/mode', equals: 0 },
    ],
  },
  {
    id: 'N-FILE-15',
    title: 'a non-UTF-8 file under .dockflow/ is carried byte-identical',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    secrets: [cert]\nsecrets:\n  cert:\n    file: .dockflow/cert.der\n',
    files: { '.dockflow/cert.der': new Uint8Array([0x30, 0x82, 0x01, 0x00, 0xff, 0xfe, 0x00]) },
    expect: { select: '/files/0/checksum', equals: sha256Hex(new Uint8Array([0x30, 0x82, 0x01, 0x00, 0xff, 0xfe, 0x00])) },
  },
  {
    id: 'N-FILE-05',
    title: 'uid and gid are kept as strings, with a warning',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets:\n      - source: api_key\n        uid: "1000"\n        gid: "1000"\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: [
      { select: '/services/0/files/0/uid', equals: '1000' },
      { select: '/services/0/files/0/gid', equals: '1000' },
      { diagnostics: [{ severity: 'warning', code: 'files.ownership-ignored', path: 'services.web.secrets[0]' }] },
    ],
  },
  {
    id: 'N-FILE-06',
    title: 'inline content becomes the object data',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    configs: [app_conf]\nconfigs:\n  app_conf:\n    content: "x=1"\n',
    expect: { select: '/files/0/checksum', equals: sha256Hex(new TextEncoder().encode('x=1')) },
  },
  {
    id: 'N-FILE-08',
    title: 'an external secret carries no data and keeps its written name',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    secrets: [tls]\nsecrets:\n  tls:\n    external: true\n    name: shared-tls\n',
    expect: { select: '/files/0', equals: { kind: 'secret', key: 'tls', objectName: 'shared-tls', role: 'app', external: true, data: null, checksum: null, path: 'secrets.tls' } },
  },
  {
    id: 'N-FILE-09',
    title: 'a missing secret file is an error',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    secrets: [api_key]\nsecrets:\n  api_key:\n    file: ./missing.txt\n',
    expect: { diagnostics: [{ severity: 'error', code: 'files.not-found', path: 'secrets.api_key.file' }] },
  },
  {
    id: 'N-FILE-10',
    title: 'template_driver is refused',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    configs: [app_conf]\nconfigs:\n  app_conf:\n    content: "x"\n    template_driver: golang\n',
    expect: { diagnostics: [{ severity: 'error', code: 'files.template-driver-unsupported', path: 'configs.app_conf.template_driver' }] },
  },
  {
    id: 'N-FILE-11',
    title: 'binary file bytes are byte-identical',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    configs: [bin]\nconfigs:\n  bin:\n    file: bin.dat\n',
    files: { 'bin.dat': new Uint8Array(Array.from({ length: 256 }, (_, i) => i)) },
    expect: { select: '/files/0/checksum', equals: sha256Hex(new Uint8Array(Array.from({ length: 256 }, (_, i) => i))) },
  },
  {
    id: 'N-FILE-12',
    title: 'an undeclared secret reference is an error',
    compose: 'image: nginx:1.27\nsecrets: [api_key]',
    expect: { diagnostics: [{ severity: 'error', code: 'files.undeclared', path: 'services.web.secrets[0]' }] },
  },
  {
    id: 'N-FILE-13',
    title: 'two services referencing the same secret share one CanonicalFileSource',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    secrets: [api_key]\n  api:\n    image: nginx:1.27\n    secrets: [api_key]\nsecrets:\n  api_key:\n    file: ./api_key.txt\n',
    files: { 'api_key.txt': SECRET_CONTENT },
    expect: [
      { select: '/files/0/objectName', equals: `api-key-secret-${SECRET_CHECKSUM.slice(0, 8)}` },
      { select: '/files/0/checksum', equals: SECRET_CHECKSUM },
      { select: '/services/0/files/0/source', equals: 'api_key' },
      { select: '/services/1/files/0/source', equals: 'api_key' },
    ],
  },
];

runNormalizeRows('normalize/files (N-FILE)', rows);
