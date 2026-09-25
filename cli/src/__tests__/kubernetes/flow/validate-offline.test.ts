// `dockflow validate <env>` on k3s (DESIGN-CORE 2.6, U-FLOW-08): offline normalize + translate of
// both roles, no SSH/kubectl/Helm/registry call and no orchestrator target resolved. `runValidate`
// itself reads real project files through `getLayout()`'s process-wide cache (no reset hook), so
// the FS-independent core (`renderK3sOfflineCore`) is what is unit-tested here, the same split
// `deploy.ts` uses for `execute()` — the CLI wrapper only adds `loadServersConfig` +
// `renderAndResolveCompose`, neither owned by this package.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { renderK3sOfflineCore } from '../../../commands/validate';
import * as RenderModule from '../../../services/orchestrator/kubernetes/render';
import { K8S_PROGRESS_DEADLINE_S, K8S_REGISTRY_SECRET } from '../../../services/orchestrator/kubernetes/constants';
import { k3sTopologyIssues, type TopologyServer } from '../../../schemas/servers.schema';
import * as sshUtils from '../../../utils/ssh';
import * as output from '../../../utils/output';
import type { DockflowConfig } from '../../../utils/config';
import type { ServerConfig, ServersConfig } from '../../../types/servers';

function serversConfig(overrides: Partial<Record<string, Partial<ServerConfig>>> = {}): ServersConfig {
  return {
    servers: {
      server_1: { role: 'manager', host: '203.0.113.10', tags: ['production'], ...overrides.server_1 },
      agent_1: { role: 'worker', host: '203.0.113.20', tags: ['production'], ...overrides.agent_1 },
    },
  };
}

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', orchestrator: 'k3s', ...overrides };
}

let recorded: Record<string, string[]>;
let spies: { mockRestore(): void }[];
let sshSpies: { mockRestore(): void }[];

beforeEach(() => {
  recorded = { warn: [], dim: [], debug: [], info: [], success: [], error: [] };
  spies = [
    spyOn(output, 'printWarning').mockImplementation((m: string) => recorded.warn.push(m)),
    spyOn(output, 'printDim').mockImplementation((m: string) => recorded.dim.push(m)),
    spyOn(output, 'printDebug').mockImplementation((m: string) => recorded.debug.push(m)),
    spyOn(output, 'printError').mockImplementation((m: string) => recorded.error.push(m)),
  ];
  // U-FLOW-08: no SSH at all (forbidRemoteWork) — the offline render never opens a connection.
  sshSpies = [
    spyOn(sshUtils, 'sshExec').mockImplementation(() => {
      throw new Error('SSH touched');
    }),
    spyOn(sshUtils, 'sshExecChannel').mockImplementation(() => {
      throw new Error('SSH touched');
    }),
  ];
});

let renderSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  for (const spy of [...spies, ...sshSpies]) spy.mockRestore();
  renderSpy?.mockRestore();
  renderSpy = null;
});

/** Spies on the real `renderStackArtifact`, capturing every call while still rendering for real. */
function captureRenderCalls(): { input: import('../../../services/orchestrator/interfaces').StackDeployInput; env: RenderModule.RenderEnvironment }[] {
  const captured: { input: import('../../../services/orchestrator/interfaces').StackDeployInput; env: RenderModule.RenderEnvironment }[] = [];
  const real = RenderModule.renderStackArtifact;
  renderSpy = spyOn(RenderModule, 'renderStackArtifact').mockImplementation((input, env) => {
    captured.push({ input, env });
    return real(input, env);
  });
  return captured;
}

