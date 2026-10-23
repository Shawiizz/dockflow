import { describe, expect, it } from 'bun:test';
import { hasServices, loadFromString, serialize } from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import { ConfigError } from '../utils/errors';

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

  it('an empty file or a file of comments is a stack without services', () => {
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

  it('core-schema tags keep their meaning', () => {
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

describe('loadFromString refusals', () => {
  it('a duplicate key names the key and its line', () => {
    const error = loadError('services:\n  web:\n    image: a\n    image: b\n', 'docker-compose.yml');

    expect(error.message).toBe('docker-compose.yml: duplicate key image at line 4');
  });

  it('names the source as "compose file" when the caller gives no file name', () => {
    expect(loadError('services:\n  web:\n    image: a\n    image: b\n').message).toBe(
      'compose file: duplicate key image at line 4',
    );
  });

  it('two documents are refused', () => {
    const error = loadError('services: {}\n---\nservices: {}\n', 'accessories.yml');

    expect(error.message).toBe('accessories.yml: the file contains several YAML documents; keep one');
  });

  it('!reset and !override are refused with the line and a fix', () => {
    const reset = loadError('services:\n  web:\n    image: a\n    ports: !reset []\n', 'docker-compose.yml');
    expect(reset.message).toBe(
      'docker-compose.yml: tag !reset at line 4 is only meaningful in Compose override files; Dockflow reads a single file',
    );
    expect(reset.suggestion).toBe('Remove the tag and write the final value.');

    const override = loadError('services:\n  web:\n    image: a\n    ports: !override ["80"]\n');
    expect(override.message).toContain('tag !override at line 4 is only meaningful in Compose override files');
  });

  it('an alias without an anchor is refused instead of throwing a ReferenceError', () => {
    const error = loadError('services:\n  web: *nope\n', 'docker-compose.yml');

    expect(error.message).toBe('docker-compose.yml: unresolved alias *nope at line 2');
  });

  it('an alias inside the value it names is refused instead of looping', () => {
    for (const text of ['x-a: &a {b: *a}\n', 'x-a: &a [1, *a]\n', 'x-a: &a\n  <<: *a\n  image: x\n']) {
      const error = loadError(text);
      expect(error.message).toMatch(/^compose file: alias \*a at line \d+ is inside the value it refers to$/);
    }
  });

  it('!!binary is refused at load with its line', () => {
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

describe('merge keys and aliases are resolved at load', () => {
  it('<<: *anchor is merged, and a written key wins over the merged one', () => {
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

  it('<<: [*a, *b] takes the first map that defines a key', () => {
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

describe('string-typed scalars keep their source text', () => {
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
});

describe('octal file modes', () => {
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
