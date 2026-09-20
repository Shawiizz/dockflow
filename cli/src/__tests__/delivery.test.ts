// Predicate table of design-03 12.1: the ONE registry predicate and the delivery mode it drives.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { resolveImageDelivery, usesRegistry, warnRegistryWithoutPassword } from '../commands/deploy-phases';
import { REGISTRY_PULL_SECRET_NAME } from '../constants';
import type { RegistryConfig } from '../utils/config';
import * as output from '../utils/output';
import { config, parsedCompose } from './kubernetes/support/builders';

const BUILT_SERVICE = { build: '.', image: 'shop/web:1.0' };

function registry(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return { type: 'custom', enabled: true, url: 'registry.example.com', username: 'deploy', password: 's3cret', ...overrides };
}

describe('usesRegistry / resolveImageDelivery predicate table (design-03 12.1)', () => {
  it('enabled + url + password, a build runs -> registry, pull secret set', () => {
    const cfg = config({ registry: registry() });
    expect(usesRegistry(cfg)).toBe(true);
    const delivery = resolveImageDelivery(cfg, parsedCompose(BUILT_SERVICE));
    expect(delivery).toEqual({ built: [], mode: 'registry', pullSecretName: REGISTRY_PULL_SECRET_NAME });
  });

  it('enabled + url + password, no build (--skip-build / --accessories) -> still registry: mode is configuration-only', () => {
    const cfg = config({ registry: registry() });
    const delivery = resolveImageDelivery(cfg, parsedCompose());
    expect(delivery.mode).toBe('registry');
    expect(delivery.pullSecretName).toBe(REGISTRY_PULL_SECRET_NAME);
  });

  it('enabled + url, password missing, a build runs -> import (no registry reference, no push)', () => {
    const cfg = config({ registry: registry({ password: undefined }) });
    expect(usesRegistry(cfg)).toBe(false);
    const delivery = resolveImageDelivery(cfg, parsedCompose(BUILT_SERVICE));
    expect(delivery).toEqual({ built: [], mode: 'import', pullSecretName: null });
  });

  it('enabled + url, password missing, nothing built -> none', () => {
    const cfg = config({ registry: registry({ password: undefined }) });
    const delivery = resolveImageDelivery(cfg, parsedCompose());
    expect(delivery.mode).toBe('none');
    expect(delivery.pullSecretName).toBeNull();
  });

  it('registry disabled, a build runs -> import (docker save to every eligible node)', () => {
    const cfg = config({ registry: registry({ enabled: false }) });
    const delivery = resolveImageDelivery(cfg, parsedCompose(BUILT_SERVICE));
    expect(delivery.mode).toBe('import');
    expect(delivery.pullSecretName).toBeNull();
  });

  it('registry disabled, nothing built -> none (pulled from wherever compose names them)', () => {
    const cfg = config({ registry: registry({ enabled: false }) });
    const delivery = resolveImageDelivery(cfg, parsedCompose());
    expect(delivery.mode).toBe('none');
  });

  it('no registry configured at all -> same as disabled', () => {
    const cfg = config();
    expect(usesRegistry(cfg)).toBe(false);
    expect(resolveImageDelivery(cfg, parsedCompose(BUILT_SERVICE)).mode).toBe('import');
  });

  it('a service with build AND a service without build still counts as "a build runs"', () => {
    const cfg = config();
    const compose = parsedCompose({ services: { web: BUILT_SERVICE, cache: { image: 'redis:8-alpine' } } });
    expect(resolveImageDelivery(cfg, compose).mode).toBe('import');
  });

  it('built is always empty: buildAndDistribute fills it after the render, never resolveImageDelivery', () => {
    const cfg = config({ registry: registry() });
    expect(resolveImageDelivery(cfg, parsedCompose(BUILT_SERVICE)).built).toEqual([]);
  });
});

describe('warnRegistryWithoutPassword', () => {
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    spyOn(output, 'printWarning').mockImplementation((message: string) => {
      warnings.push(message);
    });
  });

  afterEach(() => {
    (output.printWarning as unknown as { mockRestore(): void }).mockRestore();
  });

  it('enabled + url, no password -> warns once, naming the URL', () => {
    warnRegistryWithoutPassword(config({ registry: registry({ password: undefined }) }));
    expect(warnings).toEqual([
      'Registry registry.example.com is enabled but registry.password is not set; built images are distributed over SSH instead of pushed',
    ]);
  });

  it('credentials complete -> silent', () => {
    warnRegistryWithoutPassword(config({ registry: registry() }));
    expect(warnings).toEqual([]);
  });

  it('registry disabled -> silent even without a password', () => {
    warnRegistryWithoutPassword(config({ registry: registry({ enabled: false, password: undefined }) }));
    expect(warnings).toEqual([]);
  });

  it('no registry configured -> silent', () => {
    warnRegistryWithoutPassword(config());
    expect(warnings).toEqual([]);
  });

  it('url missing -> silent (nothing to push to, not the "no password" case)', () => {
    warnRegistryWithoutPassword(config({ registry: registry({ url: undefined, password: undefined }) }));
    expect(warnings).toEqual([]);
  });
});