describe('renderK3sOfflineCore — U-FLOW-08', () => {
  it('a valid compose renders clean: no errors, no SSH touched', () => {
    const hasErrors = renderK3sOfflineCore(
      baseConfig(),
      'production',
      ['server_1', 'agent_1'],
      serversConfig(),
      new Map(),
      'services:\n  web:\n    image: nginx:1.27\n',
      '/project',
      '/project',
    );
    expect(hasErrors).toBe(false);
    expect(recorded.error).toEqual([]);
  });

  it('the synthetic StackDeployInput matches the DESIGN-CORE 2.6 table', () => {
    const captured = captureRenderCalls();

    renderK3sOfflineCore(
      baseConfig({ registry: { type: 'custom', enabled: true, url: 'registry.example.com', password: 's3cret' }, proxy: { enabled: true }, stack_management: { keep_releases: 7 } }),
      'production',
      ['server_1', 'agent_1'],
      serversConfig(),
      new Map(),
      'services:\n  web:\n    image: nginx:1.27\n',
      '/project',
      '/project',
    );

    expect(captured.length).toBeGreaterThan(0);
    const [{ input, env }] = captured;
    expect(input.version).toBe('0.0.0-validate');
    expect(input.images.pullSecretName).toBe(K8S_REGISTRY_SECRET);
    expect(input.traefikOnCluster).toBe(true);
    expect(input.serverNames).toEqual(['server_1', 'agent_1']);
    expect(env.keepReleases).toBe(7);
    expect(RenderModule.revisionHistoryLimitFor(env.keepReleases)).toBe(6); // max(1, (keep_releases ?? 3) - 1)
    expect(K8S_PROGRESS_DEADLINE_S).toBeGreaterThan(0); // baked into renderStackArtifact itself, not RenderEnvironment
  });

  it('pullSecretName is null when the registry has no password (design-03 12.1 predicate, PD-9)', () => {
    const captured = captureRenderCalls();

    renderK3sOfflineCore(
      baseConfig({ registry: { type: 'custom', enabled: true, url: 'registry.example.com' } }),
      'production',
      ['server_1'],
      serversConfig(),
      new Map(),
      'services:\n  web:\n    image: nginx:1.27\n',
      '/project',
      '/project',
    );

    expect(captured[0]?.input.images.pullSecretName).toBeNull();
  });

  it('an unresolvable file reference is an error diagnostic: exit VALIDATION_FAILED (hasErrors true)', () => {
    const hasErrors = renderK3sOfflineCore(
      baseConfig(),
      'production',
      ['server_1'],
      serversConfig(),
      new Map(), // no file at the referenced path
      'services:\n  web:\n    image: nginx:1.27\n    env_file:\n      - missing.env\n',
      '/project',
      '/project',
    );
    expect(hasErrors).toBe(true);
    expect(recorded.error.length).toBeGreaterThan(0);
    // E-30-04: validate names the file and the orchestrator the way deploy fails, then each diagnostic
    expect(recorded.error[0]).toMatch(/^docker-compose\.yml cannot be deployed with orchestrator: k3s \(\d+ error\(s\)\)$/);
  });

  it('a warning-only diagnostic does not fail validation (exit 0 with warnings only)', () => {
    const hasErrors = renderK3sOfflineCore(
      baseConfig(),
      'production',
      ['server_1'],
      serversConfig(),
      new Map(),
      // unpublished "expose" alone is a compose-schema warning, not an error, in the normalizer
      'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "3000"\n',
      '/project',
      '/project',
    );
    expect(hasErrors).toBe(false);
  });

  it('an info diagnostic and its hint are debug output only', () => {
    const hasErrors = renderK3sOfflineCore(
      baseConfig(),
      'production',
      ['server_1'],
      serversConfig(),
      new Map(),
      // a node-bound port disables surge: an info diagnostic with a hint
      'services:\n  web:\n    image: nginx:1.27\n    ports: ["18082:80"]\n    x-dockflow:\n      publish: hostport\n',
      '/project',
      '/project',
    );
    expect(hasErrors).toBe(false);
    expect(recorded.dim).toEqual([]);
    expect(recorded.debug.some((line) => line.includes('services.web') && line.includes('('))).toBe(true);
  });

  it('renders both roles when an accessories.yml was rendered alongside the app compose', () => {
    const rendered = new Map([['.dockflow/docker/accessories.yml', 'services:\n  redis:\n    image: redis:7\n']]);
    const captured = captureRenderCalls();

    renderK3sOfflineCore(baseConfig(), 'production', ['server_1'], serversConfig(), rendered, 'services:\n  web:\n    image: nginx:1.27\n', '/project', '/project');

    expect(captured.map((c) => c.input.ref.role).sort()).toEqual(['accessory', 'app']);
  });
});

describe('k3s topology rules (design-07 U-SETUP-PLAN-03/04), run by dockflow validate <env> too (7.2)', () => {
  it('M.managerCount: an even manager count >= 2 is an error', () => {
    const topology: Record<string, TopologyServer> = {
      server_1: { role: 'manager', host: 'a', tags: ['production'] },
      server_2: { role: 'manager', host: 'b', tags: ['production'] },
    };
    const issues = k3sTopologyIssues(topology, 'production');
    expect(issues.some((i) => i.severity === 'error' && i.code === 'servers.manager-count')).toBe(true);
  });

  it('M.duplicateNode: two server keys that sanitize to the same node name', () => {
    const topology: Record<string, TopologyServer> = {
      worker_1: { role: 'worker', host: 'a', tags: ['production'] },
      'worker-1': { role: 'worker', host: 'b', tags: ['production'] },
    };
    const issues = k3sTopologyIssues(topology, 'production');
    expect(issues.some((i) => i.severity === 'error' && i.code === 'servers.duplicate-node')).toBe(true);
  });
});
