import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_UPDATE_CONFIG,
  parseImageRef,
  parseContainerPort,
  loadFromString,
  serialize,
  updateImageTags,
  usesRegistry,
  injectSwarmDefaults,
  stripBuildSections,
  injectAccessoriesDefaults,
  injectTraefikLabels,
  filterServices,
  syncNonTargetedImageTags,
  getExternalNetworks,
  getExternalVolumes,
  hasServices,
  getImages,
} from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import type { DockflowConfig, ProxyConfig } from '../utils/config';
import { ConfigError } from '../utils/errors';
import { TRAEFIK_NETWORK_NAME } from '../constants';

function makeCompose(yaml: string): ParsedCompose {
  return loadFromString(yaml);
}

function loadError(yaml: string, file?: string): ConfigError {
  try {
    loadFromString(yaml, file);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadFromString to throw a ConfigError');
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('parseImageRef', () => {
  it('name only', () => {
    expect(parseImageRef('myapp')).toEqual({ name: 'myapp', tag: undefined });
  });

  it('name:tag', () => {
    expect(parseImageRef('myapp:1.0.0')).toEqual({ name: 'myapp', tag: '1.0.0' });
  });

  it('registry:port/name — colon is part of registry, not a tag separator', () => {
    expect(parseImageRef('registry:5000/app')).toEqual({ name: 'registry:5000/app', tag: undefined });
  });

  it('registry:port/name:tag', () => {
    expect(parseImageRef('registry:5000/app:latest')).toEqual({ name: 'registry:5000/app', tag: 'latest' });
  });

  it('namespaced image with tag', () => {
    expect(parseImageRef('myorg/myapp:2.0.0')).toEqual({ name: 'myorg/myapp', tag: '2.0.0' });
  });

  it('auto-tagged format (name-env:version)', () => {
    expect(parseImageRef('myapp-production:1.2.3')).toEqual({ name: 'myapp-production', tag: '1.2.3' });
  });
});

describe('parseContainerPort', () => {
  it('bare container port', () => {
    expect(parseContainerPort('80')).toBe(80);
    expect(parseContainerPort(8080)).toBe(8080);
  });

  it('host:container', () => {
    expect(parseContainerPort('8080:80')).toBe(80);
  });

  it('ip:host:container', () => {
    expect(parseContainerPort('0.0.0.0:8080:80')).toBe(80);
    expect(parseContainerPort('127.0.0.1:9000:3000')).toBe(3000);
  });

  it('protocol suffix is stripped', () => {
    expect(parseContainerPort('80/tcp')).toBe(80);
    expect(parseContainerPort('8080:80/udp')).toBe(80);
  });
});

describe('loadFromString / serialize', () => {
  it('parses services, networks and volumes', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
networks:
  internal: {}
volumes:
  data: {}
`);
    expect(Object.keys(compose.services)).toEqual(['web']);
    expect(compose.networks).toHaveProperty('internal');
    expect(compose.volumes).toHaveProperty('data');
  });

  it('missing services key yields empty object', () => {
    const compose = makeCompose('volumes:\n  data: {}\n');
    expect(compose.services).toEqual({});
    expect(hasServices(compose)).toBe(false);
  });

  it('an empty file or a file of comments is a stack without services (YAML-15)', () => {
    for (const text of ['', '# nothing to deploy yet\n']) {
      const compose = makeCompose(text);
      expect(compose.raw).toEqual({});
      expect(compose.services).toEqual({});
    }
  });

  it('serialize round-trips service changes', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n');
    compose.services.web = { ...compose.services.web, image: 'nginx:1.25' };
    const out = serialize(compose);
    const reparsed = makeCompose(out);
    expect(reparsed.services.web.image).toBe('nginx:1.25');
  });

  it('serialize never writes anchors or aliases, even for one object used twice', () => {
    const shared = { KEY: 'value' };
    const compose = makeCompose('services:\n  a:\n    image: a\n  b:\n    image: b\n');
    compose.services.a = { ...compose.services.a, environment: shared };
    compose.services.b = { ...compose.services.b, environment: shared };

    const out = serialize(compose);

    expect(out).not.toContain('&');
    expect(out).not.toContain('*');
    expect(makeCompose(out).services.b.environment).toEqual({ KEY: 'value' });
  });

  it('core-schema tags keep their meaning (YAML-09)', () => {
    const compose = makeCompose(`
services:
  web:
    image: !!str 3
    tty: !!bool true
    deploy:
      replicas: !!int "3"
    labels: !!map {a: b}
    command: !!seq [run]
    hostname: ! plain
`);
    const web = compose.services.web;
    expect(web.image).toBe('3');
    expect(web.tty).toBe(true);
    expect(record(web.deploy).replicas).toBe(3);
    expect(web.labels).toEqual({ a: 'b' });
    expect(web.command).toEqual(['run']);
    expect(web.hostname).toBe('plain');
  });
});

describe('loadFromString refusals (design-01 2.1)', () => {
  it('a duplicate key names the key and its line (YAML-05)', () => {
    const error = loadError('services:\n  web:\n    image: a\n    image: b\n', 'docker-compose.yml');

    expect(error.message).toBe('docker-compose.yml: duplicate key image at line 4');
  });

  it('names the source as "compose file" when the caller gives no file name', () => {
    expect(loadError('services:\n  web:\n    image: a\n    image: b\n').message).toBe(
      'compose file: duplicate key image at line 4',
    );
  });

  it('two documents are refused (YAML-06)', () => {
    const error = loadError('services: {}\n---\nservices: {}\n', 'accessories.yml');

    expect(error.message).toBe('accessories.yml: the file contains several YAML documents; keep one');
  });

  it('!reset and !override are refused with the line and a fix (YAML-07)', () => {
    const reset = loadError('services:\n  web:\n    image: a\n    ports: !reset []\n', 'docker-compose.yml');
    expect(reset.message).toBe(
      'docker-compose.yml: tag !reset at line 4 is only meaningful in Compose override files; Dockflow reads a single file',
    );
    expect(reset.suggestion).toBe('Remove the tag and write the final value.');

    const override = loadError('services:\n  web:\n    image: a\n    ports: !override ["80"]\n');
    expect(override.message).toContain('tag !override at line 4 is only meaningful in Compose override files');
  });

  it('an alias without an anchor is refused instead of throwing a ReferenceError (YAML-02)', () => {
    const error = loadError('services:\n  web: *nope\n', 'docker-compose.yml');

    expect(error.message).toBe('docker-compose.yml: unresolved alias *nope at line 2');
  });

  it('an alias inside the value it names is refused instead of looping', () => {
    for (const text of ['x-a: &a {b: *a}\n', 'x-a: &a [1, *a]\n', 'x-a: &a\n  <<: *a\n  image: x\n']) {
      const error = loadError(text);
      expect(error.message).toMatch(/^compose file: alias \*a at line \d+ is inside the value it refers to$/);
    }
  });

  it('!!binary is refused at load with its line (YAML-08)', () => {
    const error = loadError('services:\n  web:\n    image: a\n    labels: !!binary aGk=\n', 'docker-compose.yml');

    expect(error.message).toBe('docker-compose.yml: unsupported YAML tag !!binary at line 4');
    expect(error.suggestion).toBe('Remove the tag and write a plain string, number, boolean, list or mapping.');
  });

  it('refuses every other tag outside the core schema', () => {
    const cases: [string, string][] = [
      ['    image: !custom a\n', 'unsupported YAML tag !custom at line 3'],
      ['    labels: !!set {a}\n', 'unsupported YAML tag !!set at line 3'],
      ['    labels: !!omap [a: b]\n', 'unsupported YAML tag !!omap at line 3'],
      ['    hostname: !!timestamp 2026-09-17\n', 'unsupported YAML tag !!timestamp at line 3'],
    ];
    for (const [line, message] of cases) {
      expect(loadError(`services:\n  web:\n${line}`).message).toBe(`compose file: ${message}`);
    }
  });

  it('an alias bomb is refused after 1000 expansions', () => {
    const bomb = [
      'x-a: &a [x, x, x, x, x, x, x, x, x, x]',
      'x-b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'x-c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'x-d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
      'services: {}',
    ].join('\n');

    expect(loadError(bomb).message).toBe('compose file: too many alias expansions (limit 1000)');
  });

  it('a syntax error keeps the file name and the position but never quotes the file', () => {
    const error = loadError('services:\n  web:\n    environment:\n      TOKEN: s3cr3t-value\n   - broken\n');

    expect(error.message.startsWith('compose file: ')).toBe(true);
    expect(error.message).toMatch(/line \d+/);
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('s3cr3t');
  });

  it('a top level that is not a mapping is refused', () => {
    expect(loadError('- web\n- api\n').message).toBe('compose file: the top level must be a mapping');
    expect(loadError('just text\n').message).toBe('compose file: the top level must be a mapping');
  });
});

describe('U-SWARM-01: merge keys and aliases are resolved at load', () => {
  it('<<: *anchor is merged, and a written key wins over the merged one (YAML-03)', () => {
    const compose = makeCompose(`
x-base: &base
  image: nginx
  restart: always
services:
  web:
    <<: *base
    image: own
`);
    expect(compose.services.web).toEqual({ image: 'own', restart: 'always' });
  });

  it('<<: [*a, *b] takes the first map that defines a key (YAML-04)', () => {
    const compose = makeCompose(`
x-a: &a {image: a}
x-b: &b {image: b, tty: true}
services:
  web:
    <<: [*a, *b]
`);
    expect(compose.services.web).toEqual({ image: 'a', tty: true });
  });

  it('serialize emits no anchor, alias or merge key', () => {
    const compose = makeCompose(`
x-base: &base
  image: nginx
  environment: &env
    MODE: prod
services:
  web:
    <<: *base
  worker:
    image: worker
    environment: *env
`);
    const out = serialize(compose);

    expect(out).not.toContain('&');
    expect(out).not.toContain('*');
    expect(out).not.toContain('<<');
    const reparsed = makeCompose(out);
    expect(reparsed.services.web).toEqual({ image: 'nginx', environment: { MODE: 'prod' } });
    expect(reparsed.services.worker.environment).toEqual({ MODE: 'prod' });
  });

  it('every use of an anchor is its own copy', () => {
    const compose = makeCompose(`
x-env: &env
  MODE: prod
services:
  web:
    image: web
    environment: *env
  api:
    image: api
    environment: *env
`);
    record(compose.services.web.environment).MODE = 'changed';

    expect(record(compose.services.api.environment).MODE).toBe('prod');
  });
});

describe('U-SWARM-02: string-typed scalars keep their source text', () => {
  it('PORT: 010 stays "010" at every string-typed path', () => {
    const compose = makeCompose(`
services:
  web:
    image: web
    environment:
      PORT: 010
    labels:
      PORT: 010
    annotations:
      PORT: 010
    sysctls:
      net.core.somaxconn: 010
    extra_hosts:
      db: 010
    build:
      context: .
      args:
        PORT: 010
    deploy:
      labels:
        PORT: 010
volumes:
  data:
    labels:
      PORT: 010
    driver_opts:
      size: 010
`);
    const web = compose.services.web;
    expect(record(web.environment).PORT).toBe('010');
    expect(record(web.labels).PORT).toBe('010');
    expect(record(web.annotations).PORT).toBe('010');
    expect(record(web.sysctls)['net.core.somaxconn']).toBe('010');
    expect(record(web.extra_hosts).db).toBe('010');
    expect(record(record(web.build).args).PORT).toBe('010');
    expect(record(record(web.deploy).labels).PORT).toBe('010');
    const data = record(compose.volumes?.data);
    expect(record(data.labels).PORT).toBe('010');
    expect(record(data.driver_opts).size).toBe('010');
  });

  it('numbers and booleans keep their text, null stays unset (YAML-10, YAML-11)', () => {
    const compose = makeCompose(`
services:
  web:
    image: web
    environment:
      V: 1.10
      B: true
      H: 0x1F
      E: 1e3
      I: .inf
      N: ~
      EMPTY:
      Q: "007"
      S: text
`);
    expect(compose.services.web.environment).toEqual({
      V: '1.10',
      B: 'true',
      H: '0x1F',
      E: '1e3',
      I: '.inf',
      N: null,
      EMPTY: null,
      Q: '007',
      S: 'text',
    });
  });

  it('a value written under an anchor keeps its text wherever it is merged or aliased', () => {
    const compose = makeCompose(`
x-env: &env
  PORT: 010
x-base: &base
  environment:
    DEBUG: false
services:
  web:
    image: web
    environment: *env
  api:
    <<: *base
    image: api
`);
    expect(record(compose.services.web.environment).PORT).toBe('010');
    expect(record(compose.services.api.environment).DEBUG).toBe('false');
    expect(record(compose.raw['x-env']).PORT).toBe(10);
  });

  it('leaves numbers alone outside the string-typed paths', () => {
    const compose = makeCompose(`
services:
  web:
    image: web
    environment:
      - PORT=010
    deploy:
      replicas: 010
    stop_grace_period: 10
`);
    expect(compose.services.web.environment).toEqual(['PORT=010']);
    expect(record(compose.services.web.deploy).replicas).toBe(10);
    expect(compose.services.web.stop_grace_period).toBe(10);
  });

  it('an explicit core tag is the user\'s choice of type', () => {
    const compose = makeCompose('services:\n  web:\n    image: web\n    environment:\n      PORT: !!int 010\n');

    expect(record(compose.services.web.environment).PORT).toBe(10);
  });

  it('x-dockflow node_selector, pod_labels and toleration values keep their text (YAML-16)', () => {
    const compose = makeCompose(`
services:
  web:
    image: web
    x-dockflow:
      node_selector: {ssd: true}
      pod_labels: {tier: 1}
      tolerations:
        - {key: a, value: 2, effect: NoSchedule, toleration_seconds: 30}
`);
    const extension = record(compose.services.web['x-dockflow']);
    expect(extension.node_selector).toEqual({ ssd: 'true' });
    expect(extension.pod_labels).toEqual({ tier: '1' });
    expect(extension.tolerations).toEqual([{ key: 'a', value: '2', effect: 'NoSchedule', toleration_seconds: 30 }]);
  });
});

describe('U-SWARM-03: octal file modes', () => {
  const octalModes = `
services:
  web:
    image: web
    secrets:
      - source: token
        mode: 0440
    configs:
      - source: app
        mode: 0o640
    volumes:
      - type: tmpfs
        target: /cache
        tmpfs:
          mode: 01777
`;

  function modes(compose: ParsedCompose): unknown[] {
    const web = compose.services.web;
    return [
      record((web.secrets as unknown[])[0]).mode,
      record((web.configs as unknown[])[0]).mode,
      record(record((web.volumes as unknown[])[0]).tmpfs).mode,
    ];
  }

  it('mode: 0440 keeps its source text for secrets, configs and tmpfs', () => {
    // a number would be indistinguishable from a decimal mode written without the leading 0
    expect(modes(makeCompose(octalModes))).toEqual(['0440', '0o640', '01777']);
  });

  it('serialize writes octal modes as the numbers docker/cli reads (0440 -> 288)', () => {
    const compose = makeCompose(octalModes);
    const text = serialize(compose);

    expect(text).toContain('mode: 288\n');
    expect(text).toContain('mode: 416\n');
    expect(text).toContain('mode: 1023\n');
    expect(modes(loadFromString(text))).toEqual([0o440, 0o640, 0o1777]);
    expect(modes(compose)).toEqual(['0440', '0o640', '01777']);
  });

  it('mode: 440 stays decimal and a quoted mode stays a string', () => {
    const compose = makeCompose(`
services:
  web:
    image: web
    secrets:
      - source: token
        mode: 440
      - source: other
        mode: "0440"
      - source: zero
        mode: 0
      - source: text
        mode: "440"
`);
    const secrets = compose.services.web.secrets as unknown[];
    expect(record(secrets[0]).mode).toBe(440);
    expect(record(secrets[1]).mode).toBe('0440');
    expect(record(secrets[2]).mode).toBe(0);
    expect(record(secrets[3]).mode).toBe('440');

    const serialized = loadFromString(serialize(compose)).services.web.secrets as unknown[];
    expect(serialized.map((secret) => record(secret).mode)).toEqual([440, 0o440, 0, '440']);
  });

  it('serialize converts modes on the file-mode paths only', () => {
    const compose = makeCompose(`
x-mode: &mode "0440"
services:
  web:
    image: web
    environment:
      mode: "0440"
    secrets:
      - token
      - source: other
        mode: *mode
`);
    const reloaded = loadFromString(serialize(compose));

    expect(reloaded.raw['x-mode']).toBe('0440');
    expect(record(reloaded.services.web.environment).mode).toBe('0440');
    expect(reloaded.services.web.secrets).toEqual(['token', { source: 'other', mode: 0o440 }]);
  });

  it('a mode written under an anchor is converted where it is used', () => {
    const compose = makeCompose(`
x-secret: &secret
  source: token
  mode: 0400
services:
  web:
    image: web
    secrets:
      - *secret
`);
    expect(record((compose.services.web.secrets as unknown[])[0]).mode).toBe('0400');
    // outside the file-mode paths YAML 1.2 applies: 0400 is decimal 400
    expect(record(compose.raw['x-secret']).mode).toBe(400);
  });
});

describe('updateImageTags', () => {
  const baseConfig = { project_name: 'demo' } as DockflowConfig;
  const registryConfig = {
    ...baseConfig,
    registry: { type: 'custom', enabled: true, url: 'registry.example.com', namespace: 'team', password: 'secret' },
  } as DockflowConfig;

  it('auto-tag (default): strips tag, appends env and version', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: my-api:old\n');
    updateImageTags(compose, baseConfig, 'production', '1.2.3');
    expect(compose.services.api.image).toBe('my-api-production:1.2.3');
  });

  it('auto-tag on image without tag', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: my-api\n');
    updateImageTags(compose, baseConfig, 'staging', '2.0.0');
    expect(compose.services.api.image).toBe('my-api-staging:2.0.0');
  });

  it('image_auto_tag=false keeps original image', () => {
    const config = { ...baseConfig, options: { image_auto_tag: false } } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: my-api:pinned\n');
    updateImageTags(compose, config, 'production', '1.2.3');
    expect(compose.services.api.image).toBe('my-api:pinned');
  });

  it('services without image are left untouched', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0');
    expect(compose.services.api.image).toBeUndefined();
  });

  it('U-SWARM-04: a pulled image (no build section) keeps its reference', () => {
    const compose = makeCompose(`
services:
  api:
    build:
      context: .
    image: my-api:old
  db:
    image: postgres:16
  cache:
    image: redis
`);
    updateImageTags(compose, registryConfig, 'production', '1.2.3');

    expect(compose.services.api.image).toBe('registry.example.com/team/my-api-production:1.2.3');
    expect(compose.services.db.image).toBe('postgres:16');
    expect(compose.services.cache.image).toBe('redis');
  });

  it('an empty build section is not a build', () => {
    const compose = makeCompose('services:\n  api:\n    build:\n    image: my-api\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('my-api');
  });

  it('registry mode prepends registry prefix with namespace', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: my-api\n');
    updateImageTags(compose, registryConfig, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('registry.example.com/team/my-api-production:1.0.0');
  });

  it('no registry prefix when the registry password is missing (images are imported instead)', () => {
    const config = {
      ...baseConfig,
      registry: { type: 'custom', enabled: true, url: 'registry.example.com', namespace: 'team' },
    } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: my-api\n');
    updateImageTags(compose, config, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('my-api-production:1.0.0');
  });

  it('registry not prepended when image already has a registry domain', () => {
    const config = {
      ...registryConfig,
      options: { image_auto_tag: false },
    } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: ghcr.io/org/my-api:1.0\n');
    updateImageTags(compose, config, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('ghcr.io/org/my-api:1.0');
  });

  it('servicesFilter only updates listed services', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: api\n  worker:\n    build: .\n    image: worker\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0', 'api');
    expect(compose.services.api.image).toBe('api-production:1.0.0');
    expect(compose.services.worker.image).toBe('worker');
  });

  it('updates raw.services so serialization reflects changes', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n    image: api\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0');
    const reparsed = makeCompose(serialize(compose));
    expect(reparsed.services.api.image).toBe('api-production:1.0.0');
  });
});

describe('usesRegistry', () => {
  const withRegistry = (registry: Record<string, unknown> | undefined): DockflowConfig =>
    ({ project_name: 'demo', registry }) as DockflowConfig;

  it('is true only when the registry is enabled with a URL and a password', () => {
    expect(usesRegistry(withRegistry({ type: 'custom', enabled: true, url: 'registry.example.com', password: 'p' }))).toBe(true);
    expect(usesRegistry(withRegistry({ type: 'custom', enabled: true, url: 'registry.example.com' }))).toBe(false);
    expect(usesRegistry(withRegistry({ type: 'custom', enabled: true, password: 'p' }))).toBe(false);
    expect(usesRegistry(withRegistry({ type: 'custom', enabled: false, url: 'registry.example.com', password: 'p' }))).toBe(false);
    expect(usesRegistry(withRegistry({ type: 'custom', url: 'registry.example.com', password: 'p' }))).toBe(false);
    expect(usesRegistry(withRegistry(undefined))).toBe(false);
  });
});

describe('stripBuildSections', () => {
  it('removes build from every service', () => {
    const compose = makeCompose(`
services:
  app:
    image: app
    build:
      context: ../..
      dockerfile: Dockerfile.app
  worker:
    image: worker
    build: ../..
`);

    stripBuildSections(compose);

    expect(compose.services.app).not.toHaveProperty('build');
    expect(compose.services.worker).not.toHaveProperty('build');
  });

  it('leaves the rest of the service untouched', () => {
    const compose = makeCompose(`
services:
  app:
    image: app
    build: ../..
    ports:
      - "80:80"
`);

    stripBuildSections(compose);

    expect(compose.services.app.image).toBe('app');
    expect(compose.services.app.ports).toEqual(['80:80']);
  });

  it('is a no-op on services without build', () => {
    const compose = makeCompose(`
services:
  app:
    image: app
`);

    stripBuildSections(compose);

    expect(compose.services.app).toEqual({ image: 'app' });
  });
});

describe('DEFAULT_UPDATE_CONFIG', () => {
  it('is exported with Dockflow\'s app update defaults and cannot be changed', () => {
    expect(DEFAULT_UPDATE_CONFIG).toEqual({
      parallelism: 1,
      delay: '10s',
      failure_action: 'rollback',
      monitor: '30s',
      max_failure_ratio: 0,
      order: 'start-first',
    });
    expect(Object.isFrozen(DEFAULT_UPDATE_CONFIG)).toBe(true);
  });
});

describe('injectSwarmDefaults', () => {
  it('injects default update_config and rollback_config', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n');
    injectSwarmDefaults(compose);
    const deploy = compose.services.web.deploy as Record<string, Record<string, unknown>>;
    expect(deploy.update_config).toEqual({ ...DEFAULT_UPDATE_CONFIG });
    expect(deploy.update_config.failure_action).toBe('rollback');
    expect(deploy.update_config.order).toBe('start-first');
    expect(deploy.rollback_config.parallelism).toBe(1);
  });

  it('user values win over defaults (deep merge)', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    deploy:
      replicas: 3
      update_config:
        parallelism: 2
`);
    injectSwarmDefaults(compose);
    const deploy = compose.services.web.deploy as Record<string, unknown>;
    const update = deploy.update_config as Record<string, unknown>;
    expect(update.parallelism).toBe(2);          // user value preserved
    expect(update.failure_action).toBe('rollback'); // default filled in
    expect(deploy.replicas).toBe(3);             // unrelated user key untouched
  });
});

