import { describe, expect, it, spyOn } from 'bun:test';
import { parse } from 'yaml';
import * as Compose from '../services/compose';
import { loadFromString, serialize } from '../services/compose';
import { SwarmStackBackend } from '../services/orchestrator/swarm/swarm-stack';
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

  it('renders an input once: the release and the deploy share it, and its warnings print once', () => {
    const inject = spyOn(Compose, 'injectTraefikLabels');
    try {
      const backend = new SwarmStackBackend(conn);
      const input = { stackName: 'demo-production', env: 'production', compose: compose(), proxy };
      const first = backend.render(input);
      expect(backend.render({ ...input, compose: compose() })).toBe(first);
      expect(inject).toHaveBeenCalledTimes(1);

      backend.render({ ...input, servicesFilter: ['web'] });
      expect(inject).toHaveBeenCalledTimes(2);
    } finally {
      inject.mockRestore();
    }
  });
});
