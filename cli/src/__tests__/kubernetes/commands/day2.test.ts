// Command-level coverage of P65's day-2 read commands (design-06 10.4 `commands/day2.test.ts`):
// logs, exec, ps, status, version, details, diagnose over `FakeOrchestrator`, with output captured
// through spies on `utils/output` (no `mock.module`, as the Kubernetes suite never uses it).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { runDetails } from '../../../commands/app/details';
import { runDiagnose } from '../../../commands/app/diagnose';
import { runExec } from '../../../commands/app/exec';
import { runLogs } from '../../../commands/app/logs';
import { runPs } from '../../../commands/app/ps';
import { runStatus, type StatusDeps } from '../../../commands/app/status';
import { runVersion } from '../../../commands/app/version';
import { __setOrchestratorOpenerForTests } from '../../../commands/shared/day2';
import { capabilitiesFor } from '../../../services/orchestrator/capabilities';
import type { DiagnosticReport, InstanceInfo, InstanceTarget, ServiceInfo } from '../../../services/orchestrator/interfaces';
import type { DockflowConfig } from '../../../utils/config';
import { ExecExitError, OrchestratorUnavailableError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', ...overrides };
}

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'web',
    nativeName: 'web',
    kind: 'service',
    role: 'app',
    mode: 'replicated',
    image: 'shop/web:1.0',
    replicas: { running: 2, desired: 2 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

function instance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: 'web-1',
    label: 'web.1',
    service: 'web',
    node: 'worker-1',
    status: 'Running',
    severity: 'ok',
    ready: true,
    restarts: 0,
    current: true,
    startedAt: null,
    error: null,
    containers: ['web'],
    ...overrides,
  };
}

function open(orchestrator: FakeOrchestrator, config: DockflowConfig = baseConfig()): void {
  __setOrchestratorOpenerForTests(async () => ({ config, orchestrator }));
}

// decorative, never asserted on: silenced globally so the test log stays readable
const decorative = ['printIntro', 'printNote', 'printBlank', 'printInfo'] as const;
let decorativeSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  decorativeSpies = decorative.map((name) => spyOn(output, name).mockImplementation(() => {}));
});

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
  for (const spy of decorativeSpies) spy.mockRestore();
});

function spyRaw() {
  return spyOn(output, 'printRaw').mockImplementation(() => {});
}
function spyJson() {
  return spyOn(output, 'printJSON').mockImplementation(() => {});
}
function spySection() {
  return spyOn(output, 'printSection').mockImplementation(() => {});
}
function spyWarning() {
  return spyOn(output, 'printWarning').mockImplementation(() => {});
}

describe('logs', () => {
  it('streams one service without a section header', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runLogs('production', 'web', {});

    const calls = orchestrator.callsTo('containers.streamLogs');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('web');
  });

  it('follows the whole role with service: null when none is named and --follow is set', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runLogs('production', undefined, { follow: true });

    const calls = orchestrator.callsTo('containers.streamLogs');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBeNull();
  });

  it('prints one section per service when nothing is named and not following', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'web' }), service({ name: 'worker' })]);
    open(orchestrator);
    const sections = spySection();

    try {
      await runLogs('production', undefined, {});
      const calls = orchestrator.callsTo('containers.streamLogs');
      expect(calls.length).toBe(2);
      expect(sections.mock.calls.map((c) => c[0])).toEqual(['web', 'worker']);
    } finally {
      sections.mockRestore();
    }
  });

  it('--pick prompts among the service instances (non-TTY picks the shared display order)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.listInstances', [instance({ id: 'web-2', label: 'web.2' }), instance({ id: 'web-1', label: 'web.1' })]);
    open(orchestrator);

    await runLogs('production', 'web', { pick: true });

    const calls = orchestrator.callsTo('containers.streamLogs');
    expect(calls.length).toBe(1);
    const options = calls[0][2] as { instance?: string };
    expect(options.instance).toBe('web-1');
  });

  it('validates --tail before opening the orchestrator', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runLogs('production', 'web', { tail: 'not-a-number' })).rejects.toThrow();
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });
});

