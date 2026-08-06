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
