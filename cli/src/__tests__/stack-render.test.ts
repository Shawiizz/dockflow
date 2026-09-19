import { describe, expect, it } from 'bun:test';
import { parse } from 'yaml';
import { loadFromString, serialize, type ParsedCompose } from '../services/compose';
import type {
  ClusterNodeRef,
  OrchestratorTarget,
  StackDeployInput,
  StackRole,
} from '../services/orchestrator/interfaces';
import { SWARM_ARTIFACT_HEADER, SwarmStackBackend } from '../services/orchestrator/swarm/swarm-stack';
import { sha256Hex } from '../utils/hash';

type ProxyConfig = NonNullable<StackDeployInput['proxy']>;

const manager: ClusterNodeRef = {
  name: 'manager-1',
  role: 'manager',
  host: '10.0.0.1',
  privateHost: '10.0.0.1',
  connection: { host: '10.0.0.1', port: 22, user: 'deploy', privateKey: 'unused' },
};

const target: OrchestratorTarget = {
  kind: 'swarm',
  project: 'shop',
  env: 'production',
  stackName: 'shop-production',
  controlPlane: manager,
  managers: [manager],
  workers: [],
  probes: [],
};

const proxy: ProxyConfig = { enabled: true, acme: false, domains: { production: 'app.example.com' } };

const compose = (): ParsedCompose =>
  loadFromString(
    'services:\n  web:\n    image: web:1\n    build:\n      context: .\n    ports:\n      - "3000:3000"\n  worker:\n    image: worker:1\n',
  );

function input(role: StackRole, source: ParsedCompose, overrides: Partial<StackDeployInput> = {}): StackDeployInput {
  return {
    ref: { project: 'shop', env: 'production', role },
    version: '1.4.2',
    compose: source,
    proxy,
    services: null,
    previousVersion: null,
    force: false,
    images: { built: [], mode: 'none', pullSecretName: null },
    helm: [],
    helmDeclared: [],
    sibling: { services: [], volumes: [], middlewares: [] },
    serverNames: ['manager-1'],
    files: () => ({ ok: false, reason: 'missing' }),
    rebindVolumes: false,
    traefikOnCluster: false,
    ...overrides,
  };
}

/** render never touches SSH; an SSH call would throw */
const backend = (): SwarmStackBackend =>
  new SwarmStackBackend(target, {
    ssh: {
      exec: () => Promise.reject(new Error('render must not run remote commands')),
      channel: () => Promise.reject(new Error('render must not run remote commands')),
      interactive: () => Promise.reject(new Error('render must not run remote commands')),
    },
  });

describe('SwarmStackBackend.render (U-SWARM-05)', () => {
  it('starts with the swarm-compose/1 header line, a YAML comment docker stack deploy reads past', () => {
    const artifact = backend().render(input('app', compose()));

    expect(artifact.content.startsWith(`${SWARM_ARTIFACT_HEADER}\n`)).toBe(true);
    expect(SWARM_ARTIFACT_HEADER).toBe('# dockflow-artifact: swarm-compose/1');
    expect(artifact.format).toBe('swarm-compose/1');
    const withoutHeader = artifact.content.slice(SWARM_ARTIFACT_HEADER.length + 1);
    expect(parse(artifact.content)).toEqual(parse(withoutHeader));
  });

  it('is what Swarm receives: build removed, update defaults and routing injected', () => {
    const rendered = parse(backend().render(input('app', compose())).content);
    const web = rendered.services.web;

    expect(web.build).toBeUndefined();
    expect(web.deploy.update_config).toBeDefined();
    expect(web.deploy.rollback_config).toBeDefined();
    expect(web.deploy.labels).toContain('traefik.enable=true');
    expect(web.deploy.labels).toContain('traefik.http.routers.shop-production-web.rule=Host(`app.example.com`)');
    expect(rendered.networks['traefik-public']).toEqual({ external: true });
  });

  it('carries no Helm records nor diagnostics, and its digest covers content and records', () => {
    const artifact = backend().render(input('app', compose()));

    expect(artifact.role).toBe('app');
    expect(artifact.helm).toEqual([]);
    expect(artifact.diagnostics).toEqual([]);
    expect(artifact.digest).toBe(sha256Hex(`${artifact.content}\n[]`));
  });

  it('never mutates the compose it is given', () => {
    const source = compose();
    const before = serialize(source);

    backend().render(input('app', source));

    expect(serialize(source)).toBe(before);
  });

  it('renders the whole stack under --only, since the release stores it for rollbacks', () => {
    const rendered = parse(backend().render(input('app', compose(), { services: ['worker'] })).content);

    expect(Object.keys(rendered.services).sort()).toEqual(['web', 'worker']);
  });

  it('is deterministic and changes with the compose', () => {
    const first = new SwarmStackBackend(target).render(input('app', compose()));
    const second = new SwarmStackBackend(target).render(input('app', compose()));
    const changed = new SwarmStackBackend(target).render(
      input('app', loadFromString('services:\n  web:\n    image: web:2\n')),
    );

    expect(second.content).toBe(first.content);
    expect(second.digest).toBe(first.digest);
    expect(changed.digest).not.toBe(first.digest);
  });

  it('does not depend on the version, so accessories keep one digest across deploys', () => {
    const accessories = loadFromString('services:\n  db:\n    image: postgres:16\n');

    const a = backend().render(input('accessory', accessories, { version: '1.0.0' }));
    const b = new SwarmStackBackend(target).render(input('accessory', accessories, { version: '2.0.0' }));

    expect(b.digest).toBe(a.digest);
  });

  it('hands accessories over as given: no build removal, update defaults or routing', () => {
    const accessories = loadFromString(
      'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n    deploy:\n      replicas: 1\n',
    );

    const artifact = backend().render(input('accessory', accessories));

    expect(artifact.role).toBe('accessory');
    expect(artifact.content).toBe(`${SWARM_ARTIFACT_HEADER}\n${serialize(accessories)}`);
    const db = parse(artifact.content).services.db;
    expect(db.deploy).toEqual({ replicas: 1 });
  });

  it('routes nothing when the proxy is disabled', () => {
    const rendered = parse(backend().render(input('app', compose(), { proxy: { enabled: false } })).content);

    expect(rendered.services.web.deploy.labels).toBeUndefined();
    expect(rendered.networks).toBeUndefined();
  });
});