describe('exec', () => {
  it('--user on the k3s fake is refused before openDay2, no remote call made', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runExec('production', 'web', [], { user: 'root' }, () => 'k3s')).rejects.toThrow(
      'dockflow exec --user is not supported with orchestrator: k3s: the Kubernetes exec API runs commands as the container user',
    );
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('--user is allowed on the Swarm fake', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.exec', 0);
    open(orchestrator);

    await runExec('production', 'web', ['id'], { user: 'root' }, () => 'swarm');

    expect(orchestrator.callsTo('containers.exec').length).toBe(1);
  });

  it('a non-zero exit code becomes ExecExitError, carrying the container code', async () => {
    for (const code of [3, 62, 126]) {
      const orchestrator = new FakeOrchestrator('k3s');
      orchestrator.program('stack.getServices', [service()]);
      orchestrator.program('containers.exec', code);
      open(orchestrator);

      let caught: unknown;
      try {
        await runExec('production', 'web', ['sh', '-c', `exit ${code}`], {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExecExitError);
      expect((caught as ExecExitError).exitCode).toBe(code);
    }
  });

  it('<release>/<workload> reaches the backend as InstanceTarget.workload', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', nativeName: 'search', kind: 'helm' })]);
    orchestrator.program('containers.exec', 0);
    open(orchestrator);

    await runExec('production', 'search/search-api', ['id'], {});

    const calls = orchestrator.callsTo('containers.exec');
    const target = calls[0][1] as InstanceTarget;
    expect(target.service).toBe('search');
    expect(target.workload).toBe('search-api');
  });

  it('an interactive shell goes through containers.shell, not exec', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.shell', 0);
    open(orchestrator);

    await runExec('production', 'web', [], {});

    expect(orchestrator.callsTo('containers.shell').length).toBe(1);
    expect(orchestrator.callsTo('containers.exec').length).toBe(0);
  });
});

describe('ps', () => {
  it('renders the default table and marks unknown restarts/age with -', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.listInstances', [instance({ restarts: null, startedAt: null })]);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const raw = spyRaw();

    try {
      await runPs('production', {});
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('web-1'))).toBe(true);
      expect(lines.some((l) => /\s-\s/.test(l) || l.trimEnd().endsWith('-'))).toBe(true);
    } finally {
      raw.mockRestore();
    }
  });

  it('--json emits the shared {stack, namespace, items} shape', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.listInstances', [instance()]);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const json = spyJson();

    try {
      await runPs('production', { json: true });
      expect(json.mock.calls.length).toBe(1);
      const payload = json.mock.calls[0][0] as { stack: string; namespace: string | null; items: InstanceInfo[] };
      expect(Object.keys(payload).sort()).toEqual(['items', 'namespace', 'stack']);
      expect(payload.namespace).toBe(orchestrator.naming.scope({ project: 'shop', env: 'production', role: 'app' }));
      expect(payload.items.length).toBe(1);
    } finally {
      json.mockRestore();
    }
  });

  it('--tasks includes terminated instances', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.listInstances', [instance({ status: 'Completed' })]);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const raw = spyRaw();

    try {
      await runPs('production', { tasks: true });
      const calls = orchestrator.callsTo('stack.listInstances');
      const options = calls[0][1] as { includeTerminated?: boolean };
      expect(options.includeTerminated).toBe(true);
    } finally {
      raw.mockRestore();
    }
  });
});

