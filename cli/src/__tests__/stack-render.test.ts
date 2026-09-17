import { describe, expect, it } from 'bun:test';
import { parse, parseAllDocuments } from 'yaml';
import { loadFromString, serialize } from '../services/compose';
import { SwarmStackBackend } from '../services/orchestrator/swarm/swarm-stack';
import { K3sStackBackend } from '../services/orchestrator/k3s/k3s-stack';
import type { ProxyConfig } from '../utils/config';

const conn = { host: 'h', port: 22, user: 'u', privateKey: 'k' };
const proxy: ProxyConfig = { enabled: true, acme: false, domains: { production: 'app.example.com' } } as ProxyConfig;

const compose = () =>
  loadFromString(
    'services:\n  web:\n    image: web:1\n    build:\n      context: .\n    ports:\n      - "3000:3000"\n  worker:\n    image: worker:1\n',
  );

describe('SwarmStackBackend.render', () => {
  it('is what Swarm receives: build removed, defaults and routing injected', () => {
    const rendered = parse(new SwarmStackBackend(conn).render({ stackName: 'demo-production', env: 'production', compose: compose(), proxy }));
    const web = rendered.services.web;

    expect(web.build).toBeUndefined();
    expect(web.deploy.update_config).toBeDefined();
    expect(web.deploy.labels).toContain('traefik.enable=true');
  });

  it('never mutates the compose it is given', () => {
    const input = compose();
    const before = serialize(input);

    new SwarmStackBackend(conn).render({ stackName: 'demo-production', env: 'production', compose: input, proxy });

    expect(serialize(input)).toBe(before);
  });

  it('keeps only the targeted services under a filter', () => {
    const rendered = parse(
      new SwarmStackBackend(conn).render({ stackName: 'demo-production', env: 'production', compose: compose(), servicesFilter: ['worker'] }),
    );

    expect(Object.keys(rendered.services)).toEqual(['worker']);
  });
});

describe('K3sStackBackend.render', () => {
  it('produces manifests, which is what a rollback hands back to kubectl', () => {
    const out = new K3sStackBackend(conn).render({ stackName: 'demo-production', env: 'production', compose: compose(), proxy });
    const documents = parseAllDocuments(out).map((d) => d.toJS() as Record<string, unknown>);

    expect(documents.map((d) => d.kind)).toContain('Deployment');
    expect(documents.map((d) => d.kind)).toContain('IngressRoute');
    expect(documents.every((d) => typeof d.apiVersion === 'string' && !('services' in d))).toBe(true);
  });

  it('never mutates the compose it is given', () => {
    const input = compose();
    const before = serialize(input);

    new K3sStackBackend(conn).render({ stackName: 'demo-production', env: 'production', compose: input, proxy });

    expect(serialize(input)).toBe(before);
  });
});
