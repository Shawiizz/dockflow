import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { EnvVarsSchema, ServersBaseSchema, ServersConfigSchema } from '../schemas/servers.schema';
import { M } from '../services/orchestrator/messages';

function issuesOf(schema: z.ZodType, input: unknown): { path: string; message: string }[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

describe('EnvVarsSchema', () => {
  it('accepts a populated record', () => {
    expect(EnvVarsSchema.parse({ FOO: 'bar' })).toEqual({ FOO: 'bar' });
  });

  it('treats null as an empty record instead of failing', () => {
    // A YAML key followed only by a comment (e.g. `production:\n  # foo`)
    // parses to null, not `{}` — this must not be a validation error.
    expect(EnvVarsSchema.parse(null)).toEqual({});
  });

  it('names what is wrong with an invalid variable name', () => {
    expect(issuesOf(EnvVarsSchema, { '1FOO': 'bar' })).toEqual([
      {
        path: '1FOO',
        message: 'Environment variable names must start with a letter and contain only letters, numbers, and underscores',
      },
    ]);
  });
});

describe('ServersConfigSchema — server names', () => {
  it('an invalid server name reports the name rule, not "Invalid key in record"', () => {
    expect(issuesOf(ServersConfigSchema, { servers: { Main: { tags: ['production'] } } })).toEqual([
      { path: 'servers.Main', message: 'Server name must be lowercase alphanumeric with hyphens or underscores' },
    ]);
  });
});

describe('ServersConfigSchema — k3s fields', () => {
  const file = {
    servers: {
      main_1: {
        role: 'manager',
        host: '203.0.113.10',
        private_host: '10.0.0.10',
        node_labels: { disk: 'ssd', 'example.com/tier': 'front' },
        tags: ['production'],
      },
      worker_1: { role: 'worker', host: '203.0.113.11', tags: ['production'] },
    },
  };

  it('keeps private_host and node_labels', () => {
    const parsed = ServersConfigSchema.parse(file);
    expect(parsed.servers.main_1.private_host).toBe('10.0.0.10');
    expect(parsed.servers.main_1.node_labels).toEqual({ disk: 'ssd', 'example.com/tier': 'front' });
    expect(parsed.servers.worker_1.private_host).toBeUndefined();
    expect(parsed.servers.worker_1.node_labels).toBeUndefined();
  });

  it('reports the shared messages at the servers.yml path', () => {
    const bad = {
      servers: {
        main_1: { host: '203.0.113.10', private_host: 'main.internal', node_labels: { 'kubernetes.io/role': 'x' }, tags: ['production'] },
      },
    };
    expect(issuesOf(ServersConfigSchema, bad)).toEqual([
      { path: 'servers.main_1.private_host', message: M.privateHostIp },
      { path: 'servers.main_1.node_labels.kubernetes.io/role', message: M.labelKeyReserved },
    ]);
  });

  it('accepts any manager count: the odd-count rule is k3s-only and lives in k3sTopologyIssues', () => {
    const two = { servers: { a: { tags: ['production'] }, b: { tags: ['production'] } } };
    expect(issuesOf(ServersConfigSchema, two)).toEqual([]);
  });
});

describe('ServersBaseSchema — env block with a null tag entry', () => {
  const base = {
    servers: {
      main: { role: 'manager' as const, tags: ['production'] },
    },
  };

  it('accepts env.production as null (empty-stub YAML key)', () => {
    const result = ServersBaseSchema.parse({
      ...base,
      env: { all: { APP_NAME: 'x' }, production: null },
    });
    expect(result.env?.production).toEqual({});
  });

  it('accepts env.production omitted entirely', () => {
    const result = ServersBaseSchema.parse({
      ...base,
      env: { all: { APP_NAME: 'x' } },
    });
    expect(result.env?.production).toBeUndefined();
  });
});
