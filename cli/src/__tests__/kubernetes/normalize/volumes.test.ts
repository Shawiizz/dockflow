import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { MountSpec } from '../../../services/orchestrator/kubernetes/model/types';
import type { NormalizeContext, ServiceDraft, VolumeTable } from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  normalizeTarget,
  normalizeTopLevelVolumes,
  parseVolumeShort,
  serviceVolumes,
} from '../../../services/orchestrator/kubernetes/normalize/volumes';
import { type NormalizeInputOverrides, normalizeContext, parsedCompose, serviceDraft } from '../support/builders';

interface Run {
  ctx: NormalizeContext;
  volumes: VolumeTable;
  drafts: Map<string, ServiceDraft>;
  diagnostics: Diagnostic[];
}

/** Top-level volumes, then every service in key order (design-01 1.2). */
function run(source: string | Record<string, unknown>, overrides: NormalizeInputOverrides = {}): Run {
  const compose = parsedCompose(source);
  const ctx = normalizeContext({ ...overrides, compose });
  const volumes = normalizeTopLevelVolumes(compose.raw.volumes, ctx);
  const drafts = new Map<string, ServiceDraft>();
  for (const key of Object.keys(compose.services).sort()) {
    const draft = serviceDraft(key, ctx);
    serviceVolumes(draft, compose.services[key], volumes, ctx);
    drafts.set(key, draft);
  }
  return { ctx, volumes, drafts, diagnostics: ctx.sink.list() };
}

function mounts(r: Run, service = 'web'): MountSpec[] {
  return r.drafts.get(service)?.mounts ?? [];
}

function withCode(r: Run, code: string): Diagnostic[] {
  return r.diagnostics.filter((d) => d.code === code);
}

function codesAt(r: Run, path: string): string[] {
  return r.diagnostics.filter((d) => d.path === path).map((d) => d.code);
}

function errors(r: Run): Diagnostic[] {
  return r.diagnostics.filter((d) => d.severity === 'error');
}

/** One service `web` mounting `volumes`, with the given top-level volumes. */
function webWith(volumes: unknown[], topLevel: Record<string, unknown> = {}): Record<string, unknown> {
  return { services: { web: { image: 'nginx:1.27', volumes } }, volumes: topLevel };
}

describe('parseVolumeShort', () => {
  test('forms of the compose short syntax', () => {
    expect(parseVolumeShort('/data')).toEqual({ kind: 'anonymous', target: '/data', options: [] });
    expect(parseVolumeShort('data:/x')).toEqual({ kind: 'named', source: 'data', target: '/x', options: [] });
    expect(parseVolumeShort('data:/x:ro,nocopy')).toEqual({ kind: 'named', source: 'data', target: '/x', options: ['ro', 'nocopy'] });
    expect(parseVolumeShort('/srv:/srv')).toEqual({ kind: 'bind', source: '/srv', target: '/srv', options: [] });
    expect(parseVolumeShort('./x:/x')).toMatchObject({ kind: 'bind', source: './x' });
    expect(parseVolumeShort('~/x:/x')).toMatchObject({ kind: 'bind', source: '~/x' });
    expect(parseVolumeShort('\\\\host\\share:/x')).toMatchObject({ kind: 'bind', source: '\\\\host\\share' });
    // one-letter volume names are volumes, not drive letters
    expect(parseVolumeShort('a:/data')).toEqual({ kind: 'named', source: 'a', target: '/data', options: [] });
  });

  test('refusals', () => {
    expect(parseVolumeShort('')).toEqual({ error: 'empty' });
    expect(parseVolumeShort('a::b')).toEqual({ error: 'empty-section' });
    expect(parseVolumeShort('a:b:c:d')).toEqual({ error: 'too-many-colons' });
    expect(parseVolumeShort('C:\\data:/data')).toEqual({ error: 'windows-path' });
    expect(parseVolumeShort('C:/data:/data')).toEqual({ error: 'windows-path' });
  });

  test('normalizeTarget', () => {
    expect(normalizeTarget('/var/lib/data/')).toBe('/var/lib/data');
    expect(normalizeTarget('//a/./b/../c')).toBe('/a/c');
    expect(normalizeTarget('/')).toBe('/');
    expect(normalizeTarget('relative')).toBeNull();
    expect(normalizeTarget('/a\0b')).toBeNull();
  });
});

