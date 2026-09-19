import { describe, expect, it } from 'bun:test';
import { OrchestratorUnavailableError } from '../utils/errors';
import { getLatestVersion, incrementVersion } from '../utils/version';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';
import { expectCliError } from './kubernetes/support/matchers';

describe('incrementVersion', () => {
  it('increments patch', () => {
    expect(incrementVersion('1.0.0')).toBe('1.0.1');
    expect(incrementVersion('2.3.9')).toBe('2.3.10');
  });

  it('increments numeric suffix after letter', () => {
    expect(incrementVersion('1.0.0-beta2')).toBe('1.0.0-beta3');
    expect(incrementVersion('1.0.0-rc1')).toBe('1.0.0-rc2');
  });

  it('appends 2 to plain pre-release label', () => {
    expect(incrementVersion('1.0.0-beta')).toBe('1.0.0-beta2');
  });

  it('increments dash-number suffix', () => {
    expect(incrementVersion('1.0.0-2')).toBe('1.0.0-3');
    expect(incrementVersion('main-abc123-2')).toBe('main-abc123-3');
  });

  it('branch-SHA pattern → appends -2', () => {
    expect(incrementVersion('main-abc12345')).toBe('main-abc12345-2');
    expect(incrementVersion('develop-f3a1b2c8')).toBe('develop-f3a1b2c8-2');
  });

  it('fallback → appends -2', () => {
    expect(incrementVersion('custom')).toBe('custom-2');
  });
});

describe('getLatestVersion', () => {
  it('asks the release store of the bundle, on both orchestrators', async () => {
    for (const kind of ['swarm', 'k3s'] as const) {
      const orchestrator = new FakeOrchestrator(kind);
      orchestrator.seedRelease('shop-production', { version: '1.0.0', epoch: 1 });
      orchestrator.seedRelease('shop-production', { version: '1.1.0', epoch: 2 });
      orchestrator.seedRelease('shop-production', { version: '1.0.1', epoch: 3 }, { current: false });

      expect(await getLatestVersion(orchestrator, 'shop-production')).toBe('1.0.1');
      expect(orchestrator.callsTo('releases.latestVersion')).toEqual([['shop-production']]);
    }
  });

  it('null when the stack has no release', async () => {
    expect(await getLatestVersion(new FakeOrchestrator('k3s'), 'shop-production')).toBeNull();
  });

  it('an unreachable store is an error, never "no release" (I-21)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program(
      'releases.latestVersion',
      new OrchestratorUnavailableError('Kubernetes API on server_1 is unreachable', 'Run `dockflow status production`.'),
    );

    await expectCliError(getLatestVersion(orchestrator, 'shop-production'), {
      type: OrchestratorUnavailableError,
      message: 'Kubernetes API on server_1 is unreachable',
    });
  });
});
