import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { parse } from 'yaml';
import type { DeployContext } from '../commands/deploy-context';
import { displayRenderedStack } from '../commands/deploy-dry-run';
import { appStackInput, composeWithImageTags, keepRunningImageTags } from '../commands/deploy-phases';
import { loadFromString } from '../services/compose';
import { SwarmStack } from '../services/swarm/stack';
import type { DockflowConfig } from '../utils/config';
import * as output from '../utils/output';

const conn = { host: 'h', port: 22, user: 'u', privateKey: 'k' };

const COMPOSE = [
  'services:',
  '  web:',
  '    image: shop-web',
  '    build:',
  '      context: .',
  '    environment:',
  '      API_TOKEN: s3cr3t-token',
  '    ports:',
  '      - "3000:3000"',
  '  worker:',
  '    image: shop-worker',
  '    build:',
  '      context: .',
  '',
].join('\n');

const RUNNING = 'services:\n  web:\n    image: shop-web-production:1.1.0\n  worker:\n    image: shop-worker-production:1.1.0\n';

function context(overrides: { only?: string; deployApp?: boolean; running?: string | null; config?: Partial<DockflowConfig>; composeContent?: string } = {}): DeployContext {
  return {
    env: 'production',
    stackName: 'shop-production',
    deployVersion: '1.2.0',
    deployApp: overrides.deployApp ?? true,
    config: { project_name: 'shop', ...overrides.config } as DockflowConfig,
    options: { only: overrides.only },
    composeContent: overrides.composeContent ?? COMPOSE,
    swarm: new SwarmStack(conn),
    releases: { getCurrentComposeContent: async () => overrides.running ?? null },
  } as unknown as DeployContext;
}

describe('composeWithImageTags', () => {
  it('tags the images dockflow builds with the environment and the version', () => {
    const compose = composeWithImageTags(context());

    expect(compose.services.web.image).toBe('shop-web-production:1.2.0');
    expect(compose.services.worker.image).toBe('shop-worker-production:1.2.0');
  });

  it('tags only the services --only names', () => {
    const compose = composeWithImageTags(context({ only: 'web' }));

    expect(compose.services.web.image).toBe('shop-web-production:1.2.0');
    expect(compose.services.worker.image).toBe('shop-worker');
  });
});

describe('keepRunningImageTags', () => {
  it('changes nothing without --only', async () => {
    const ctx = context({ running: RUNNING });
    const compose = composeWithImageTags(ctx);

    expect((await keepRunningImageTags(ctx, compose)).services.worker.image).toBe('shop-worker-production:1.2.0');
  });

  it('gives the services --only leaves alone the tags of the running release', async () => {
    const ctx = context({ only: 'web', running: RUNNING });
    const compose = await keepRunningImageTags(ctx, composeWithImageTags(ctx));

    expect(compose.services.web.image).toBe('shop-web-production:1.2.0');
    expect(compose.services.worker.image).toBe('shop-worker-production:1.1.0');
  });

  it('keeps the local compose when no release runs yet', async () => {
    const ctx = context({ only: 'web', running: null });
    const compose = await keepRunningImageTags(ctx, composeWithImageTags(ctx));

    expect(compose.services.worker.image).toBe('shop-worker');
  });
});

describe('appStackInput', () => {
  it('carries the --only services as the filter the deploy renders with', () => {
    const ctx = context({ only: 'web, worker', config: { proxy: { enabled: true } } as never });
    const input = appStackInput(ctx, loadFromString(COMPOSE));

    expect(input.servicesFilter).toEqual(['web', 'worker']);
    expect(input.proxy).toEqual({ enabled: true });
    expect(input.stackName).toBe('shop-production');
    expect(input.env).toBe('production');
  });

  it('has no filter without --only', () => {
    expect(appStackInput(context(), loadFromString(COMPOSE)).servicesFilter).toBeUndefined();
  });
});

describe('displayRenderedStack', () => {
  let stdout: string[];
  let warnings: string[];
  let infos: string[];
  let order: string[];
  let spies: Array<{ mockRestore: () => void }>;

  beforeEach(() => {
    stdout = [];
    warnings = [];
    infos = [];
    order = [];
    spies = [
      spyOn(output, 'printRaw').mockImplementation((text: string) => {
        stdout.push(text);
        order.push('yaml');
      }),
      spyOn(output, 'printWarning').mockImplementation((text: string) => {
        warnings.push(text);
        order.push('warning');
      }),
      spyOn(output, 'printInfo').mockImplementation((text: string) => {
        infos.push(text);
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it('prints the stack the deploy would send: tags, Swarm defaults, routing, no build section', async () => {
    const ctx = context({ config: { proxy: { enabled: true, acme: false, domains: { production: 'app.example.com' } } } as never });

    await displayRenderedStack(ctx);

    expect(stdout).toHaveLength(1);
    const stack = parse(stdout[0]);
    expect(stack.services.web.image).toBe('shop-web-production:1.2.0');
    expect(stack.services.web.build).toBeUndefined();
    expect(stack.services.web.deploy.update_config).toBeDefined();
    expect(stack.services.web.deploy.labels).toContain('traefik.enable=true');
  });

  it('prints exactly what the deploy sends', async () => {
    const ctx = context({ only: 'web', running: RUNNING });
    const sent = ctx.swarm.render(appStackInput(ctx, await keepRunningImageTags(ctx, composeWithImageTags(ctx))));

    await displayRenderedStack(ctx);

    expect(stdout).toEqual([sent.trimEnd()]);
  });

  it('keeps only the --only services, the others at their running tag', async () => {
    await displayRenderedStack(context({ only: 'web', running: RUNNING }));

    expect(Object.keys(parse(stdout[0]).services)).toEqual(['web']);
  });

  it('warns on stderr, before the YAML, that secrets may appear in clear', async () => {
    await displayRenderedStack(context());

    expect(order).toEqual(['warning', 'yaml']);
  });

  it('names the values at risk in the warning', async () => {
    await displayRenderedStack(context());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('in clear');
    expect(warnings[0]).toContain('current.env');
  });

  it('prints nothing on stdout when the deploy sends no app stack', async () => {
    await displayRenderedStack(context({ deployApp: false }));
    await displayRenderedStack(context({ composeContent: 'services: {}\n' }));

    expect(stdout).toEqual([]);
    expect(warnings).toEqual([]);
    expect(infos).toHaveLength(2);
  });
});