describe('service volumes, short syntax (design-01 5.5)', () => {
  test('VOL-01 named volume: mount, copy-up info, default claim', () => {
    const r = run(`
      services:
        db:
          image: postgres:16
          volumes: ["data:/var/lib/postgresql/data"]
      volumes:
        data:
    `);
    expect(mounts(r, 'db')).toEqual([
      {
        type: 'volume',
        volume: 'data',
        target: '/var/lib/postgresql/data',
        readOnly: false,
        subpath: null,
        path: 'services.db.volumes[0]',
      },
    ]);
    expect(withCode(r, 'volumes.copy-up-not-emulated')).toEqual([
      {
        severity: 'info',
        code: 'volumes.copy-up-not-emulated',
        path: 'services.db.volumes[0]',
        message: "Kubernetes does not copy the image's files into an empty volume mounted at /var/lib/postgresql/data (Docker does)",
        hint: 'Seed the volume from the entrypoint, or mount a subdirectory the image does not ship.',
      },
    ]);
    // usedBy is filled by the stack checks; the volume is used, so no volumes.unused
    expect(r.volumes.get('data')).toEqual({
      key: 'data',
      name: 'data',
      role: 'app',
      external: false,
      size: '1Gi',
      storageClass: r.ctx.traits.defaultStorageClass,
      accessMode: 'ReadWriteOnce',
      perReplica: false,
      labels: {},
      usedBy: [],
      path: 'volumes.data',
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['volumes.copy-up-not-emulated']);
  });

  test('VOL-02 nocopy suppresses the copy-up info', () => {
    const r = run(webWith(['data:/x:nocopy'], { data: null }));
    expect(mounts(r)).toEqual([{ type: 'volume', volume: 'data', target: '/x', readOnly: false, subpath: null, path: 'services.web.volumes[0]' }]);
    expect(r.diagnostics).toEqual([]);
  });

  test('VOL-03 undeclared named volume', () => {
    const r = run(webWith(['cache:/x']));
    expect(mounts(r)).toEqual([]);
    expect(withCode(r, 'volumes.undeclared')).toEqual([
      {
        severity: 'error',
        code: 'volumes.undeclared',
        path: 'services.web.volumes[0]',
        message: 'volume cache is not declared under top-level volumes',
        hint: 'Declare it: `volumes: {cache: {}}`; a host path must start with `/`.',
      },
    ]);
  });

  test('VOL-04 absolute bind', () => {
    const r = run(webWith(['/srv/app/conf.yml:/etc/app/conf.yml:ro']));
    expect(mounts(r)).toEqual([
      {
        type: 'bind',
        source: '/srv/app/conf.yml',
        target: '/etc/app/conf.yml',
        readOnly: true,
        createHostPath: true,
        propagation: null,
        recursive: 'enabled',
        path: 'services.web.volumes[0]',
      },
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  test('VOL-05 relative and ~ binds are refused', () => {
    const r = run(webWith(['./conf:/etc/conf', '../x:/x', '.env:/y', '~/x:/z']));
    expect(mounts(r)).toEqual([]);
    const refused = withCode(r, 'mounts.relative-bind');
    expect(refused.map((d) => d.path)).toEqual([
      'services.web.volumes[0]',
      'services.web.volumes[1]',
      'services.web.volumes[2]',
      'services.web.volumes[3]',
    ]);
    expect(refused[0].message).toBe(
      'the relative host path ./conf cannot be mounted: a Kubernetes pod mounts paths of the node it runs on',
    );
    expect(refused[0].hint).toBe(
      'Upload the file with `uploads:` in `config.yml` to an absolute path and mount that path, or declare it as a config (`configs: {conf: {file: ./conf}}`) and mount it with `configs:`.',
    );
    expect(refused[3].message).toBe('the host path ~/x starts with ~, which has no meaning on a node');
  });

  test('VOL-06 Windows paths are refused; a one-letter name is a volume', () => {
    const r = run(webWith(['C:\\data:/data', 'C:/data:/data', '\\\\host\\share:/share', 'a:/a'], { a: null }));
    const windows = withCode(r, 'mounts.windows-path');
    expect(windows.map((d) => [d.path, d.message])).toEqual([
      ['services.web.volumes[0]', 'C:\\data is a Windows path'],
      ['services.web.volumes[1]', 'C:/data is a Windows path'],
      ['services.web.volumes[2]', '\\\\host\\share is a Windows path'],
    ]);
    expect(windows[0].hint).toBe('Use an absolute Linux path.');
    expect(mounts(r)).toEqual([{ type: 'volume', volume: 'a', target: '/a', readOnly: false, subpath: null, path: 'services.web.volumes[3]' }]);
  });

  test('VOL-07 a container engine socket bind reaches the model (the refusal is the translator\u2019s)', () => {
    const r = run(webWith(['/var/run/docker.sock:/var/run/docker.sock']));
    expect(mounts(r)).toEqual([
      {
        type: 'bind',
        source: '/var/run/docker.sock',
        target: '/var/run/docker.sock',
        readOnly: false,
        createHostPath: true,
        propagation: null,
        recursive: 'enabled',
        path: 'services.web.volumes[0]',
      },
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  test('VOL-08 anonymous volumes become emptyDirs, named by target', () => {
    const r = run(webWith(['/data', '/x']));
    expect(mounts(r)).toEqual([
      { type: 'anonymous', target: '/data', path: 'services.web.volumes[0]' },
      { type: 'anonymous', target: '/x', path: 'services.web.volumes[1]' },
    ]);
    expect(withCode(r, 'volumes.anonymous-emptydir')).toEqual([
      {
        severity: 'info',
        code: 'volumes.anonymous-emptydir',
        path: 'services.web.volumes[0]',
        message: 'the anonymous volume at /data becomes an emptyDir, which is deleted with the pod',
        hint: 'Declare a top-level volume and mount it by name (`volumes: {data: {}}` and `data:/data`) to keep the data.',
      },
      {
        severity: 'info',
        code: 'volumes.anonymous-emptydir',
        path: 'services.web.volumes[1]',
        message: 'the anonymous volume at /x becomes an emptyDir, which is deleted with the pod',
        hint: 'Declare a top-level volume and mount it by name (`volumes: {x: {}}` and `x:/x`) to keep the data.',
      },
    ]);
  });

  test('VOL-09 ro and rw together', () => {
    const r = run(webWith(['data:/x:ro,rw'], { data: null }));
    expect(withCode(r, 'mounts.conflicting-options')).toEqual([
      { severity: 'error', code: 'mounts.conflicting-options', path: 'services.web.volumes[0]', message: 'ro and rw are both set' },
    ]);
  });

  test('VOL-10 nocopy on a bind is ignored with a warning', () => {
    const r = run(webWith(['/srv:/srv:nocopy']));
    expect(withCode(r, 'mounts.option-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'mounts.option-ignored',
        path: 'services.web.volumes[0]',
        message: 'option nocopy only applies to named volumes and is ignored',
      },
    ]);
    expect(mounts(r)).toHaveLength(1);
  });

  test('VOL-11 propagation modes are stored as written; Bidirectional is judged by the translator', () => {
    const r = run(webWith(['/srv:/a:rslave', '/srv:/b:rshared', '/srv:/c:slave', '/srv:/d:private', 'data:/e:rslave'], { data: null }));
    expect(mounts(r).map((m) => (m.type === 'bind' ? m.propagation : m.type))).toEqual(['rslave', 'rshared', 'slave', 'private', 'volume']);
    expect(errors(r)).toEqual([]);
    expect(codesAt(r, 'services.web.volumes[2]')).toEqual(['mounts.propagation-recursive']);
    // propagation on a named volume
    expect(codesAt(r, 'services.web.volumes[4]')).toContain('mounts.option-ignored');
  });

  test('VOL-11 two propagation modes conflict', () => {
    const r = run(webWith(['/srv:/a:rslave,rshared']));
    expect(withCode(r, 'mounts.conflicting-options').map((d) => d.message)).toEqual(['rslave and rshared are both set']);
  });

  test('VOL-12 SELinux, consistency and unknown options', () => {
    const r = run(webWith(['data:/a:z', 'data:/b:cached', 'data:/c:bogus'], { data: null }));
    expect(withCode(r, 'mounts.selinux-ignored')).toEqual([
      { severity: 'warning', code: 'mounts.selinux-ignored', path: 'services.web.volumes[0]', message: 'the SELinux relabel option z is ignored' },
    ]);
    expect(withCode(r, 'mounts.consistency-ignored')).toEqual([
      {
        severity: 'info',
        code: 'mounts.consistency-ignored',
        path: 'services.web.volumes[1]',
        message: 'the consistency option cached only applies to Docker Desktop and is ignored',
      },
    ]);
    expect(withCode(r, 'mounts.invalid-option')).toEqual([
      {
        severity: 'error',
        code: 'mounts.invalid-option',
        path: 'services.web.volumes[2]',
        message: 'bogus is not a volume option',
        hint: 'Use `ro`, `rw`, `nocopy`, `z`, `Z` or a propagation mode (`rprivate`, `private`, `rslave`, `slave`, `rshared`, `shared`).',
      },
    ]);
  });

  test('VOL-13 unparsable short specs', () => {
    const r = run(webWith(['a::b', 'a:b:c:d', '']));
    expect(withCode(r, 'mounts.invalid').map((d) => [d.path, d.message])).toEqual([
      ['services.web.volumes[0]', 'a::b is not a valid volume mount: empty section between colons'],
      ['services.web.volumes[1]', 'a:b:c:d is not a valid volume mount: too many colons'],
      ['services.web.volumes[2]', '"" is not a valid volume mount: empty'],
    ]);
    expect(withCode(r, 'mounts.invalid')[0].hint).toBe(
      'Use `source:target[:options]`, for example `data:/var/lib/data` or `/srv/conf:/etc/app:ro`.',
    );
    expect(mounts(r)).toEqual([]);
  });

  test('entries of another type', () => {
    const r = run(webWith([42]));
    expect(withCode(r, 'values.invalid-type')).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.volumes[0]',
        message: 'expected string or mapping, got number',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
    const notList = run({ services: { web: { image: 'nginx:1.27', volumes: 'data:/x' } } });
    expect(codesAt(notList, 'services.web.volumes')).toEqual(['values.invalid-type']);
  });
});

describe('service volumes, long syntax (design-01 5.5)', () => {
  test('VOL-14 long volume: named read-only, and anonymous without source', () => {
    const r = run(
      webWith([{ type: 'volume', source: 'data', target: '/d', read_only: true }, { type: 'volume', target: '/e' }], { data: null }),
    );
    expect(mounts(r)).toEqual([
      { type: 'volume', volume: 'data', target: '/d', readOnly: true, subpath: null, path: 'services.web.volumes[0]' },
      { type: 'anonymous', target: '/e', path: 'services.web.volumes[1]' },
    ]);
    expect(codesAt(r, 'services.web.volumes[1]')).toEqual(['volumes.anonymous-emptydir']);
  });

  test('VOL-14 long volume with an undeclared source', () => {
    const r = run(webWith([{ type: 'volume', source: 'ghost', target: '/d' }]));
    expect(codesAt(r, 'services.web.volumes[0].source')).toEqual(['volumes.undeclared']);
    expect(mounts(r)).toEqual([]);
  });

  test('VOL-15 long bind: create_host_path, bind.recursive', () => {
    const r = run(
      webWith([
        { type: 'bind', source: '/srv/a', target: '/a', bind: { create_host_path: false } },
        { type: 'bind', source: '/srv/b', target: '/b', read_only: true, bind: { recursive: 'readonly' } },
        { type: 'bind', source: '/srv/c', target: '/c', bind: { recursive: 'readonly' } },
        { type: 'bind', source: '/srv/d', target: '/d', read_only: true, bind: { recursive: 'writable' } },
        { type: 'bind', source: '/srv/e', target: '/e', bind: { recursive: 'disabled' } },
      ]),
    );
    const binds = mounts(r).filter((m) => m.type === 'bind');
    expect(binds.map((m) => [m.target, m.readOnly, m.createHostPath, m.recursive])).toEqual([
      ['/a', false, false, 'enabled'],
      ['/b', true, true, 'readonly'],
      ['/c', false, true, 'enabled'],
      ['/d', true, true, 'writable'],
      ['/e', false, true, 'enabled'],
    ]);
    // create_host_path: false is warned by the translator (volumes.bind-create-host-path), not here
    expect(codesAt(r, 'services.web.volumes[0]')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.path.startsWith('services.web.volumes[0]'))).toEqual([]);
    expect(withCode(r, 'mounts.bind-recursive-needs-readonly')).toEqual([
      {
        severity: 'error',
        code: 'mounts.bind-recursive-needs-readonly',
        path: 'services.web.volumes[2].bind.recursive',
        message: 'bind.recursive: readonly requires a read-only mount',
        hint: 'Add `read_only: true`, or use `recursive: enabled`.',
      },
    ]);
    expect(r.diagnostics.filter((d) => d.path.startsWith('services.web.volumes[3]'))).toEqual([]);
    expect(withCode(r, 'mounts.bind-recursive-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'mounts.bind-recursive-ignored',
        path: 'services.web.volumes[4].bind.recursive',
        message: 'bind.recursive: disabled is not supported and is ignored: a Kubernetes hostPath mount is always recursive',
      },
    ]);
  });

  test('VOL-15 long bind: source required and absolute, propagation, selinux', () => {
    const r = run(
      webWith([
        { type: 'bind', target: '/a' },
        { type: 'bind', source: './conf', target: '/b' },
        { type: 'bind', source: '/srv', target: '/c', bind: { propagation: 'rshared', selinux: 'z' } },
        { type: 'bind', source: '/srv', target: '/d', bind: { propagation: 'sideways' } },
      ]),
    );
    expect(codesAt(r, 'services.web.volumes[0].source')).toEqual(['values.empty']);
    expect(codesAt(r, 'services.web.volumes[1].source')).toEqual(['mounts.relative-bind']);
    expect(codesAt(r, 'services.web.volumes[2].bind.selinux')).toEqual(['mounts.selinux-ignored']);
    expect(codesAt(r, 'services.web.volumes[3].bind.propagation')).toEqual(['mounts.invalid-option']);
    expect(mounts(r).map((m) => (m.type === 'bind' ? [m.target, m.propagation] : null))).toEqual([
      ['/c', 'rshared'],
      ['/d', null],
    ]);
  });

  test('VOL-16 long tmpfs: size and mode', () => {
    const r = run(webWith([{ type: 'tmpfs', target: '/t', tmpfs: { size: '64m', mode: 1777 } }]));
    expect(mounts(r)).toEqual([{ type: 'tmpfs', target: '/t', sizeBytes: 67108864, path: 'services.web.volumes[0]' }]);
    expect(withCode(r, 'mounts.tmpfs-mode-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'mounts.tmpfs-mode-ignored',
        path: 'services.web.volumes[0].tmpfs.mode',
        message: 'tmpfs.mode is ignored: memory-backed volumes are world-writable (0777)',
      },
    ]);
  });

  test('VOL-16 long tmpfs: a source, an invalid size, a numeric size', () => {
    const r = run(
      webWith([
        { type: 'tmpfs', source: 'x', target: '/a' },
        { type: 'tmpfs', target: '/b', tmpfs: { size: 'lots' } },
        { type: 'tmpfs', target: '/c', tmpfs: { size: 1024 } },
      ]),
    );
    expect(withCode(r, 'mounts.tmpfs-source').map((d) => [d.path, d.message])).toEqual([
      ['services.web.volumes[0].source', 'a tmpfs mount takes no source'],
    ]);
    expect(withCode(r, 'values.invalid-bytes').map((d) => [d.path, d.message])).toEqual([
      ['services.web.volumes[1].tmpfs.size', 'lots is not a byte value'],
    ]);
    expect(mounts(r).map((m) => (m.type === 'tmpfs' ? m.sizeBytes : null))).toEqual([null, null, 1024]);
  });

  test('VOL-17 refused mount types', () => {
    const r = run(
      webWith([
        { type: 'image', source: 'alpine', target: '/a', image: { subpath: 'x' } },
        { type: 'npipe', source: '\\\\.\\pipe\\x', target: '/b' },
        { type: 'cluster', source: 'c', target: '/c' },
        { type: 'glusterfs', source: 'g', target: '/d' },
        { target: '/e' },
      ]),
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.path])).toEqual([
      ['mounts.image-unsupported', 'services.web.volumes[0].type'],
      ['mounts.npipe-unsupported', 'services.web.volumes[1].type'],
      ['mounts.cluster-unsupported', 'services.web.volumes[2].type'],
      ['mounts.invalid-type', 'services.web.volumes[3].type'],
      ['mounts.invalid-type', 'services.web.volumes[4]'],
    ]);
    expect(withCode(r, 'mounts.image-unsupported')[0].message).toBe(
      'image mounts are not supported: they need Kubernetes 1.36 and Dockflow supports clusters from 1.34',
    );
    expect(withCode(r, 'mounts.invalid-type')[0].message).toBe('type glusterfs must be volume, bind or tmpfs');
    expect(mounts(r)).toEqual([]);
  });

  test('VOL-18 invalid or missing targets', () => {
    const r = run(webWith(['data:relative', { type: 'volume', source: 'data' }, { type: 'bind', source: '/srv', target: '/' }], { data: null }));
    expect(withCode(r, 'mounts.invalid-target').map((d) => [d.path, d.message])).toEqual([
      ['services.web.volumes[0]', 'the mount target relative must be an absolute path other than /'],
      ['services.web.volumes[2].target', 'the mount target / must be an absolute path other than /'],
    ]);
    expect(codesAt(r, 'services.web.volumes[1].target')).toEqual(['values.empty']);
    expect(mounts(r)).toEqual([]);
  });

  test('VOL-19 volume.subpath and volume.labels', () => {
    const r = run(
      webWith(
        [
          { type: 'volume', source: 'data', target: '/a', volume: { subpath: '../x' } },
          { type: 'volume', source: 'data', target: '/b', volume: { labels: { a: 'b' } } },
          { type: 'volume', source: 'data', target: '/c', volume: { subpath: 'sub/dir', nocopy: true } },
        ],
        { data: null },
      ),
    );
    expect(withCode(r, 'mounts.invalid-subpath')).toEqual([
      {
        severity: 'error',
        code: 'mounts.invalid-subpath',
        path: 'services.web.volumes[0].volume.subpath',
        message: 'volume.subpath ../x must be a relative path without ..',
      },
    ]);
    expect(withCode(r, 'mounts.volume-labels-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'mounts.volume-labels-ignored',
        path: 'services.web.volumes[1].volume.labels',
        message: 'volume.labels is ignored',
        hint: 'Set `labels` on the top-level volume instead.',
      },
    ]);
    const withSubpath = mounts(r).find((m) => m.target === '/c');
    expect(withSubpath).toEqual({ type: 'volume', volume: 'data', target: '/c', readOnly: false, subpath: 'sub/dir', path: 'services.web.volumes[2]' });
    // volume.nocopy suppresses the copy-up info like the short option
    expect(codesAt(r, 'services.web.volumes[2]')).toEqual([]);
  });

  test('options of another mount type are ignored with a warning', () => {
    const r = run(webWith([{ type: 'volume', source: 'data', target: '/a', bind: { propagation: 'rslave' } }], { data: null }));
    expect(withCode(r, 'mounts.option-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'mounts.option-ignored',
        path: 'services.web.volumes[0].bind',
        message: 'option bind only applies to bind mounts and is ignored',
      },
    ]);
  });

  test('long read_only and consistency', () => {
    const r = run(webWith([{ type: 'bind', source: '/srv', target: '/a', read_only: 'yes', consistency: 'delegated' }]));
    expect(mounts(r)[0]).toMatchObject({ type: 'bind', readOnly: true });
    expect(codesAt(r, 'services.web.volumes[0].read_only')).toEqual(['values.yaml11-boolean']);
    expect(codesAt(r, 'services.web.volumes[0].consistency')).toEqual(['mounts.consistency-ignored']);
    const invalid = run(webWith([{ type: 'bind', source: '/srv', target: '/a', read_only: 'maybe' }]));
    expect(withCode(invalid, 'values.invalid-boolean').map((d) => d.message)).toEqual(['expected true or false, got maybe']);
  });

  test('VOL-20 two mounts on one target', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', volumes: ['data:/x'], tmpfs: '/x' } }, volumes: { data: null } });
    expect(withCode(r, 'mounts.duplicate-target')).toEqual([
      {
        severity: 'error',
        code: 'mounts.duplicate-target',
        path: 'services.web.tmpfs',
        message: '/x is mounted twice (services.web.volumes[0] and services.web.tmpfs)',
        hint: 'Mount each path once.',
      },
    ]);
    expect(mounts(r).map((m) => m.path)).toEqual(['services.web.volumes[0]']);
  });

  test('VOL-20 targets are compared after normalization, and against secret and config mounts', () => {
    const r = run(webWith(['/srv:/x/', 'data:/x:nocopy'], { data: null }));
    expect(codesAt(r, 'services.web.volumes[1]')).toEqual(['mounts.duplicate-target']);

    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    draft.files.push({ kind: 'secret', source: 'k', target: '/run/secrets/k', mode: 0o444, uid: null, gid: null, path: 'services.web.secrets[0]' });
    serviceVolumes(draft, { volumes: ['/srv/k:/run/secrets/k'] }, new Map(), ctx);
    expect(draft.mounts).toEqual([]);
    expect(ctx.sink.list().map((d) => [d.code, d.message])).toEqual([
      ['mounts.duplicate-target', '/run/secrets/k is mounted twice (services.web.secrets[0] and services.web.volumes[0])'],
    ]);
  });

  test('VOL-21 volumes_from', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', volumes_from: ['api'] } } });
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unsupported.volumes-from',
        path: 'services.web.volumes_from',
        message: 'volumes_from is not supported',
        hint: 'Declare a named volume at top level and mount it in both services.',
      },
    ]);
  });

  test('VOL-22 one anonymous-emptydir info per entry, each at its own path', () => {
    const r = run({
      services: {
        api: { image: 'nginx:1.27', volumes: [{ type: 'volume', target: '/var/lib/data' }] },
        web: { image: 'nginx:1.27', volumes: ['/var/lib/data', '/cache'] },
      },
    });
    expect(withCode(r, 'volumes.anonymous-emptydir').map((d) => [d.path, d.message])).toEqual([
      ['services.api.volumes[0]', 'the anonymous volume at /var/lib/data becomes an emptyDir, which is deleted with the pod'],
      ['services.web.volumes[0]', 'the anonymous volume at /var/lib/data becomes an emptyDir, which is deleted with the pod'],
      ['services.web.volumes[1]', 'the anonymous volume at /cache becomes an emptyDir, which is deleted with the pod'],
    ]);
  });
});