describe('status', () => {
  it('uses the multi-manager budget when several managers exist', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('releases.current', null);
    orchestrator.program('stack.getServices', []);
    open(orchestrator);
    const raw = spyRaw();
    const section = spySection();

    let requestedBudgetFor: number | undefined;
    const deps: StatusDeps = {
      availableEnvironments: () => ['production'],
      managerCount: () => 3,
      budgetMs: (managers) => {
        requestedBudgetFor = managers;
        return 20000;
      },
    };
    try {
      await runStatus(undefined, deps);
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('production'))).toBe(true);
      expect(requestedBudgetFor).toBe(3);
    } finally {
      raw.mockRestore();
      section.mockRestore();
    }
  });

  it('reports "no manager configured" without opening the orchestrator', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);
    const raw = spyRaw();
    const section = spySection();

    const deps: StatusDeps = { availableEnvironments: () => ['production'], managerCount: () => 0, budgetMs: () => 8000 };
    try {
      await runStatus(undefined, deps);
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('no manager configured'))).toBe(true);
    } finally {
      raw.mockRestore();
      section.mockRestore();
    }
  });

  it('reports "timeout" when the budget elapses before the orchestrator opens', async () => {
    __setOrchestratorOpenerForTests(() => new Promise<never>(() => {})); // never resolves
    const raw = spyRaw();
    const section = spySection();

    const deps: StatusDeps = { availableEnvironments: () => ['production'], managerCount: () => 1, budgetMs: () => 5 };
    try {
      await runStatus(undefined, deps);
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('timeout'))).toBe(true);
    } finally {
      raw.mockRestore();
      section.mockRestore();
    }
  });

  it('warns when no environment is configured', async () => {
    const warning = spyWarning();
    try {
      await runStatus(undefined, { availableEnvironments: () => [], managerCount: () => 0, budgetMs: () => 8000 });
      expect(warning.mock.calls.length).toBe(1);
    } finally {
      warning.mockRestore();
    }
  });
});

describe('version', () => {
  it('prints JSON verbatim with --json', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.2.0' });
    open(orchestrator);
    const json = spyJson();

    try {
      await runVersion('production', { json: true });
      expect(json.mock.calls.length).toBe(1);
      expect((json.mock.calls[0][0] as { version: string }).version).toBe('1.2.0');
    } finally {
      json.mockRestore();
    }
  });

  it('prints Helm releases only when orchestrator.helm exists', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.2.0' });
    open(orchestrator);
    const raw = spyRaw();

    try {
      await runVersion('production', {});
      expect(orchestrator.helm).toBeNull();
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('Helm releases'))).toBe(false);
    } finally {
      raw.mockRestore();
    }
  });
});

describe('details', () => {
  it('prints a stats failure as a warning and still succeeds', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.stats', new OrchestratorUnavailableError('metrics-server is not available on server-1'));
    orchestrator.program('cluster.nodes', []);
    open(orchestrator);
    const warning = spyWarning();
    const raw = spyRaw();

    try {
      await runDetails('production', {});
      expect(warning.mock.calls.length).toBeGreaterThan(0);
    } finally {
      warning.mockRestore();
      raw.mockRestore();
    }
  });
});

describe('diagnose', () => {
  it('renders every DiagnosticLineLevel and the issue summary', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const report: DiagnosticReport = {
      sections: [
        {
          title: 'Stack Status',
          lines: [
            { text: 'Namespace exists', level: 'ok' },
            { text: 'web: 1/2 replicas', level: 'warning' },
            { text: 'db: 0/1 replicas', level: 'error' },
            { text: 'Waiting', level: 'pending' },
            { text: 'note', level: 'dim' },
            { text: 'plain line', level: 'plain' },
          ],
        },
      ],
      issues: [{ severity: 'error', category: 'Stack', message: 'db has 0/1 replicas', suggestion: 'Run `dockflow diagnose production`.' }],
    };
    orchestrator.program('stack.diagnose', report);
    open(orchestrator);
    const raw = spyRaw();
    const section = spySection();

    try {
      await runDiagnose('production', {});
      const lines = raw.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('✓'))).toBe(true);
      expect(lines.some((l) => l.includes('!'))).toBe(true);
      expect(lines.some((l) => l.includes('✗'))).toBe(true);
      expect(lines.some((l) => l.includes('○'))).toBe(true);
      expect(lines.some((l) => l.includes('·'))).toBe(true);
      expect(lines.some((l) => l.includes('plain line'))).toBe(true);
      expect(lines.some((l) => l.includes('Errors'))).toBe(true);
    } finally {
      raw.mockRestore();
      section.mockRestore();
    }
  });
});

describe('capability catalogue sanity', () => {
  it('k3s never allows exec --user', () => {
    expect(capabilitiesFor('k3s').execAsUser).toBe(false);
    expect(capabilitiesFor('swarm').execAsUser).toBe(true);
  });
});
