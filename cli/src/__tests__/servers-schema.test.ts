import { describe, expect, it } from 'bun:test';
import { EnvVarsSchema, ServersBaseSchema } from '../schemas/servers.schema';

describe('EnvVarsSchema', () => {
  it('accepts a populated record', () => {
    expect(EnvVarsSchema.parse({ FOO: 'bar' })).toEqual({ FOO: 'bar' });
  });

  it('treats null as an empty record instead of failing', () => {
    // A YAML key followed only by a comment (e.g. `production:\n  # foo`)
    // parses to null, not `{}` — this must not be a validation error.
    expect(EnvVarsSchema.parse(null)).toEqual({});
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

describe('invalid record keys', () => {
  const messages = (input: unknown) => {
    const result = ServersBaseSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('a bad server name reports its rule, not "Invalid key in record"', () => {
    expect(messages({ servers: { Bad_Name: { host: '1.2.3.4', tags: ['production'] } } })).toContain(
      'Server name must be lowercase alphanumeric with hyphens or underscores',
    );
  });

  it('a bad env var name reports its rule', () => {
    expect(messages({ servers: { main: { host: '1.2.3.4', tags: ['production'], env: { '1BAD': 'x' } } } })).toContain(
      'Environment variable names must start with a letter and contain only letters, numbers, and underscores',
    );
  });
});