describe('service tmpfs and shm_size (design-01 5.5)', () => {
  test('TMP-01 string form', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', tmpfs: '/run' } } });
    expect(mounts(r)).toEqual([{ type: 'tmpfs', target: '/run', sizeBytes: null, path: 'services.web.tmpfs' }]);
    expect(r.diagnostics).toEqual([]);
  });

  test('TMP-01 list form', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', tmpfs: ['/run', '/tmp'] } } });
    expect(mounts(r)).toEqual([
      { type: 'tmpfs', target: '/run', sizeBytes: null, path: 'services.web.tmpfs[0]' },
      { type: 'tmpfs', target: '/tmp', sizeBytes: null, path: 'services.web.tmpfs[1]' },
    ]);
  });

  test('TMP-02 size, mode and owner options', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', tmpfs: ['/data:size=64m,mode=755,uid=1009'] } } });
    expect(mounts(r)).toEqual([{ type: 'tmpfs', target: '/data', sizeBytes: 67108864, path: 'services.web.tmpfs[0]' }]);
    expect(r.diagnostics.map((d) => [d.severity, d.code, d.message])).toEqual([
      ['warning', 'mounts.tmpfs-mode-ignored', 'tmpfs option mode is ignored: memory-backed volumes are world-writable (0777)'],
      ['warning', 'mounts.tmpfs-owner-ignored', 'tmpfs uid is ignored: memory-backed volumes are owned by root'],
    ]);
  });

  test('TMP-03 percentage size, flags and unknown options', () => {
    const r = run({
      services: {
        a: { image: 'nginx:1.27', tmpfs: '/x:size=50%' },
        b: { image: 'nginx:1.27', tmpfs: '/x:noexec,rw' },
        c: { image: 'nginx:1.27', tmpfs: '/x:foo' },
      },
    });
    expect(r.diagnostics.map((d) => [d.path, d.severity, d.code, d.message])).toEqual([
      [
        'services.a.tmpfs',
        'error',
        'mounts.invalid-tmpfs-option',
        'tmpfs size 50% is a percentage, which memory-backed volumes do not support',
      ],
      ['services.b.tmpfs', 'warning', 'mounts.tmpfs-flag-ignored', 'tmpfs option noexec is ignored'],
      ['services.c.tmpfs', 'error', 'mounts.invalid-tmpfs-option', 'foo is not a tmpfs option'],
    ]);
  });

  test('TMP-03 invalid tmpfs forms', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', tmpfs: ['relative', 7, ''] } } });
    expect(r.diagnostics.map((d) => [d.path, d.code])).toEqual([
      ['services.web.tmpfs[0]', 'mounts.invalid-target'],
      ['services.web.tmpfs[1]', 'values.invalid-type'],
      ['services.web.tmpfs[2]', 'values.empty'],
    ]);
    const map = run({ services: { web: { image: 'nginx:1.27', tmpfs: { a: 1 } } } });
    expect(withCode(map, 'values.invalid-type').map((d) => d.message)).toEqual(['expected string or list, got mapping']);
  });

  test('TMP-04 shm_size', () => {
    const sized = run({ services: { web: { image: 'nginx:1.27', shm_size: '1g' } } });
    expect(mounts(sized)).toEqual([{ type: 'tmpfs', target: '/dev/shm', sizeBytes: 1073741824, path: 'services.web.shm_size' }]);
    const zero = run({ services: { web: { image: 'nginx:1.27', shm_size: 0 } } });
    expect(mounts(zero)).toEqual([]);
    expect(zero.diagnostics).toEqual([]);
    const both = run({ services: { web: { image: 'nginx:1.27', shm_size: '1g', tmpfs: '/dev/shm' } } });
    expect(codesAt(both, 'services.web.shm_size')).toEqual(['mounts.duplicate-target']);
    const invalid = run({ services: { web: { image: 'nginx:1.27', shm_size: '1 gigabyte' } } });
    expect(codesAt(invalid, 'services.web.shm_size')).toEqual(['values.invalid-bytes']);
  });
});