describe('injectAccessoriesDefaults', () => {
  it('Swarm: injects restart_policy and replicas=1 by default', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n');
    injectAccessoriesDefaults(compose, 'swarm');
    const deploy = compose.services.db.deploy as Record<string, unknown>;
    expect(deploy.replicas).toBe(1);
    expect((deploy.restart_policy as Record<string, unknown>).condition).toBe('on-failure');
  });

  it('Swarm: keeps user replicas and restart_policy values', () => {
    const compose = makeCompose(`
services:
  db:
    image: postgres
    deploy:
      replicas: 2
      restart_policy:
        max_attempts: 10
`);
    injectAccessoriesDefaults(compose, 'swarm');
    const deploy = compose.services.db.deploy as Record<string, unknown>;
    expect(deploy.replicas).toBe(2);
    const restart = deploy.restart_policy as Record<string, unknown>;
    expect(restart.max_attempts).toBe(10);
    expect(restart.condition).toBe('on-failure');
  });

  it('U-SWARM-12: a global accessory gets no replicas on either orchestrator', () => {
    for (const kind of ['swarm', 'k3s'] as const) {
      const compose = makeCompose('services:\n  agent:\n    image: agent\n    deploy:\n      mode: global\n');
      injectAccessoriesDefaults(compose, kind);
      const deploy = record(compose.services.agent.deploy);
      expect(deploy).not.toHaveProperty('replicas');
      expect(deploy.mode).toBe('global');
    }
  });

  it('a global-job accessory gets no replicas either (docker refuses them together)', () => {
    const compose = makeCompose('services:\n  init:\n    image: init\n    deploy:\n      mode: global-job\n');
    injectAccessoriesDefaults(compose, 'swarm');
    expect(record(compose.services.init.deploy)).not.toHaveProperty('replicas');
  });

  it('an accessory that sets scale gets no replicas to contradict it', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n    scale: 2\n');
    injectAccessoriesDefaults(compose, 'k3s');
    expect(record(compose.services.db.deploy)).not.toHaveProperty('replicas');
    expect(compose.services.db.scale).toBe(2);
  });

  it('U-SWARM-12: k3s injects replicas: 1 and nothing else, so no restart policy value is Dockflow\'s', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n    deploy:\n      replicas:\n');
    injectAccessoriesDefaults(compose, 'k3s');

    expect(compose.services.db.deploy).toEqual({ replicas: 1 });
    expect(compose.services.cache.deploy).toEqual({ replicas: 1 });
  });

  it('k3s keeps a written restart_policy exactly as written', () => {
    const compose = makeCompose(`
services:
  db:
    image: postgres
    deploy:
      replicas: 1
      restart_policy:
        max_attempts: 3
`);
    injectAccessoriesDefaults(compose, 'k3s');
    expect(compose.services.db.deploy).toEqual({ replicas: 1, restart_policy: { max_attempts: 3 } });
  });

  it('leaves a malformed service or deploy for the normalizer to refuse', () => {
    const compose = makeCompose('services:\n  empty:\n  odd:\n    image: odd\n    deploy: invalid\n');
    injectAccessoriesDefaults(compose, 'k3s');
    expect(compose.services.empty).toBeNull();
    expect(compose.services.odd.deploy).toBe('invalid');
  });

  it('updates raw.services so serialization reflects changes', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n');
    injectAccessoriesDefaults(compose, 'k3s');
    expect(makeCompose(serialize(compose)).services.db.deploy).toEqual({ replicas: 1 });
  });
});

