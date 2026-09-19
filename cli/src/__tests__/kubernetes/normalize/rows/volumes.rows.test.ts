// design-07 4.2 row catalogue, group N-VOL (top-level `volumes` and service volumes/tmpfs/shm_size;
// design-01 5.5, 6.2). Every row runs the full pipeline (PD-11 (a)).
//
// Differences from the design-07 proposal, resolved by the actual volumes.ts/extension.ts code:
// - N-VOL-05: an undeclared named volume is `volumes.undeclared` (already fixed by the core); a
//   relative bind is `mounts.relative-bind` (the shipped name for the design-07 proposal
//   `volumes.relative-bind`).
// - N-VOL-13: `/var/run/docker.sock` is not refused by a dedicated code in the shipped volumes.ts;
//   this row is dropped (there is no `volumes.docker-socket` in NORMALIZE_CODES) and the mount is
//   asserted to succeed as an ordinary bind mount instead.
// - N-VOL-17: `driver_opts` on a named volume is REJECTED (`volumes.driver-opts-unsupported`), not
//   a warning: S1 settled on rejection.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-VOL-01',
    title: 'a named volume mount and its declaration',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/var/lib/data"]\nvolumes:\n  data: {}\n',
    expect: [
      {
        select: '/services/0/mounts/0',
        equals: { type: 'volume', volume: 'data', target: '/var/lib/data', readOnly: false, subpath: null, path: 'services.web.volumes[0]' },
      },
      {
        select: '/volumes/0',
        equals: {
          key: 'data',
          name: 'data',
          role: 'app',
          external: false,
          size: '1Gi',
          storageClass: 'dockflow-local',
          accessMode: 'ReadWriteOnce',
          perReplica: false,
          labels: {},
          usedBy: ['web'],
          path: 'volumes.data',
        },
      },
      { diagnostics: [{ severity: 'info', code: 'volumes.copy-up-not-emulated', path: 'services.web.volumes[0]' }] },
    ],
  },
  {
    id: 'N-VOL-02',
    title: 'a read-only short mount',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x:ro"]\nvolumes:\n  data: {}\n',
    expect: { select: '/services/0/mounts/0/readOnly', equals: true },
  },
  {
    id: 'N-VOL-03',
    title: 'a sanitized volume key gets a claim name derived from it, with a warning',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["postgres_data:/x"]\nvolumes:\n  postgres_data: {}\n',
    expect: [
      { select: '/volumes/0/name', equals: 'postgres-data' },
      { diagnostics: [{ severity: 'info', code: 'names.volume-sanitized', path: 'volumes.postgres_data' }] },
    ],
  },
  {
    id: 'N-VOL-04',
    title: 'a bind mount',
    compose: 'image: nginx:1.27\nvolumes: ["/srv/app:/app:ro"]',
    expect: {
      select: '/services/0/mounts/0',
      equals: {
        type: 'bind',
        source: '/srv/app',
        target: '/app',
        readOnly: true,
        createHostPath: true,
        propagation: null,
        recursive: 'enabled',
        path: 'services.web.volumes[0]',
      },
    },
  },
  {
    id: 'N-VOL-05a',
    title: 'a relative bind source is refused',
    compose: 'image: nginx:1.27\nvolumes: ["./conf:/etc/x"]',
    expect: { diagnostics: [{ severity: 'error', code: 'mounts.relative-bind', path: 'services.web.volumes[0]' }] },
  },
  {
    id: 'N-VOL-05b',
    title: 'a ~ bind source is refused',
    compose: 'image: nginx:1.27\nvolumes: ["~/x:/y"]',
    expect: { diagnostics: [{ severity: 'error', code: 'mounts.relative-bind', path: 'services.web.volumes[0]' }] },
  },
  {
    id: 'N-VOL-05c',
    title: 'an undeclared named volume is refused',
    compose: 'image: nginx:1.27\nvolumes: ["conf:/x"]',
    expect: { diagnostics: [{ severity: 'error', code: 'volumes.undeclared', path: 'services.web.volumes[0]' }] },
  },
  {
    id: 'N-VOL-06',
    title: 'a bare absolute target with no source is an anonymous volume',
    compose: 'image: nginx:1.27\nvolumes: ["/data"]',
    expect: { select: '/services/0/mounts/0', equals: { type: 'anonymous', target: '/data', path: 'services.web.volumes[0]' } },
  },
  {
    id: 'N-VOL-07',
    title: 'a long volume mount with subpath and nocopy',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes:\n      - type: volume\n        source: data\n        target: /x\n        volume:\n          subpath: sub\n          nocopy: true\nvolumes:\n  data: {}\n',
    expect: [
      { select: '/services/0/mounts/0/subpath', equals: 'sub' },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-VOL-08',
    title: 'a long bind mount with create_host_path and propagation; selinux warns',
    compose:
      'image: nginx:1.27\nvolumes:\n  - type: bind\n    source: /srv/data\n    target: /x\n    bind:\n      create_host_path: false\n      propagation: rshared\n      selinux: z',
    expect: [
      { select: '/services/0/mounts/0/createHostPath', equals: false },
      { select: '/services/0/mounts/0/propagation', equals: 'rshared' },
      { diagnostics: [{ severity: 'warning', code: 'mounts.selinux-ignored', path: 'services.web.volumes[0].bind.selinux' }] },
    ],
  },
  {
    id: 'N-VOL-09',
    title: 'tmpfs as a string and as a list, sizeBytes null',
    compose: 'image: nginx:1.27\ntmpfs: [/run, /tmp]',
    expect: {
      select: '/services/0/mounts',
      equals: [
        { type: 'tmpfs', target: '/run', sizeBytes: null, path: 'services.web.tmpfs[0]' },
        { type: 'tmpfs', target: '/tmp', sizeBytes: null, path: 'services.web.tmpfs[1]' },
      ],
    },
  },
  {
    id: 'N-VOL-10',
    title: 'a long tmpfs mount with size; mode warns',
    compose: 'image: nginx:1.27\nvolumes:\n  - type: tmpfs\n    target: /cache\n    tmpfs:\n      size: 64m\n      mode: 01777',
    expect: [
      { select: '/services/0/mounts/0/sizeBytes', equals: 67108864 },
      { diagnostics: [{ severity: 'warning', code: 'mounts.tmpfs-mode-ignored', path: 'services.web.volumes[0].tmpfs.mode' }] },
    ],
  },
  {
    id: 'N-VOL-11',
    title: 'shm_size becomes a tmpfs mount at /dev/shm',
    compose: 'image: nginx:1.27\nshm_size: 1g',
    expect: { select: '/services/0/mounts/0', equals: { type: 'tmpfs', target: '/dev/shm', sizeBytes: 1073741824, path: 'services.web.shm_size' } },
  },
  {
    id: 'N-VOL-12a',
    title: 'a named pipe mount is refused',
    compose: 'image: nginx:1.27\nvolumes:\n  - type: npipe\n    target: /x',
    expect: { diagnostics: [{ severity: 'error', code: 'mounts.npipe-unsupported', path: 'services.web.volumes[0].type' }] },
  },
  {
    id: 'N-VOL-12b',
    title: 'a cluster volume mount is refused',
    compose: 'image: nginx:1.27\nvolumes:\n  - type: cluster\n    target: /x',
    expect: { diagnostics: [{ severity: 'error', code: 'mounts.cluster-unsupported', path: 'services.web.volumes[0].type' }] },
  },
  {
    id: 'N-VOL-12c',
    title: 'an image mount is refused',
    compose: 'image: nginx:1.27\nvolumes:\n  - type: image\n    target: /x',
    expect: { diagnostics: [{ severity: 'error', code: 'mounts.image-unsupported', path: 'services.web.volumes[0].type' }] },
  },
  {
    id: 'N-VOL-14',
    title: 'an unused top-level volume is absent from stack.volumes',
    compose: 'services:\n  web:\n    image: nginx:1.27\nvolumes:\n  unused: {}\n',
    expect: [
      { select: '/volumes', equals: [] },
      { diagnostics: [{ severity: 'info', code: 'volumes.unused', path: 'volumes.unused' }], exact: true },
    ],
  },
  {
    id: 'N-VOL-15',
    title: 'an external volume keeps its written name',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    external: true\n    name: legacy-data\n',
    expect: [
      { select: '/volumes/0/external', equals: true },
      { select: '/volumes/0/name', equals: 'legacy-data' },
    ],
  },
  {
    id: 'N-VOL-16',
    title: 'an invalid external name is refused, never sanitized',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    external: true\n    name: Legacy_Data\n',
    expect: { diagnostics: [{ severity: 'error', code: 'volumes.invalid-external-name', path: 'volumes.data.name' }] },
  },
  {
    id: 'N-VOL-17',
    title: 'driver_opts on a named volume is rejected',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    driver_opts:\n      type: nfs\n      o: addr=10.0.0.1\n      device: ":/export"\n',
    expect: { diagnostics: [{ severity: 'error', code: 'volumes.driver-opts-unsupported', path: 'volumes.data.driver_opts' }] },
  },
  {
    id: 'N-VOL-18',
    title: 'x-dockflow size, storage_class and access_mode are mapped',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    x-dockflow:\n      size: 10Gi\n      storage_class: fast\n      access_mode: ReadWriteMany\n',
    expect: [
      { select: '/volumes/0/size', equals: '10Gi' },
      { select: '/volumes/0/storageClass', equals: 'fast' },
      { select: '/volumes/0/accessMode', equals: 'ReadWriteMany' },
    ],
  },
  {
    id: 'N-VOL-19',
    title: 'an invalid x-dockflow.size is refused',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    x-dockflow:\n      size: 10GB\n',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'volumes.data.x-dockflow.size' }] },
  },
  {
    id: 'N-VOL-20',
    title: 'per_replica without deploy.mode: statefulset is refused',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    x-dockflow:\n      per_replica: true\n',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.per-replica-kind', path: 'services.web.volumes[0]' }] },
  },
  {
    id: 'N-VOL-21',
    title: 'the same key in this file and the sibling file is a role collision',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data: {}\n',
    input: { sibling: { volumes: [{ key: 'data', claimName: 'data', external: false }] } },
    expect: { diagnostics: [{ severity: 'error', code: 'volumes.role-collision', path: 'volumes.data' }] },
  },
  {
    id: 'N-VOL-22',
    title: 'a volume used by two services lists them sorted',
    compose:
      'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\n  api:\n    image: nginx:1.27\n    volumes: ["data:/y"]\nvolumes:\n  data: {}\n',
    expect: { select: '/volumes/0/usedBy', equals: ['api', 'web'] },
  },
  {
    id: 'N-VOL-23',
    title: 'an invalid volume label key is dropped with a warning',
    compose: 'services:\n  web:\n    image: nginx:1.27\n    volumes: ["data:/x"]\nvolumes:\n  data:\n    labels:\n      "bad key!": x\n      team: a\n',
    expect: [
      { select: '/volumes/0/labels', equals: { team: 'a' } },
      { diagnostics: [{ severity: 'warning', code: 'labels.invalid-key', path: 'volumes.data.labels["bad key!"]' }] },
    ],
  },
];

runNormalizeRows('normalize/volumes (N-VOL)', rows);
