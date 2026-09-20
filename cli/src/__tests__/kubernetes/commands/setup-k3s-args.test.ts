// CLI1-CLI5 (design-05 22.2, `commands/setup-k3s-args.test.ts`): the Commander registration of the
// k3s cluster-mode surface (design-05 1.2, 19.1). Every real action here is wrapped in
// `withErrorHandler`, which calls `process.exit` on a thrown error (utils/errors.ts), so this file
// never parses argv through the real registered action: CLI1's validation functions are called
// directly, and CLI2/CLI3 build a small harness around the same `addK3sClusterOptions` export the
// real `commands/setup/index.ts` uses, with a capturing action instead of the real dispatch. CLI5
// alone inspects the real `registerSetupCommand`'s Command tree, which is safe because building that
// tree never executes an action.

import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerSetupCommand } from '../../../commands/setup';
import { addK3sClusterOptions, assertClusterFlagsNeedEnv, resolveBootstrapIdentity, toResetOptions, toSetupOptions } from '../../../commands/setup/k3s/options';
import { validateK3sFlags } from '../../../commands/setup/k3s/plan';
import type { SetupOptions } from '../../../commands/setup/types';
import { ValidationError } from '../../../utils/errors';

// ---------------------------------------------------------------------------
// A minimal replica of `commands/setup/index.ts`'s registration shape, wired with a capturing
// action instead of the real one: it never resolves a bootstrap identity, connects anywhere or
// touches the filesystem, so parsing here is safe and fast.
// ---------------------------------------------------------------------------