describe('injectTraefikLabels', () => {
  const proxy: ProxyConfig = {
    enabled: true,
    domains: { production: 'app.example.com' },
  } as ProxyConfig;

  it('does nothing when proxy disabled', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n    ports:\n      - "80"\n');
    injectTraefikLabels(compose, { enabled: false } as ProxyConfig, 'demo', 'production');
    expect(compose.services.web.deploy).toBeUndefined();
  });

  it('does nothing when no domain for env', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n    ports:\n      - "80"\n');
    injectTraefikLabels(compose, proxy, 'demo', 'staging');
    expect(compose.services.web.deploy).toBeUndefined();
  });

  it('skips services without ports', () => {
    const compose = makeCompose('services:\n  worker:\n    image: worker\n');
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    expect(compose.services.worker.deploy).toBeUndefined();
    expect(compose.networks).toBeUndefined();
  });

  it('injects router labels, network and external traefik network', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n');
    injectTraefikLabels(compose, proxy, 'demo', 'production');

    const deploy = compose.services.web.deploy as Record<string, unknown>;
    const labels = deploy.labels as string[];
    expect(labels).toContain('traefik.enable=true');
    expect(labels).toContain('traefik.http.routers.demo-web.rule=Host(`app.example.com`)');
    expect(labels).toContain('traefik.http.services.demo-web.loadbalancer.server.port=80');
    // acme defaults to true → websecure + certresolver
    expect(labels).toContain('traefik.http.routers.demo-web.entrypoints=websecure');
    expect(labels).toContain('traefik.http.routers.demo-web.tls.certresolver=letsencrypt');

    expect(compose.services.web.networks).toEqual(['default', TRAEFIK_NETWORK_NAME]);
    expect((compose.networks as Record<string, unknown>)[TRAEFIK_NETWORK_NAME]).toEqual({ external: true });
  });

  it('acme=false uses web entrypoint without certresolver', () => {
    const noAcme = { ...proxy, acme: false } as ProxyConfig;
    const compose = makeCompose('services:\n  web:\n    image: nginx\n    ports:\n      - "80"\n');
    injectTraefikLabels(compose, noAcme, 'demo', 'production');
    const labels = (compose.services.web.deploy as Record<string, unknown>).labels as string[];
    expect(labels).toContain('traefik.http.routers.demo-web.entrypoints=web');
    expect(labels.some(l => l.includes('certresolver'))).toBe(false);
  });

  it('preserves existing array labels', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
    deploy:
      labels:
        - "custom=1"
`);
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    const labels = (compose.services.web.deploy as Record<string, unknown>).labels as string[];
    expect(labels).toContain('custom=1');
    expect(labels).toContain('traefik.enable=true');
  });

  it('converts existing object labels to key=value list', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
    deploy:
      labels:
        custom: "1"
`);
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    const labels = (compose.services.web.deploy as Record<string, unknown>).labels as string[];
    expect(labels).toContain('custom=1');
  });

  it('merges traefik network into existing array networks without duplicates', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
    networks:
      - backend
`);
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    expect(compose.services.web.networks).toEqual(['backend', TRAEFIK_NETWORK_NAME]);
  });

  it('merges traefik network into existing object networks', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
    networks:
      backend:
        aliases: [api]
`);
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    const nets = compose.services.web.networks as Record<string, unknown>;
    expect(Object.keys(nets)).toContain('backend');
    expect(Object.keys(nets)).toContain(TRAEFIK_NETWORK_NAME);
  });
});

