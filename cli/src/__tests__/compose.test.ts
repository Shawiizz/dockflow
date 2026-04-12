import { describe, expect, it } from 'bun:test';
import { parseImageRef } from '../services/compose-service';

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
