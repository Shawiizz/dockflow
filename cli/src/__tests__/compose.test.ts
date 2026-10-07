import { describe, expect, it } from 'bun:test';
import {
  parseImageRef,
  parseContainerPort,
  loadFromString,
  serialize,
  updateImageTags,
  injectSwarmDefaults,
  stripBuildSections,
  injectAccessoriesDefaults,
  injectTraefikLabels,
  checkProxyRoutes,
  filterServices,
  syncNonTargetedImageTags,
  getExternalNetworks,
  getExternalVolumes,
  hasServices,
  getImages,
} from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import type { DockflowConfig, ProxyConfig } from '../utils/config';
import { TRAEFIK_NETWORK_NAME } from '../constants';

function makeCompose(yaml: string): ParsedCompose {
  return loadFromString(yaml);
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

  it('serialize round-trips service changes', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n');
    compose.services.web = { ...compose.services.web, image: 'nginx:1.25' };
    const out = serialize(compose);
    const reparsed = makeCompose(out);
    expect(reparsed.services.web.image).toBe('nginx:1.25');
  });
});

describe('updateImageTags', () => {
  const baseConfig = { project_name: 'demo' } as DockflowConfig;

  it('auto-tag (default): strips tag, appends env and version', () => {
    const compose = makeCompose('services:\n  api:\n    image: my-api:old\n');
    updateImageTags(compose, baseConfig, 'production', '1.2.3');
    expect(compose.services.api.image).toBe('my-api-production:1.2.3');
  });

  it('auto-tag on image without tag', () => {
    const compose = makeCompose('services:\n  api:\n    image: my-api\n');
    updateImageTags(compose, baseConfig, 'staging', '2.0.0');
    expect(compose.services.api.image).toBe('my-api-staging:2.0.0');
  });

  it('image_auto_tag=false keeps original image', () => {
    const config = { ...baseConfig, options: { image_auto_tag: false } } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    image: my-api:pinned\n');
    updateImageTags(compose, config, 'production', '1.2.3');
    expect(compose.services.api.image).toBe('my-api:pinned');
  });

  it('services without image are left untouched', () => {
    const compose = makeCompose('services:\n  api:\n    build: .\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0');
    expect(compose.services.api.image).toBeUndefined();
  });

  it('registry enabled prepends registry prefix with namespace', () => {
    const config = {
      ...baseConfig,
      registry: { enabled: true, url: 'registry.example.com', namespace: 'team' },
    } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    image: my-api\n');
    updateImageTags(compose, config, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('registry.example.com/team/my-api-production:1.0.0');
  });

  it('registry not prepended when image already has a registry domain', () => {
    const config = {
      ...baseConfig,
      options: { image_auto_tag: false },
      registry: { enabled: true, url: 'registry.example.com' },
    } as DockflowConfig;
    const compose = makeCompose('services:\n  api:\n    image: ghcr.io/org/my-api:1.0\n');
    updateImageTags(compose, config, 'production', '1.0.0');
    expect(compose.services.api.image).toBe('ghcr.io/org/my-api:1.0');
  });

  it('servicesFilter only updates listed services', () => {
    const compose = makeCompose('services:\n  api:\n    image: api\n  worker:\n    image: worker\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0', 'api');
    expect(compose.services.api.image).toBe('api-production:1.0.0');
    expect(compose.services.worker.image).toBe('worker');
  });

  it('updates raw.services so serialization reflects changes', () => {
    const compose = makeCompose('services:\n  api:\n    image: api\n');
    updateImageTags(compose, baseConfig, 'production', '1.0.0');
    const reparsed = makeCompose(serialize(compose));
    expect(reparsed.services.api.image).toBe('api-production:1.0.0');
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

describe('injectSwarmDefaults', () => {
  it('injects default update_config and rollback_config', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n');
    injectSwarmDefaults(compose);
    const deploy = compose.services.web.deploy as Record<string, Record<string, unknown>>;
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
  it('injects restart_policy and replicas=1 by default', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n');
    injectAccessoriesDefaults(compose);
    const deploy = compose.services.db.deploy as Record<string, unknown>;
    expect(deploy.replicas).toBe(1);
    expect((deploy.restart_policy as Record<string, unknown>).condition).toBe('on-failure');
  });

  it('keeps user replicas and restart_policy values', () => {
    const compose = makeCompose(`
services:
  db:
    image: postgres
    deploy:
      replicas: 2
      restart_policy:
        max_attempts: 10
`);
    injectAccessoriesDefaults(compose);
    const deploy = compose.services.db.deploy as Record<string, unknown>;
    expect(deploy.replicas).toBe(2);
    const restart = deploy.restart_policy as Record<string, unknown>;
    expect(restart.max_attempts).toBe(10);
    expect(restart.condition).toBe('on-failure');
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

  it('leaves a service that sets traefik.enable=false alone, in either label form', () => {
    for (const labels of ['      - "traefik.enable=false"\n', '        traefik.enable: "False"\n', '      - "traefik.enable=0"\n']) {
      const compose = makeCompose(`services:\n  game:\n    image: game\n    ports:\n      - "25000:25000"\n    deploy:\n      labels:\n${labels}`);
      const before = structuredClone(compose.services.game);
      injectTraefikLabels(compose, proxy, 'demo', 'production');
      expect(compose.services.game).toEqual(before);
      expect(compose.networks).toBeUndefined();
    }
  });

  it('keeps the labels a service sets itself over the injected ones', () => {
    const compose = makeCompose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
    deploy:
      labels:
        - "traefik.http.routers.demo-web.rule=Host(\`www.example.com\`)"
        - "traefik.http.services.demo-web.loadbalancer.server.port=8081"
`);
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    const labels = (compose.services.web.deploy as Record<string, unknown>).labels as string[];
    expect(labels.filter((l) => l.startsWith('traefik.http.routers.demo-web.rule='))).toEqual(['traefik.http.routers.demo-web.rule=Host(`www.example.com`)']);
    expect(labels.filter((l) => l.startsWith('traefik.http.services.demo-web.loadbalancer.server.port='))).toEqual([
      'traefik.http.services.demo-web.loadbalancer.server.port=8081',
    ]);
    expect(labels).toContain('traefik.enable=true');
    expect(labels).toContain('traefik.http.routers.demo-web.entrypoints=websecure');
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

  it('routes the container port of a long syntax ports entry', () => {
    const compose = makeCompose('services:\n  web:\n    image: nginx\n    ports:\n      - target: 80\n        published: 8080\n');
    injectTraefikLabels(compose, proxy, 'demo', 'production');
    const labels = (compose.services.web.deploy as Record<string, unknown>).labels as string[];
    expect(labels).toContain('traefik.http.services.demo-web.loadbalancer.server.port=80');
  });
});

describe('injectTraefikLabels — proxy.routes', () => {
  const panel = `
services:
  game:
    image: game
    ports:
      - "25000:25000"
  panel:
    image: panel
    expose:
      - "4326"
`;
  const proxy = {
    enabled: true,
    domains: { production: 'app.example.com' },
    routes: [
      { service: 'panel', domains: { production: 'panel.example.com', staging: 'panel.staging.example.com' } },
      { service: 'panel', domains: { production: 'panel.example.com' }, path: '/ws', port: 4327 },
    ],
  } as ProxyConfig;

  const labelsOf = (compose: ParsedCompose, service: string) =>
    ((compose.services[service].deploy as Record<string, unknown> | undefined)?.labels ?? []) as string[];

  it('gives each route a router and a Traefik service of its own, on the routed port', () => {
    const compose = makeCompose(panel);
    expect(injectTraefikLabels(compose, proxy, 'demo', 'production')).toBe(true);

    expect(labelsOf(compose, 'panel')).toEqual([
      'traefik.enable=true',
      `traefik.docker.network=${TRAEFIK_NETWORK_NAME}`,
      'traefik.http.routers.demo-panel-route1.rule=Host(`panel.example.com`)',
      'traefik.http.routers.demo-panel-route1.entrypoints=websecure',
      'traefik.http.routers.demo-panel-route1.service=demo-panel-route1',
      'traefik.http.services.demo-panel-route1.loadbalancer.server.port=4326',
      'traefik.http.routers.demo-panel-route1.tls.certresolver=letsencrypt',
      'traefik.http.routers.demo-panel-route2.rule=Host(`panel.example.com`) && PathPrefix(`/ws`)',
      'traefik.http.routers.demo-panel-route2.entrypoints=websecure',
      'traefik.http.routers.demo-panel-route2.service=demo-panel-route2',
      'traefik.http.services.demo-panel-route2.loadbalancer.server.port=4327',
      'traefik.http.routers.demo-panel-route2.tls.certresolver=letsencrypt',
    ]);
    expect(compose.services.panel.networks).toEqual(['default', TRAEFIK_NETWORK_NAME]);
    expect(compose.services.panel.ports).toBeUndefined();
    expect((compose.networks as Record<string, unknown>)[TRAEFIK_NETWORK_NAME]).toEqual({ external: true });
    // the other services keep the route on proxy.domains
    expect(labelsOf(compose, 'game')).toContain('traefik.http.routers.demo-game.rule=Host(`app.example.com`)');
  });

  it('keeps the numbering of a route in the environments that leave others out', () => {
    const compose = makeCompose(panel);
    injectTraefikLabels(compose, { ...proxy, acme: false } as ProxyConfig, 'demo', 'staging');
    expect(labelsOf(compose, 'panel')).toEqual([
      'traefik.enable=true',
      `traefik.docker.network=${TRAEFIK_NETWORK_NAME}`,
      'traefik.http.routers.demo-panel-route1.rule=Host(`panel.staging.example.com`)',
      'traefik.http.routers.demo-panel-route1.entrypoints=web',
      'traefik.http.routers.demo-panel-route1.service=demo-panel-route1',
      'traefik.http.services.demo-panel-route1.loadbalancer.server.port=4326',
    ]);
  });

  it('never gives a listed service the route on proxy.domains', () => {
    const compose = makeCompose(panel.replace('    expose:\n      - "4326"', '    ports:\n      - "4326:4326"'));
    injectTraefikLabels(compose, { ...proxy, domains: { development: 'dev.example.com' } } as ProxyConfig, 'demo', 'development');
    expect(compose.services.panel.deploy).toBeUndefined();
    expect(labelsOf(compose, 'game')).toContain('traefik.http.routers.demo-game.rule=Host(`dev.example.com`)');
  });

  it('routes only listed services without the default route, as for accessories', () => {
    const compose = makeCompose(panel);
    expect(injectTraefikLabels(compose, proxy, 'demo', 'production', { defaultRoute: false })).toBe(true);
    expect(compose.services.game.deploy).toBeUndefined();
    expect(labelsOf(compose, 'panel')).toContain('traefik.http.routers.demo-panel-route1.rule=Host(`panel.example.com`)');
  });

  it('leaves alone the routes of services the compose does not have', () => {
    const compose = makeCompose('services:\n  db:\n    image: postgres\n');
    expect(injectTraefikLabels(compose, proxy, 'demo', 'production', { defaultRoute: false })).toBe(false);
    expect(compose.services.db.deploy).toBeUndefined();
    expect(compose.networks).toBeUndefined();
  });

  it('skips a listed service that sets traefik.enable=false', () => {
    const compose = makeCompose(`${panel}    deploy:\n      labels:\n        - "traefik.enable=false"\n`);
    injectTraefikLabels(compose, proxy, 'demo', 'production', { defaultRoute: false });
    expect(labelsOf(compose, 'panel')).toEqual(['traefik.enable=false']);
    expect(compose.networks).toBeUndefined();
  });

  it('routes to the first published port when the route names none', () => {
    const compose = makeCompose('services:\n  panel:\n    image: panel\n    ports:\n      - "8080:4326"\n    expose:\n      - "9000"\n');
    injectTraefikLabels(compose, proxy, 'demo', 'staging');
    expect(labelsOf(compose, 'panel')).toContain('traefik.http.services.demo-panel-route1.loadbalancer.server.port=4326');
  });
});

describe('checkProxyRoutes', () => {
  const app = makeCompose('services:\n  web:\n    image: web\n    ports:\n      - "8080:80"\n  worker:\n    image: worker\n');
  const accessories = makeCompose('services:\n  panel:\n    image: panel\n    expose:\n      - "4326"\n');
  const base = { enabled: true, domains: { production: 'app.example.com' } } as ProxyConfig;
  const check = (routes: unknown[], env = 'production', accessoriesCompose: ParsedCompose | null = accessories) =>
    checkProxyRoutes({ ...base, routes } as ProxyConfig, env, 'demo', app, accessoriesCompose);

  it('accepts routes to services of either file, on paths of a shared domain', () => {
    expect(check([
      { service: 'panel', domains: { production: 'panel.example.com' } },
      { service: 'panel', domains: { production: 'panel.example.com' }, path: '/ws', port: 4327 },
      { service: 'worker', domains: { production: 'app.example.com' }, path: '/jobs', port: 9000 },
    ])).toEqual([]);
  });

  it('names the route of a service that is in neither file, or in both', () => {
    expect(check([{ service: 'pannel', domains: { production: 'panel.example.com' } }])).toEqual([
      'proxy.routes[0]: no service "pannel" in docker-compose.yml or accessories.yml',
    ]);
    expect(check([{ service: 'panel', domains: { production: 'panel.example.com' } }], 'production', null)).toEqual([
      'proxy.routes[0]: no service "panel" in docker-compose.yml or accessories.yml',
    ]);
    expect(check([{ service: 'web', domains: { production: 'web.example.com' } }], 'production', makeCompose('services:\n  web:\n    image: web\n'))).toEqual([
      'proxy.routes[0]: docker-compose.yml and accessories.yml both have a service "web"; rename one of them',
    ]);
  });

  it('asks for the port of a service that declares none', () => {
    expect(check([{ service: 'worker', domains: { production: 'jobs.example.com' } }])).toEqual([
      'proxy.routes[0]: service "worker" declares no port; set port to the one it listens on',
    ]);
  });

  it('refuses two routes on the same domain and path, whatever the case of the domain', () => {
    expect(check([
      { service: 'panel', domains: { production: 'panel.example.com' }, path: '/ws', port: 4327 },
      { service: 'worker', domains: { production: 'Panel.example.com' }, path: '/ws', port: 9000 },
    ])).toEqual(['proxy.routes[1]: proxy.routes[0] already routes panel.example.com/ws']);
  });

  it('refuses a route without a path on the domain where services already answer', () => {
    expect(check([{ service: 'panel', domains: { production: 'app.example.com' } }])).toEqual([
      'proxy.routes[0]: app.example.com is also proxy.domains.production, the domain of the default route (web); ' +
        'give the route a path, or add traefik.enable=false to deploy.labels of those services',
    ]);
    // once the route lists the only service there, nothing else answers on that domain
    expect(check([{ service: 'web', domains: { production: 'app.example.com' } }])).toEqual([]);
  });

  it('ignores the routes of other environments, and everything when the proxy is off', () => {
    expect(check([{ service: 'pannel', domains: { staging: 'panel.example.com' } }])).toEqual([]);
    expect(checkProxyRoutes({ enabled: false, routes: [{ service: 'pannel', domains: { production: 'x.example.com' } }] }, 'production', 'demo', app, null)).toEqual([]);
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