function buildHarness(): { program: Command; captured: (SetupOptions & { env?: string })[] } {
  const captured: (SetupOptions & { env?: string })[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  program.option('--verbose').option('--no-color');

  const setup = program
    .command('setup [target]')
    .option('-k, --key <path>')
    .option('--connection <string>')
    .option('--password <password>')
    .option('--host <host>')
    .option('--user <user>')
    .option('-y, --yes')
    .option('--dev')
    .option('--orchestrator <type>', '', 'swarm')
    .option('--env <env>')
    .option('--node-name <name>')
    .option('--private-host <ip>')
    .action((_target: string | undefined, options: SetupOptions) => {
      captured.push(options);
    });
  addK3sClusterOptions(setup);

  addK3sClusterOptions(setup.command('k3s <env>'))
    .action((env: string, _local: unknown, command: Command) => {
      captured.push({ ...(command.optsWithGlobals() as SetupOptions), env });
    });

  return { program, captured };
}

async function parse(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(['setup', ...args], { from: 'user' });
}

// ---------------------------------------------------------------------------
// CLI1
// ---------------------------------------------------------------------------

describe('CLI1: flag combination errors (design-05 19.1, 2.1)', () => {
  it('--binary with --dev is refused', () => {
    expect(() => validateK3sFlags({ binary: '/tmp/dockflow', dev: true })).toThrow('--binary and --dev cannot be combined');
  });

  it('--insecure-host-key with --require-host-key is refused', () => {
    expect(() => validateK3sFlags({ insecureHostKey: true, requireHostKey: true })).toThrow(
      '--insecure-host-key and --require-host-key cannot be combined',
    );
  });

  it('an unknown --flannel-backend value is refused', () => {
    expect(() => validateK3sFlags({ flannelBackend: 'bridge' })).toThrow('--flannel-backend must be vxlan or wireguard-native');
  });

  const clusterOnlyCases: [string, Partial<SetupOptions>][] = [
    ['--ssh-user', { sshUser: 'admin' }],
    ['--dry-run', { dryRun: true }],
    ['--upgrade', { upgrade: true }],
    ['--skip-firewall', { skipFirewall: true }],
    ['--skip-network-check', { skipNetworkCheck: true }],
    ['--skip-reachability-check', { skipReachabilityCheck: true }],
    ['--insecure-host-key', { insecureHostKey: true }],
    ['--require-host-key', { requireHostKey: true }],
    ['--convert-datastore', { convertDatastore: true }],
    ['--shared-cluster', { sharedCluster: true }],
    ['--rotate-deploy-token', { rotateDeployToken: true }],
    ['--reset', { reset: true }],
    ['--node', { node: ['srv-1'] }],
    ['--delete-volumes', { deleteVolumes: true }],
    ['--confirm', { confirm: 'prod' }],
    ['--binary', { binary: '/tmp/dockflow' }],
  ];

  it.each(clusterOnlyCases)('%s without --env needs --env (or dockflow setup k3s <env>)', (flag, options) => {
    expect(() => assertClusterFlagsNeedEnv(options)).toThrow(`${flag} needs --env <env> (or dockflow setup k3s <env>)`);
  });

  it('cluster-only flags WITH --env are accepted', () => {
    expect(() => assertClusterFlagsNeedEnv({ env: 'prod', upgrade: true, reset: true, node: ['a'] })).not.toThrow();
  });

  it('--flannel-backend alone is not cluster-only: it is also a local single-host option', () => {
    expect(() => assertClusterFlagsNeedEnv({ flannelBackend: 'vxlan' })).not.toThrow();
  });

  it('-k/--password/-y/--dev alone are not cluster-only: they serve local/remote mode too', () => {
    expect(() => assertClusterFlagsNeedEnv({ key: 'x', password: 'y', yes: true, dev: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI2
// ---------------------------------------------------------------------------

describe('CLI2: setup k3s <env> and setup --orchestrator k3s --env <env> agree (F38)', () => {
  it('registering the helper on setup does not throw for the existing -k/--password/-y/--dev flags', () => {
    expect(() => buildHarness()).not.toThrow();
  });

  it('produce identical options for flags written before the positional env', async () => {
    const a = buildHarness();
    await parse(a.program, ['--orchestrator', 'k3s', '--env', 'prod', '-k', 'key.pem', '--ssh-user', 'admin', '--yes']);
    const b = buildHarness();
    await parse(b.program, ['k3s', 'prod', '-k', 'key.pem', '--ssh-user', 'admin', '--yes']);

    expect(a.captured).toHaveLength(1);
    expect(b.captured).toHaveLength(1);
    const [optsA] = a.captured;
    const [optsB] = b.captured;
    expect(optsB.env).toBe('prod');
    expect(optsB.key).toBe(optsA.key);
    expect(optsB.sshUser).toBe(optsA.sshUser);
    expect(optsB.yes).toBe(optsA.yes);
  });

  it('flags written AFTER k3s <env> still reach the action (the F38 trap)', async () => {
    const { program, captured } = buildHarness();
    await parse(program, ['k3s', 'prod', '-k', 'key.pem', '--yes', '--ssh-user', 'admin']);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.key).toBe('key.pem');
    expect(captured[0]?.yes).toBe(true);
    expect(captured[0]?.sshUser).toBe('admin');
  });

  it('a mix of flags before and after the positional env all reach the action', async () => {
    const { program, captured } = buildHarness();
    await parse(program, ['k3s', 'prod', '--upgrade', '-k', 'key.pem', '--require-host-key']);
    expect(captured[0]?.upgrade).toBe(true);
    expect(captured[0]?.key).toBe('key.pem');
    expect(captured[0]?.requireHostKey).toBe(true);
  });

  it('unset cluster flags carry no Commander default (F38): they stay undefined, not defaulted', async () => {
    const { program, captured } = buildHarness();
    await parse(program, ['k3s', 'prod']);
    expect(captured[0]?.yes).toBeUndefined();
    expect(captured[0]?.upgrade).toBeUndefined();
    expect(captured[0]?.sshUser).toBeUndefined();
    expect(captured[0]?.flannelBackend).toBeUndefined();
  });

  it('--verbose still works after the subcommand (enablePositionalOptions is not used)', async () => {
    const { program } = buildHarness();
    let verboseSeen: unknown;
    program.hook('preAction', (thisCommand) => {
      verboseSeen = thisCommand.optsWithGlobals().verbose;
    });
    await parse(program, ['k3s', 'prod', '--verbose']);
    expect(verboseSeen).toBe(true);
  });

  it('toSetupOptions applies the same defaults from either path', async () => {
    const a = buildHarness();
    await parse(a.program, ['--orchestrator', 'k3s', '--env', 'prod']);
    const b = buildHarness();
    await parse(b.program, ['k3s', 'prod']);
    expect(toSetupOptions(a.captured[0])).toEqual(toSetupOptions(b.captured[0]));
    expect(toSetupOptions(a.captured[0]).sshUser).toBe('root');
    expect(toSetupOptions(a.captured[0]).dryRun).toBe(false);
    expect(toSetupOptions(a.captured[0]).flannelBackend).toBeNull();
    expect(toSetupOptions(a.captured[0]).binary).toBeNull();
  });

  it('toResetOptions defaults an absent --node to an empty list and --confirm to null', () => {
    const options = toResetOptions({});
    expect(options.nodes).toEqual([]);
    expect(options.confirm).toBeNull();
    expect(options.sshUser).toBe('root');
  });
});

// ---------------------------------------------------------------------------
// CLI3
// ---------------------------------------------------------------------------

describe('CLI3: --k3s-plan and --binary are hidden but parse', () => {
  it('--binary is hidden on the real setup command and resolves when parsed', async () => {
    const program = new Command();
    registerSetupCommand(program);
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    const binaryOption = setupCmd?.options.find((o) => o.long === '--binary');
    expect(binaryOption?.hidden).toBe(true);

    const { program: harnessProgram, captured } = buildHarness();
    await parse(harnessProgram, ['--orchestrator', 'k3s', '--env', 'prod', '--binary', '/tmp/dockflow', '-k', 'key.pem']);
    expect(captured[0]?.binary).toBe('/tmp/dockflow');
  });

  it('--k3s-plan is hidden on the real setup command and resolves when parsed', async () => {
    const program = new Command();
    registerSetupCommand(program);
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    const planOption = setupCmd?.options.find((o) => o.long === '--k3s-plan');
    expect(planOption?.hidden).toBe(true);

    // registered directly on `setup`, mirroring index.ts, never via addK3sClusterOptions
    const captured: SetupOptions[] = [];
    const harness = new Command();
    harness.exitOverride();
    harness.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    harness
      .command('setup [target]')
      .option('--k3s-plan <source>')
      .action((_target: string | undefined, options: SetupOptions) => {
        captured.push(options);
      });
    await harness.parseAsync(['setup', '--k3s-plan', '-'], { from: 'user' });
    expect(captured[0]?.k3sPlan).toBe('-');
  });
});

// ---------------------------------------------------------------------------
// CLI5
// ---------------------------------------------------------------------------

describe('CLI5: the published flag table and the Commander registration agree', () => {
  // design-05 1.2's cluster-mode table, minus -k/--password/-y/--dev (already on `setup` for
  // local/remote mode, so addK3sClusterOptions skips re-registering them, per its own dedup rule).
  const PUBLISHED_K3S_FLAGS = [
    '--ssh-user',
    '--key',
    '--password',
    '--dry-run',
    '--yes',
    '--upgrade',
    '--flannel-backend',
    '--skip-firewall',
    '--skip-network-check',
    '--skip-reachability-check',
    '--insecure-host-key',
    '--require-host-key',
    '--convert-datastore',
    '--shared-cluster',
    '--rotate-deploy-token',
    '--reset',
    '--node',
    '--delete-volumes',
    '--confirm',
    '--dev',
    '--binary',
  ].sort();

  it('setup k3s <env> registers exactly the table of design-05 1.2', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    const k3sCmd = setupCmd?.commands.find((c) => c.name() === 'k3s');
    expect(k3sCmd).toBeDefined();
    const registered = (k3sCmd?.options ?? []).map((o) => o.long).sort();
    expect(registered).toEqual(PUBLISHED_K3S_FLAGS);
  });

  it('setup itself parses every one of those flags too (F38: the ancestor that actually parses them)', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    const registered = new Set((setupCmd?.options ?? []).map((o) => o.long));
    for (const flag of PUBLISHED_K3S_FLAGS) expect(registered.has(flag)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveBootstrapIdentity (design-05 1.2, 2.1, 3.5): used by both dispatch paths above the
// coordinator, never the deploy key.
// ---------------------------------------------------------------------------

describe('resolveBootstrapIdentity', () => {
  it('defaults the bootstrap user to root', async () => {
    const identity = await resolveBootstrapIdentity({ password: 'secret' });
    expect(identity.sshUser).toBe('root');
    expect(identity.password).toBe('secret');
    expect(identity.privateKey).toBeUndefined();
  });

  it('refuses a non-interactive session with neither --key nor --password', async () => {
    // bun test's stdin is not a TTY, so this always takes the non-interactive branch.
    await expect(resolveBootstrapIdentity({})).rejects.toThrow(ValidationError);
  });

  it('refuses a --key path that does not exist', async () => {
    await expect(resolveBootstrapIdentity({ key: '/nonexistent/bootstrap.pem' })).rejects.toThrow(
      'Bootstrap SSH key file not found: /nonexistent/bootstrap.pem',
    );
  });
});