describe('filterServices', () => {
  it('keeps only listed services, preserves networks/volumes', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
  worker:
    image: worker
networks:
  net: {}
volumes:
  data: {}
`);
    const filtered = filterServices(compose, ['web']);
    expect(Object.keys(filtered.services)).toEqual(['web']);
    expect(filtered.networks).toHaveProperty('net');
    expect(filtered.volumes).toHaveProperty('data');
  });

  it('unknown name filters everything out', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n');
    expect(Object.keys(filterServices(compose, ['nope']).services)).toEqual([]);
  });
});

describe('syncNonTargetedImageTags', () => {
  it('non-targeted services take the server image, targeted keep local', () => {
    const local = makeCompose('services:\n  web:\n    image: web-prod:2.0.0\n  api:\n    image: api-prod:2.0.0\n');
    const server = makeCompose('services:\n  web:\n    image: web-prod:1.0.0\n  api:\n    image: api-prod:1.0.0\n');
    const result = syncNonTargetedImageTags(local, server, ['web']);
    expect(result.services.web.image).toBe('web-prod:2.0.0');  // targeted → local
    expect(result.services.api.image).toBe('api-prod:1.0.0');  // not targeted → server
  });

  it('service new locally (absent on server) keeps local tag', () => {
    const local = makeCompose('services:\n  newsvc:\n    image: newsvc:1.0.0\n');
    const server = makeCompose('services: {}\n');
    const result = syncNonTargetedImageTags(local, server, ['other']);
    expect(result.services.newsvc.image).toBe('newsvc:1.0.0');
  });

  it('service removed locally is absent from result', () => {
    const local = makeCompose('services:\n  web:\n    image: web:1\n');
    const server = makeCompose('services:\n  web:\n    image: web:1\n  old:\n    image: old:1\n');
    const result = syncNonTargetedImageTags(local, server, ['web']);
    expect(result.services.old).toBeUndefined();
  });
});

describe('getExternalNetworks / getExternalVolumes', () => {
  it('returns only external resources', () => {
    const compose = makeCompose(`
services: {}
networks:
  pub:
    external: true
  internal: {}
volumes:
  shared:
    external: true
  local: {}
`);
    expect(getExternalNetworks(compose)).toEqual(['pub']);
    expect(getExternalVolumes(compose)).toEqual(['shared']);
  });

  it('returns the name Docker knows the resource by when one is written', () => {
    const compose = makeCompose(`
services: {}
networks:
  pub:
    external: true
    name: shared-public
volumes:
  shared:
    external: true
    name: "team data"
`);
    expect(getExternalNetworks(compose)).toEqual(['shared-public']);
    expect(getExternalVolumes(compose)).toEqual(['team data']);
  });

  it('returns empty arrays when sections are missing', () => {
    const compose = makeCompose('services: {}\n');
    expect(getExternalNetworks(compose)).toEqual([]);
    expect(getExternalVolumes(compose)).toEqual([]);
  });

  it('null-valued network entries are not external', () => {
    const compose = makeCompose('services: {}\nnetworks:\n  plain:\n');
    expect(getExternalNetworks(compose)).toEqual([]);
  });
});

describe('getImages', () => {
  it('deduplicates and skips services without image', () => {
    const compose = makeCompose(`
services:
  a:
    image: shared:1
  b:
    image: shared:1
  c:
    build: .
  d:
    image: other:2
`);
    expect(getImages(compose).sort()).toEqual(['other:2', 'shared:1']);
  });
});