describe('top-level volumes (design-01 6.2)', () => {
  test('TVOL-01 a sanitized claim name is reported when the volume is mounted', () => {
    const r = run(`
      services:
        db:
          image: postgres:16
          volumes: ["postgres_data:/var/lib/postgresql/data:nocopy"]
      volumes:
        postgres_data:
    `);
    expect(r.volumes.get('postgres_data')?.name).toBe('postgres-data');
    expect(r.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'names.volume-sanitized',
        path: 'volumes.postgres_data',
        message: 'volume postgres_data is stored in the claim postgres-data',
      },
    ]);
  });

  test('TVOL-01 the sanitized-name info is given once per volume, only when a mount is kept', () => {
    const r = run({
      services: {
        api: { image: 'nginx:1.27', volumes: ['app_data:/a:nocopy'] },
        web: { image: 'nginx:1.27', volumes: ['app_data:/b:nocopy', { type: 'volume', source: 'app_data', target: '/c', volume: { nocopy: true } }] },
      },
      volumes: { app_data: null, ext_data: { external: true, name: 'ext-data' }, plain: null },
    });
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([['names.volume-sanitized', 'volumes.app_data']]);

    // an unmounted volume creates no claim, so nothing is said about its name
    const unmounted = run({ services: { web: { image: 'nginx:1.27' } }, volumes: { app_data: null } });
    expect(unmounted.diagnostics).toEqual([]);

    // a mount refused as a duplicate target does not use the volume either
    const refused = run(webWith(['/srv:/x', 'app_data:/x:nocopy'], { app_data: null }));
    expect(refused.diagnostics.map((d) => [d.code, d.path])).toEqual([['mounts.duplicate-target', 'services.web.volumes[1]']]);
  });

  test('TVOL-01 an external volume keeps its name and is never reported as sanitized', () => {
    const r = run(webWith(['pg:/d:nocopy'], { pg: { external: true, name: 'pgdata' } }));
    expect(r.volumes.get('pg')?.name).toBe('pgdata');
    expect(r.diagnostics).toEqual([]);
  });

  test('TVOL-02 an unused volume stays in the table; volumes.unused is the stack checks’', () => {
    const r = run(`
      services:
        web:
          image: nginx:1.27
      volumes:
        cache_dir:
    `);
    // only the whole stack knows no service mounts it (stackChecks reports volumes.unused)
    expect(withCode(r, 'volumes.unused')).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.volumes.get('cache_dir')).toMatchObject({ key: 'cache_dir', name: 'cache-dir', usedBy: [] });
  });

  test('claim-name collisions are left to the stack checks (names.volume-collision, volumes.role-collision)', () => {
    const r = run(webWith(['pg_data:/a:nocopy', 'pg-data:/b:nocopy'], { pg_data: null, 'pg-data': null }), {
      sibling: { volumes: [{ key: 'pg_data', claimName: 'pg-data', external: false }] },
    });
    // both keys map to one claim; the handler only records it, stackChecks decides
    expect(r.volumes.get('pg_data')?.name).toBe('pg-data');
    expect(r.volumes.get('pg-data')?.name).toBe('pg-data');
    expect(withCode(r, 'names.volume-collision')).toEqual([]);
    expect(withCode(r, 'volumes.role-collision')).toEqual([]);
    expect(r.ctx.names.ownerOf('volume', 'pg-data')).toBeNull();
    expect(mounts(r).map((m) => (m.type === 'volume' ? m.volume : null))).toEqual(['pg_data', 'pg-data']);
  });

  test('TVOL-03 name on a non-external volume', () => {
    const r = run(webWith(['data:/d:nocopy'], { data: { name: 'shared-data' } }));
    expect(r.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'volumes.name-ignored',
        path: 'volumes.data.name',
        message: 'name shared-data is ignored: the claim is named data in namespace dockflow-shop-production',
        hint: 'Remove `name`, or set `external: true` to use an existing claim named `shared-data`.',
      },
    ]);
    expect(r.volumes.get('data')?.name).toBe('data');
  });

  test('TVOL-04 external volumes keep their name; an invalid one is refused', () => {
    const r = run(
      webWith(['a:/a:nocopy', 'b:/b:nocopy', 'c:/c:nocopy', 'legacy:/d:nocopy'], {
        a: { external: true, name: 'pgdata' },
        b: { external: true, name: 'PG_Data' },
        c: { external: { name: 'old-data' } },
        legacy: { external: 'true' },
      }),
    );
    expect(r.volumes.get('a')).toMatchObject({ external: true, name: 'pgdata' });
    expect(r.volumes.get('c')).toMatchObject({ external: true, name: 'old-data' });
    expect(r.volumes.get('legacy')).toMatchObject({ external: true, name: 'legacy' });
    expect(r.volumes.get('b')?.external).toBe(true);
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'volumes.invalid-external-name',
        path: 'volumes.b.name',
        message: 'external volume name PG_Data is not a valid Kubernetes claim name',
        hint: 'Create the claim with a lowercase DNS name and use that name.',
      },
    ]);
  });

  test('TVOL-04 an external key that is not a claim name is refused, never sanitized', () => {
    const r = run(webWith(['pg_data:/d:nocopy'], { pg_data: { external: true } }));
    expect(codesAt(r, 'volumes.pg_data')).toEqual(['volumes.invalid-external-name']);
  });

  test('TVOL-05 drivers and driver_opts', () => {
    const r = run(
      webWith(['a:/a:nocopy', 'b:/b:nocopy', 'c:/c:nocopy', 'd:/d:nocopy'], {
        a: { driver: 'local' },
        b: { driver: 'rexray' },
        c: { driver_opts: { type: 'none', o: 'bind', device: '/srv' } },
        d: { driver_opts: {} },
      }),
    );
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'volumes.driver-unsupported',
        path: 'volumes.b.driver',
        message: 'volume driver rexray is not supported',
        hint: 'Remove `driver`; claims use `x-dockflow.storage_class` (default `dockflow-local`).',
      },
      {
        severity: 'error',
        code: 'volumes.driver-opts-unsupported',
        path: 'volumes.c.driver_opts',
        message: 'driver_opts are not supported',
        hint: 'For a host directory, mount the path directly (`/srv/data:/data`); for NFS, create a claim and reference it with `external: true`.',
      },
    ]);
  });

  test('TVOL-06 labels: valid ones kept, invalid ones dropped with a warning, reserved ones refused', () => {
    const r = run(`
      services:
        web:
          image: nginx:1.27
          volumes: ["data:/d:nocopy"]
      volumes:
        data:
          labels:
            backup: daily
            "bad key": x
            team: "a b"
            dockflow.shawiizz.dev/volume: x
    `);
    expect(r.volumes.get('data')?.labels).toEqual({ backup: 'daily' });
    // the sink sorts by path in code-unit order: `.team` before `["...`
    expect(r.diagnostics.map((d) => [d.severity, d.code, d.path, d.message])).toEqual([
      [
        'warning',
        'labels.invalid-value',
        'volumes.data.labels.team',
        'the value of label team is not a valid Kubernetes label value and the label is dropped',
      ],
      ['warning', 'labels.invalid-key', 'volumes.data.labels["bad key"]', 'label bad key is not a valid Kubernetes label key and is dropped'],
      [
        'error',
        'labels.reserved',
        'volumes.data.labels["dockflow.shawiizz.dev/volume"]',
        'dockflow.shawiizz.dev/volume uses the prefix dockflow.shawiizz.dev/, which is reserved for Dockflow',
      ],
    ]);
    expect(withCode(r, 'labels.invalid-value')[0].hint).toBe('Use at most 63 letters, digits, `-`, `_` and `.`.');
  });

  test('TVOL-06 list labels: last value wins, empty names refused, numbers kept as text', () => {
    const r = run(webWith(['data:/d:nocopy'], { data: { labels: ['tier=db', 'tier=cache', '=x', 'flag'] } }));
    expect(r.volumes.get('data')?.labels).toEqual({ tier: 'cache', flag: '' });
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['values.duplicate-key', 'volumes.data.labels[1]'],
      ['values.empty-key', 'volumes.data.labels[2]'],
    ]);
    const yamlNumbers = run(`
      services:
        web:
          image: nginx:1.27
          volumes: ["data:/d:nocopy"]
      volumes:
        data:
          labels: {tier: 1, on: true}
    `);
    expect(yamlNumbers.volumes.get('data')?.labels).toEqual({ tier: '1', on: 'true' });
  });

  test('invalid keys and entries', () => {
    const r = run(webWith([], { 'bad key': null, ok: 'text', 'x-other': null }));
    expect(r.volumes.has('bad key')).toBe(false);
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['values.invalid-type', 'volumes.ok'],
      ['names.invalid-key', 'volumes["bad key"]'],
    ]);
    // an invalid entry keeps the defaults so later checks still see the declared key
    expect([...r.volumes.keys()]).toEqual(['ok', 'x-other']);
    expect(withCode(r, 'names.invalid-key')[0].message).toBe('bad key is not a valid volume name');
    const list = run({ services: { web: { image: 'nginx:1.27' } }, volumes: ['data'] });
    expect(codesAt(list, 'volumes')).toEqual(['values.invalid-type']);
  });

  test('extension fields inside an entry: x-dockflow is left to extension.ts, others ignored with an info', () => {
    const r = run(webWith(['data:/d:nocopy'], { data: { 'x-dockflow': { size: '5Gi' }, 'x-note': 'kept for humans' } }));
    expect(r.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'extension.ignored',
        path: 'volumes.data.x-note',
        message: 'x-note is an extension field and is ignored',
      },
    ]);
    // the size override is written by extension.ts, not here
    expect(r.volumes.get('data')?.size).toBe('1Gi');
  });

  test('role and storage class come from the context', () => {
    const r = run(webWith(['data:/d:nocopy'], { data: null }), { role: 'accessory', traits: { defaultStorageClass: 'fast' } });
    expect(r.volumes.get('data')).toMatchObject({ role: 'accessory', storageClass: 'fast' });
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    serviceVolumes(draft, { volumes: ['/data', 'ghost:/x'], tmpfs: '/t', volumes_from: ['api'] }, new Map(), ctx);
    expect(draft.mounts).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('absent keys leave the defaults', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', volumes: null, tmpfs: null, shm_size: null } } });
    expect(mounts(r)).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(normalizeTopLevelVolumes(undefined, normalizeContext()).size).toBe(0);
  });
});
