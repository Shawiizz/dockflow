// `deploy --dry-run` (design-03 3.6, U-FLOW-07): no lock, no remote mutation, but it DOES connect
// (control-plane probe, live Helm/proxy plan, best effort); `--render` masks Secret data.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { displayDeployDryRun, maskArtifactSecrets } from '../../../commands/deploy-dry-run';
import type { DeployContext } from '../../../commands/deploy-context';
import { emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import type { StackArtifact } from '../../../services/orchestrator/interfaces';
import { ComposeTranslationError, ErrorCode } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';
import { config } from '../support/builders';
import type { Audit } from '../../../services/audit';
import type { Metrics } from '../../../services/metrics';

function fakeContext(orchestrator: FakeOrchestrator, overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    env: 'production',
    config: config(),
    stackName: orchestrator.target.stackName,
    branchName: 'main',
    deployVersion: '1.4.2',
    projectRoot: '/project',
    target: orchestrator.target,
    orchestrator,
    deployApp: true,
    forceAccessories: false,
    skipAccessories: false,
    options: { dryRun: true },
    rendered: new Map(),
    composeContent: 'services:\n  web:\n    image: nginx:1.27\n',
    composeDirPath: '/project',
    audit: {} as unknown as Audit,
    metrics: {} as unknown as Metrics,
    revertedTo: null,
    applyStarted: false,
    appSettled: false,
    cleanupOrchestrator: null,
    traefikOnCluster: false,
    ...overrides,
  };
}

let recorded: Record<string, string[]>;
let spies: { mockRestore(): void }[];

beforeEach(() => {
  recorded = { warn: [], dim: [], debug: [], info: [], success: [], error: [], raw: [] };
  spies = [
    spyOn(output, 'printWarning').mockImplementation((m: string) => recorded.warn.push(m)),
    spyOn(output, 'printDim').mockImplementation((m: string) => recorded.dim.push(m)),
    spyOn(output, 'printDebug').mockImplementation((m: string) => recorded.debug.push(m)),
    spyOn(output, 'printInfo').mockImplementation((m: string) => recorded.info.push(m)),
    spyOn(output, 'printSuccess').mockImplementation((m: string) => recorded.success.push(m)),
    spyOn(output, 'printError').mockImplementation((m: string) => recorded.error.push(m)),
    spyOn(output, 'printRaw').mockImplementation((m: string) => recorded.raw.push(m)),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('displayDeployDryRun — U-FLOW-07', () => {
  it('acquires no lock and makes no remote mutation', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator);

    await displayDeployDryRun(ctx, []);

    expect(orchestrator.events).not.toContain('lock.acquire');
    expect(orchestrator.events).not.toContain('stack.deploy:app');
    expect(orchestrator.events).not.toContain('stack.deploy:accessory');
    expect(orchestrator.events).not.toContain('stack.apply:app');
    expect(orchestrator.events).not.toContain('releases.create:1.4.2');
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
  });

  it('does connect: it probes the control plane and runs the Helm plan when one is declared', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, {
      config: config({
        helm: { releases: [{ name: 'search', chart: 'search', repo: 'https://charts.example.org', version: '2.4.1', role: 'app' }] },
      }),
    });

    await displayDeployDryRun(ctx, []);

    expect(orchestrator.events).toContain('cluster.probe');
    expect(orchestrator.events).toContain('helm.plan');
  });

  it('prints one dim "Live plan skipped" line and continues with the offline part when no manager answers', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('cluster.probe', new Error('connection refused'));
    const ctx = fakeContext(orchestrator);

    await displayDeployDryRun(ctx, []);

    expect(recorded.dim.some((m) => m.includes('Live plan skipped'))).toBe(true);
    // the offline summary still ran and reached the end
    expect(recorded.success.some((m) => m.includes('Dry run complete'))).toBe(true);
  });

  it('a ComposeTranslationError from the render is printed with its suggestion and exits non-zero, before any live plan', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.render', () => {
      throw new ComposeTranslationError('docker-compose.yml cannot be deployed with orchestrator: k3s (1 error(s))', 'Fix the compose file and re-run.', [
        { severity: 'error', code: 'files.missing', path: 'services.web.env_file[0]', message: 'env_file missing.env was not found' },
      ]);
    });
    const ctx = fakeContext(orchestrator);
    const previousExitCode = process.exitCode;

    await displayDeployDryRun(ctx, []);

    expect(recorded.error.length).toBeGreaterThan(0);
    expect(recorded.dim.some((m) => m.includes('Fix the compose file'))).toBe(true);
    expect(process.exitCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(orchestrator.events).not.toContain('cluster.probe');
    // assigning `undefined` is a no-op on this Bun version, so fall back to 0
    process.exitCode = previousExitCode ?? 0;
  });

  describe('--render', () => {
    it('masks every Secret.data value with *** and leaves ConfigMap.data untouched', () => {
      const orchestrator = new FakeOrchestrator('k3s');
      const ctx = fakeContext(orchestrator);
      const secretValue = Buffer.from('hunter2').toString('base64');
      const content = emitManifests(
        [
          { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-env' }, data: { PASSWORD: secretValue } },
          { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'web-config' }, data: { LOG_LEVEL: 'debug' } },
        ],
        { format: 'k8s-manifests/1', stackName: ctx.stackName, role: 'app', version: ctx.deployVersion },
      );
      const artifact: StackArtifact = { format: 'k8s-manifests/1', role: 'app', content, helm: [], diagnostics: [], digest: 'x' };

      const masked = maskArtifactSecrets(artifact, ctx);

      expect(masked).toContain('***');
      expect(masked).not.toContain(secretValue);
      expect(masked).toContain('debug');
      expect(masked).toContain('LOG_LEVEL');
    });

    it('prints the masked manifests when options.render is set', async () => {
      const orchestrator = new FakeOrchestrator('k3s');
      const secretValue = Buffer.from('hunter2').toString('base64');
      orchestrator.program('stack.render', (input) => ({
        format: 'k8s-manifests/1',
        role: input.ref.role,
        content: emitManifests(
          [{ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-env' }, data: { PASSWORD: secretValue } }],
          { format: 'k8s-manifests/1', stackName: orchestrator.target.stackName, role: input.ref.role, version: input.version },
        ),
        helm: [],
        diagnostics: [],
        digest: 'x',
      }));
      const dryRunOptions = { dryRun: true, render: true };
      const ctx = fakeContext(orchestrator, { options: dryRunOptions });

      await displayDeployDryRun(ctx, []);

      const rendered = recorded.raw.join('\n');
      expect(rendered).toContain('***');
      expect(rendered).not.toContain(secretValue);
    });
  });
});
