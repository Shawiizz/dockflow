import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { SSHKeyConnection } from '../types';

// Commands of the services that used to put a name or a URL between double quotes, or bare: a
// value with `$(...)` or a quote in it must reach the server as one inert word.

const calls: { command: string; stdin: string }[] = [];

const realSsh = await import('../utils/ssh');
const sshSpies = [
  spyOn(realSsh, 'sshExec').mockImplementation((async (_conn: unknown, command: string, options?: { stdin?: string }) => {
    calls.push({ command, stdin: options?.stdin ?? '' });
    return { stdout: '200', stderr: '', exitCode: 0 };
  }) as never),
];
afterAll(() => {
  for (const spy of sshSpies) spy.mockRestore();
});

const { Metrics } = await import('../services/metrics');
const { Audit } = await import('../services/audit');
const { syncToNode } = await import('../services/history-sync');
const { HealthCheck } = await import('../services/health-check');
const { remoteHookProgram } = await import('../services/hook');

const connection = { host: 'manager', port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection;
// double quotes, a command substitution and a backtick: all inert inside single quotes
const STACK = 'shop"$(id)`x`';

beforeEach(() => {
  calls.length = 0;
});

describe('metrics commands', () => {
  it('quote the stack name in every path', async () => {
    const metrics = new Metrics(connection);
    await metrics.writeDeployment({
      stackName: STACK,
      version: '1',
      env: 'production',
      branch: 'main',
      status: 'success',
      durationMs: 1,
      performer: 'ci',
      buildSkipped: false,
      accessoriesDeployed: false,
      nodeCount: 1,
    });
    await metrics.fetch(STACK, 5);
    await metrics.fetch(STACK);
    await metrics.prune(STACK, 1);

    const dir = "'/var/lib/dockflow/metrics/shop\"$(id)`x`'";
    const file = "'/var/lib/dockflow/metrics/shop\"$(id)`x`/deployments.json'";
    const tmp = "'/var/lib/dockflow/metrics/shop\"$(id)`x`/deployments.json.tmp'";
    expect(calls.map((call) => call.command)).toEqual([
      `mkdir -p ${dir}`,
      `cat >> ${file}`,
      `tail -n 5 ${file} 2>/dev/null || echo ""`,
      `cat ${file} 2>/dev/null || echo ""`,
      `wc -l < ${file} 2>/dev/null || echo "0"`,
      `tail -n 1 ${file} > ${tmp} && mv ${tmp} ${file}`,
    ]);
  });
});

describe('audit and history sync commands', () => {
  it('quote the log files and the metrics directory', async () => {
    await new Audit(connection).writeEntry(STACK, 'success', 'done', '1');
    await syncToNode(connection, STACK, 'audit line', '{"id":"1"}');

    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/var/lib/dockflow/audit'",
      "cat >> '/var/lib/dockflow/audit/shop\"$(id)`x`.log'",
      "mkdir -p '/var/lib/dockflow/audit' '/var/lib/dockflow/metrics/shop\"$(id)`x`'",
      "cat >> '/var/lib/dockflow/audit/shop\"$(id)`x`.log'",
      "cat >> '/var/lib/dockflow/metrics/shop\"$(id)`x`/deployments.json'",
    ]);
  });
});

describe('remote HTTP health check', () => {
  it('quotes the URL and the method, and adds -k only for validate_certs: false', async () => {
    // another test file replaces this method on the prototype and leaves it so
    (HealthCheck.prototype.checkHTTPEndpoints as unknown as { mockRestore?: () => void }).mockRestore?.();
    const check = new HealthCheck(connection, {} as never);
    await check.checkHTTPEndpoints({
      endpoints: [
        { url: "https://example.com/a?b=$(id)&c='d'", remote: true, retries: 1 },
        { url: 'https://example.com/', remote: true, retries: 1, validate_certs: false, method: 'HEAD' },
      ],
    } as never);

    expect(calls.map((call) => call.command)).toEqual([
      "curl -4 -s -o /dev/null -w %{http_code} --max-time 30 -X 'GET' 'https://example.com/a?b=$(id)&c='\\''d'\\'''",
      "curl -4 -s -o /dev/null -w %{http_code} --max-time 30 -X 'HEAD' -k 'https://example.com/'",
    ]);
  });
});

describe('remoteHookProgram', () => {
  it('quotes the stack directory it changes to', () => {
    const program = remoteHookProgram({ stackDir: '/var/lib/dockflow/stacks/$(id)"x/current', env: {}, timeoutS: 30, kind: 'run' });

    expect(program).toContain(`cd '/var/lib/dockflow/stacks/$(id)"x/current' 2>/dev/null || cd /tmp`);
  });
});
