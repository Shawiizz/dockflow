import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  findUnknownKeys,
  findUnknownConfigKeys,
  findUnknownServersKeys,
} from '../schemas/validation';

describe('findUnknownKeys (generic walker)', () => {
  const schema = z.object({
    name: z.string(),
    nested: z.object({
      count: z.number().optional().default(1),
    }).optional(),
    items: z.array(z.object({ id: z.string() })).optional(),
    dict: z.record(z.string(), z.object({ value: z.string() })).optional(),
  });

  it('valid data yields no unknown keys', () => {
    expect(findUnknownKeys(schema, { name: 'x', nested: { count: 2 } })).toEqual([]);
  });

  it('flags top-level unknown keys with a close-match suggestion', () => {
    const out = findUnknownKeys(schema, { name: 'x', nmae: 'typo' });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('nmae');
    expect(out[0].suggestion).toBe('name');
  });

  it('flags nested unknown keys through optional/default wrappers', () => {
    const out = findUnknownKeys(schema, { name: 'x', nested: { coutn: 3 } });
    expect(out.map(u => u.path)).toEqual(['nested.coutn']);
    expect(out[0].suggestion).toBe('count');
  });

  it('walks array elements with indexed paths', () => {
    const out = findUnknownKeys(schema, { name: 'x', items: [{ id: 'a' }, { idd: 'b' }] });
    expect(out.map(u => u.path)).toEqual(['items[1].idd']);
  });

  it('record keys are free-form but their values are walked', () => {
    const out = findUnknownKeys(schema, {
      name: 'x',
      dict: { anything: { value: 'ok' }, other: { vlaue: 'typo' } },
    });
    expect(out.map(u => u.path)).toEqual(['dict.other.vlaue']);
    expect(out[0].suggestion).toBe('value');
  });

  it('no suggestion when nothing is close', () => {
    const out = findUnknownKeys(schema, { name: 'x', completely_unrelated_key: 1 });
    expect(out[0].suggestion).toBeUndefined();
  });

  it('non-object data is ignored', () => {
    expect(findUnknownKeys(schema, 'not an object')).toEqual([]);
    expect(findUnknownKeys(schema, null)).toEqual([]);
  });
});

describe('findUnknownConfigKeys (real config schema)', () => {
  it('the historical fixture typo is caught: backup.retention → retention_count', () => {
    const out = findUnknownConfigKeys({
      project_name: 'demo',
      backup: { retention: 3, compression: 'gzip' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('backup.retention');
    expect(out[0].suggestion).toBe('retention_count');
  });

  it('a valid config produces no warnings', () => {
    const out = findUnknownConfigKeys({
      project_name: 'demo',
      proxy: { enabled: true, acme: false, domains: { production: 'app.example.com' } },
      backup: { retention_count: 3, accessories: { redis: { type: 'redis' } } },
      uploads: [{ src: 'a.conf', dest: '/etc/a.conf' }],
    });
    expect(out).toEqual([]);
  });

  it('typo inside an uploads item is flagged with its index', () => {
    const out = findUnknownConfigKeys({
      project_name: 'demo',
      uploads: [{ src: 'a.conf', destination: '/etc/a.conf' }],
    });
    expect(out.map(u => u.path)).toEqual(['uploads[0].destination']);
    expect(out[0].suggestion).toBe('dest');
  });

  it('proxy.domains record accepts arbitrary environment names', () => {
    const out = findUnknownConfigKeys({
      project_name: 'demo',
      proxy: { enabled: true, domains: { 'my-weird-env-name': 'x.io' } },
    });
    expect(out).toEqual([]);
  });
});

describe('findUnknownServersKeys (real servers schema)', () => {
  it('server entries accept arbitrary names but flag bad fields', () => {
    const out = findUnknownServersKeys({
      servers: {
        main_server: { role: 'manager', tags: ['test'], prot: 22 },
      },
    });
    expect(out.map(u => u.path)).toEqual(['servers.main_server.prot']);
    expect(out[0].suggestion).toBe('port');
  });

  it('env blocks accept arbitrary variable names', () => {
    const out = findUnknownServersKeys({
      servers: { main: { role: 'manager', tags: ['test'], env: { MY_CUSTOM_VAR: 'x' } } },
    });
    expect(out).toEqual([]);
  });
});
