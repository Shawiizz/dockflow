// design-01 5.8, 5.9, 5.10 (resources): DEP-*, RST-*, DPL-*, RES-*, PLC-01..08 as direct tests of
// the deploy handler. DPL-07 follows D31 (an app service honours failure_action pause and
// continue), which supersedes the app-side warning of design-01 5.9.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import { deploy, parseConstraint } from '../../../services/orchestrator/kubernetes/normalize/deploy';
import { normalizeContext, type NormalizeInputOverrides, serviceDraft } from '../support/builders';

type Row = [Diagnostic['severity'], string, string];

function run(compose: string | Record<string, unknown>, overrides: NormalizeInputOverrides = {}, key = 'web') {
  const ctx = normalizeContext({ ...overrides, compose });
  const draft = serviceDraft(key, ctx);
  deploy(draft, ctx.input.compose.services[key], ctx);
  const diagnostics = ctx.sink.list();
  const rows: Row[] = diagnostics.map((d) => [d.severity, d.code, d.path]);
  return { draft, ctx, diagnostics, rows, codes: diagnostics.map((d) => d.code) };
}

function only(compose: string | Record<string, unknown>, overrides: NormalizeInputOverrides = {}): Diagnostic {
  const { diagnostics } = run(compose, overrides);
  expect(diagnostics).toHaveLength(1);
  return diagnostics[0];
}

describe('deploy.mode, replicas, scale, endpoint_mode (DPL-01..05, RST-05)', () => {
  test('DPL-01 no deploy: replicated Deployment with one replica and every default', () => {
    for (const body of ['image: nginx:1.27', 'image: nginx:1.27\ndeploy:']) {
      const { draft, diagnostics } = run(body);
      expect(diagnostics).toEqual([]);
      expect(draft.mode).toBe('replicated');
      expect(draft.workloadKind).toBe('Deployment');
      expect(draft.replicas).toBe(1);
      expect(draft.restart).toEqual({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null });
      expect(draft.resources).toEqual({ limits: { cpu: null, memory: null, pids: null }, reservations: { cpu: null, memory: null } });
      expect(draft.placement).toEqual({ constraints: [], spreadLabels: [], maxReplicasPerNode: null });
      expect(draft.network.endpointMode).toBe('vip');
    }
  });

  test('deploy that is not a mapping is values.invalid-type and keeps the defaults', () => {
    const d = only('image: nginx:1.27\ndeploy: [a]');
    expect(d).toEqual({
      severity: 'error',
      code: 'values.invalid-type',
      path: 'services.web.deploy',
      message: 'expected mapping, got list',
      hint: 'See the Compose specification for the accepted forms.',
    });
  });

  test('DPL-02 mode global is a DaemonSet', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27', deploy: { mode: 'global' } });
    expect(diagnostics).toEqual([]);
    expect(draft.mode).toBe('global');
    expect(draft.workloadKind).toBe('DaemonSet');
  });

  test('DPL-03 replicated-job is a Job; global-job and other modes are refused', () => {
    const job = run({ image: 'migrate:1', deploy: { mode: 'replicated-job', replicas: 2 } });
    expect(job.diagnostics).toEqual([]);
    expect(job.draft.mode).toBe('replicated-job');
    expect(job.draft.workloadKind).toBe('Job');
    expect(job.draft.replicas).toBe(2);

    expect(only({ image: 'x:1', deploy: { mode: 'global-job' } })).toEqual({
      severity: 'error',
      code: 'deploy.global-job',
      path: 'services.web.deploy.mode',
      message: 'mode global-job is not supported: Kubernetes has no run-once-per-node workload',
      hint: 'Use `mode: replicated-job`, or `mode: global` with a long-running command.',
    });
    const daemon = run({ image: 'x:1', deploy: { mode: 'daemon' } });
    expect(daemon.rows).toEqual([['error', 'deploy.invalid-mode', 'services.web.deploy.mode']]);
    expect(daemon.diagnostics[0].message).toBe('mode daemon must be replicated, global or replicated-job');
    expect(daemon.draft.mode).toBe('replicated');
    expect(run({ image: 'x:1', deploy: { mode: 3 } }).rows).toEqual([['error', 'values.invalid-type', 'services.web.deploy.mode']]);
  });

  test('DPL-04 replicas: decimal strings accepted, out of range refused, refused with mode global', () => {
    expect(run({ image: 'x:1', deploy: { replicas: '3' } }).draft.replicas).toBe(3);
    expect(run({ image: 'x:1', deploy: { replicas: 0 } }).draft.replicas).toBe(0);

    const negative = run({ image: 'x:1', deploy: { replicas: -1 } });
    expect(negative.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-integer',
        path: 'services.web.deploy.replicas',
        message: 'expected an integer between 0 and 10000, got -1',
        hint: 'Write a whole number.',
      },
    ]);
    expect(negative.draft.replicas).toBe(1);
    expect(run({ image: 'x:1', deploy: { replicas: 1.5 } }).codes).toEqual(['values.invalid-integer']);
    expect(run({ image: 'x:1', deploy: { replicas: 10_001 } }).codes).toEqual(['values.invalid-integer']);

    expect(only({ image: 'x:1', deploy: { mode: 'global', replicas: 2 } })).toEqual({
      severity: 'error',
      code: 'deploy.replicas-global',
      path: 'services.web.deploy.replicas',
      message: 'replicas cannot be used with mode global',
      hint: 'Remove `replicas`: a global service runs one pod per eligible node.',
    });
  });

  test('RST-05 scale: used when deploy.replicas is absent, equal is silent, a disagreement and global are errors', () => {
    expect(run({ image: 'x:1', scale: 3 }).draft.replicas).toBe(3);
    const equal = run({ image: 'x:1', scale: 2, deploy: { replicas: 2 } });
    expect(equal.diagnostics).toEqual([]);
    expect(equal.draft.replicas).toBe(2);

    const conflict = run({ image: 'x:1', scale: 3, deploy: { replicas: 2 } });
    expect(conflict.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'deploy.scale-conflict',
        path: 'services.web.scale',
        message: 'scale 3 and deploy.replicas 2 disagree',
        hint: 'Keep only `deploy.replicas`.',
      },
    ]);
    expect(conflict.draft.replicas).toBe(2);

    const global = run({ image: 'x:1', scale: 2, deploy: { mode: 'global' } });
    expect(global.rows).toEqual([['error', 'deploy.replicas-global', 'services.web.scale']]);
    expect(global.diagnostics[0].message).toBe('scale cannot be used with mode global');
    expect(global.draft.replicas).toBe(1);
  });

  test('DPL-05 endpoint_mode dnsrr is kept with published ports; other values are refused', () => {
    const dnsrr = run({ image: 'x:1', ports: ['8080:80'], deploy: { endpoint_mode: 'dnsrr' } });
    expect(dnsrr.diagnostics).toEqual([]);
    expect(dnsrr.draft.network.endpointMode).toBe('dnsrr');
    expect(run({ image: 'x:1', deploy: { endpoint_mode: 'vip' } }).draft.network.endpointMode).toBe('vip');

    const rr = run({ image: 'x:1', deploy: { endpoint_mode: 'rr' } });
    expect(rr.rows).toEqual([['error', 'deploy.invalid-endpoint-mode', 'services.web.deploy.endpoint_mode']]);
    expect(rr.diagnostics[0].message).toBe('endpoint_mode rr must be vip or dnsrr');
    expect(rr.draft.network.endpointMode).toBe('vip');
  });
});

describe('update_config and rollback_config (DPL-06..09, DPL-11, INJ-05)', () => {
  test('INJ-05 absent update_config keeps the role defaults without a diagnostic', () => {
    expect(run('image: x:1').draft.update).toEqual({
      parallelism: 1,
      delayMs: 10_000,
      failureAction: 'rollback',
      monitorMs: 30_000,
      order: 'start-first',
      maxFailureRatio: 0,
      defaults: 'dockflow',
    });
    const accessory = run('image: postgres:16', { role: 'accessory' });
    expect(accessory.diagnostics).toEqual([]);
    expect(accessory.draft.update).toEqual({
      parallelism: 1,
      delayMs: 0,
      failureAction: 'pause',
      monitorMs: 5_000,
      order: 'stop-first',
      maxFailureRatio: 0,
      defaults: 'docker',
    });
  });

  test('DPL-06 written fields override the defaults one by one; a non-zero delay is an info', () => {
    const app = run({ image: 'x:1', deploy: { update_config: { parallelism: 0, delay: '5s', monitor: '1m' } } });
    expect(app.draft.update).toEqual({
      parallelism: 0,
      delayMs: 5_000,
      failureAction: 'rollback',
      monitorMs: 60_000,
      order: 'start-first',
      maxFailureRatio: 0,
      defaults: 'dockflow',
    });
    expect(app.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'deploy.update-delay',
        path: 'services.web.deploy.update_config.delay',
        message: 'update_config.delay is not applied: Kubernetes has no pause between update batches',
      },
    ]);
    expect(run({ image: 'x:1', deploy: { update_config: { delay: '0s' } } }).diagnostics).toEqual([]);

    // parallelism 0 on a global service is the translator's update.global-all-at-once
    const global = run({ image: 'x:1', deploy: { mode: 'global', update_config: { parallelism: 0, order: 'stop-first' } } });
    expect(global.diagnostics).toEqual([]);
    expect(global.draft.update).toMatchObject({ parallelism: 0, order: 'stop-first' });

    // the 210 s ceiling is the translator's (PD-5): the normalizer stores what was written
    const long = run({ image: 'x:1', deploy: { update_config: { monitor: '250s' } } });
    expect(long.diagnostics).toEqual([]);
    expect(long.draft.update.monitorMs).toBe(250_000);
  });

  test('DPL-06 invalid durations are reported and keep the default', () => {
    const r = run({ image: 'x:1', deploy: { update_config: { delay: 5, monitor: '-1s', parallelism: -2 } } });
    expect(r.rows).toEqual([
      ['error', 'values.invalid-duration', 'services.web.deploy.update_config.delay'],
      ['error', 'values.negative-duration', 'services.web.deploy.update_config.monitor'],
      ['error', 'values.invalid-integer', 'services.web.deploy.update_config.parallelism'],
    ]);
    expect(r.diagnostics[0]).toMatchObject({ message: '5 is not a duration', hint: 'Use a duration such as `30s`, `1m30s` or `500ms`.' });
    expect(r.diagnostics[1].message).toBe('-1s must not be negative');
    expect(r.draft.update).toMatchObject({ delayMs: 10_000, monitorMs: 30_000, parallelism: 1 });
    const huge = run({ image: 'x:1', deploy: { update_config: { monitor: '3000000h' } } });
    expect(huge.rows).toEqual([['error', 'values.duration-too-large', 'services.web.deploy.update_config.monitor']]);
    expect(huge.diagnostics[0].message).toBe('3000000h is too large');
  });

  test('DPL-06 parallelism other than 1 on a StatefulSet is an info', () => {
    const sts = run({ image: 'x:1', deploy: { update_config: { parallelism: 2 } }, 'x-dockflow': { kind: 'statefulset' } });
    expect(sts.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'deploy.statefulset-pacing',
        path: 'services.web.deploy.update_config.parallelism',
        message: 'update_config.parallelism 2 is not applied: a StatefulSet replaces its pods one at a time',
      },
    ]);
    expect(run({ image: 'x:1', deploy: { update_config: { parallelism: 1 } }, 'x-dockflow': { kind: 'statefulset' } }).diagnostics).toEqual([]);
    expect(run({ image: 'x:1', deploy: { update_config: { parallelism: 2 } } }).diagnostics).toEqual([]);
  });

  test('DPL-07 failure_action: D31 for app services, a written rollback on an accessory is not applied', () => {
    for (const action of ['pause', 'continue', 'rollback'] as const) {
      const app = run({ image: 'x:1', deploy: { update_config: { failure_action: action } } });
      expect(app.diagnostics).toEqual([]);
      expect(app.draft.update.failureAction).toBe(action);
    }
    const accessory = run({ image: 'postgres:16', deploy: { update_config: { failure_action: 'rollback' } } }, { role: 'accessory' });
    expect(accessory.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'deploy.failure-action',
        path: 'services.web.deploy.update_config.failure_action',
        message: 'update_config.failure_action rollback is not applied: a failed accessory rollout stops the deploy without a revert',
      },
    ]);
    expect(run({ image: 'postgres:16', deploy: { update_config: { failure_action: 'pause' } } }, { role: 'accessory' }).diagnostics).toEqual([]);

    const invalid = run({ image: 'x:1', deploy: { update_config: { failure_action: 'stop' } } });
    expect(invalid.rows).toEqual([['error', 'deploy.invalid-failure-action', 'services.web.deploy.update_config.failure_action']]);
    expect(invalid.diagnostics[0].message).toBe('update_config.failure_action stop must be rollback, pause or continue');
  });

  test('DPL-07 max_failure_ratio: written non-zero is a warning, outside 0-1 an error', () => {
    const ratio = run({ image: 'x:1', deploy: { update_config: { max_failure_ratio: 0.2 } } });
    expect(ratio.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'deploy.max-failure-ratio',
        path: 'services.web.deploy.update_config.max_failure_ratio',
        message: 'update_config.max_failure_ratio is ignored: any failed pod fails the rollout',
      },
    ]);
    expect(ratio.draft.update.maxFailureRatio).toBe(0.2);
    expect(run({ image: 'x:1', deploy: { update_config: { max_failure_ratio: 0 } } }).diagnostics).toEqual([]);
    expect(run({ image: 'x:1', deploy: { update_config: { max_failure_ratio: '0.5' } } }).draft.update.maxFailureRatio).toBe(0.5);

    const outside = run({ image: 'x:1', deploy: { update_config: { max_failure_ratio: 2 } } });
    expect(outside.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-number',
        path: 'services.web.deploy.update_config.max_failure_ratio',
        message: 'expected a number between 0 and 1, got 2',
      },
    ]);
    expect(outside.draft.update.maxFailureRatio).toBe(0);
  });

  test('DPL-08 order', () => {
    expect(run({ image: 'x:1', deploy: { update_config: { order: 'stop-first' } } }).draft.update.order).toBe('stop-first');
    const random = run({ image: 'x:1', deploy: { update_config: { order: 'random' } } });
    expect(random.rows).toEqual([['error', 'deploy.invalid-order', 'services.web.deploy.update_config.order']]);
    expect(random.diagnostics[0].message).toBe('update_config.order random must be start-first or stop-first');
    expect(random.draft.update.order).toBe('start-first');
  });

  test('DPL-09 a written rollback_config is an info, an empty one is nothing', () => {
    expect(only({ image: 'x:1', deploy: { rollback_config: { parallelism: 2 } } })).toEqual({
      severity: 'info',
      code: 'deploy.rollback-config',
      path: 'services.web.deploy.rollback_config',
      message: 'rollback_config has no Kubernetes equivalent: a revert re-applies the previous objects with their own update settings',
    });
    expect(run({ image: 'x:1', deploy: { rollback_config: {} } }).diagnostics).toEqual([]);
    expect(run({ image: 'x:1', deploy: { rollback_config: 'fast' } }).codes).toEqual(['values.invalid-type']);
  });

  test('DPL-11 any written update_config key on a Job is one warning, and replaces the per-field notes', () => {
    const job = run({ image: 'migrate:1', deploy: { mode: 'replicated-job', update_config: { parallelism: 2, delay: '5s', max_failure_ratio: 0.5 } } });
    expect(job.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'deploy.update-config-on-job',
        path: 'services.web.deploy.update_config',
        message: 'update_config does not apply to web: a Job runs its pods once and is not rolled out',
        hint: 'Remove `update_config`, or use `deploy.mode: replicated`.',
      },
    ]);
    // an accessory Job without a written update_config: k3s injects nothing, nothing to report
    expect(run({ image: 'migrate:1', deploy: { mode: 'replicated-job' } }, { role: 'accessory' }).diagnostics).toEqual([]);
    expect(run({ image: 'migrate:1', deploy: { mode: 'replicated-job', update_config: {} } }).diagnostics).toEqual([]);
    // invalid values are still errors on a Job
    expect(run({ image: 'migrate:1', deploy: { mode: 'replicated-job', update_config: { order: 'random' } } }).codes).toEqual([
      'deploy.update-config-on-job',
      'deploy.invalid-order',
    ]);
  });
});

describe('restart and deploy.restart_policy (RST-01..04, DPL-10, C2, C6)', () => {
  test('RST-01 always and unless-stopped are silent; on-failure is an info; nothing is said on a Job', () => {
    for (const policy of ['always', 'unless-stopped']) {
      const r = run({ image: 'x:1', restart: policy });
      expect(r.diagnostics).toEqual([]);
      expect(r.draft.restart).toEqual({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null });
    }
    expect(only({ image: 'x:1', restart: 'on-failure' })).toEqual({
      severity: 'info',
      code: 'restart.on-failure',
      path: 'services.web.restart',
      message: 'on Kubernetes a long-running container is also restarted when it exits with code 0',
    });
    for (const [policy, condition] of [
      ['always', 'any'],
      ['unless-stopped', 'any'],
      ['on-failure', 'on-failure'],
    ]) {
      const job = run({ image: 'x:1', restart: policy, deploy: { mode: 'replicated-job' } });
      expect(job.diagnostics).toEqual([]);
      expect(job.draft.restart.condition).toBe(condition as 'any' | 'on-failure');
    }
  });

  test('RST-02 on-failure:N is a retry limit: warned on long-running workloads, backoffLimit on a Job', () => {
    const replicated = run({ image: 'x:1', restart: 'on-failure:3' });
    expect(replicated.rows).toEqual([
      ['warning', 'restart.max-retries-ignored', 'services.web.restart'],
      ['info', 'restart.on-failure', 'services.web.restart'],
    ]);
    expect(replicated.diagnostics[0].message).toBe(
      'the retry limit 3 is ignored: Kubernetes restarts a failing container indefinitely with a back-off',
    );
    const job = run({ image: 'x:1', restart: 'on-failure:3', deploy: { mode: 'replicated-job' } });
    expect(job.diagnostics).toEqual([]);
    expect(job.draft.restart).toEqual({ condition: 'on-failure', delayMs: null, maxAttempts: 3, windowMs: null });
  });

  test('RST-03 restart no: warned on long-running workloads, condition none (backoffLimit 0) on a Job', () => {
    expect(only({ image: 'x:1', restart: 'no' })).toEqual({
      severity: 'warning',
      code: 'restart.no-ignored',
      path: 'services.web.restart',
      message: 'restart: no cannot be honoured by a long-running workload: Kubernetes restarts its containers',
      hint: 'Use `deploy.mode: replicated-job` for a container that must run once.',
    });
    const job = run('image: x:1\nrestart: "no"\ndeploy:\n  mode: replicated-job');
    expect(job.diagnostics).toEqual([]);
    expect(job.draft.restart).toEqual({ condition: 'none', delayMs: null, maxAttempts: null, windowMs: null });
  });

  test('RST-04 an unknown policy is an error; deploy.restart_policy overrides restart with an info', () => {
    const invalid = only({ image: 'x:1', restart: 'sometimes' });
    expect(invalid).toEqual({
      severity: 'error',
      code: 'restart.invalid',
      path: 'services.web.restart',
      message: 'sometimes is not a restart policy',
      hint: 'Use `no`, `always`, `on-failure[:N]` or `unless-stopped`.',
    });
    expect(run({ image: 'x:1', restart: 'on-failure:x' }).codes).toEqual(['restart.invalid']);
    expect(run({ image: 'x:1', restart: false }).codes).toEqual(['restart.invalid']);

    const overridden = run({ image: 'x:1', restart: 'always', deploy: { restart_policy: { condition: 'none' } } });
    expect(overridden.draft.restart.condition).toBe('none');
    expect(overridden.rows).toEqual([
      ['warning', 'deploy.restart-none', 'services.web.deploy.restart_policy.condition'],
      ['info', 'restart.overridden', 'services.web.restart'],
    ]);
    expect(overridden.diagnostics[1].message).toBe('restart is overridden by deploy.restart_policy');
  });

  test('DPL-10 restart_policy fields are stored as written; delay/window/max_attempts warnings are the translator’s', () => {
    const r = run({ image: 'x:1', deploy: { restart_policy: { condition: 'on-failure', delay: '5s', max_attempts: 3, window: '1m' } } });
    expect(r.draft.restart).toEqual({ condition: 'on-failure', delayMs: 5_000, maxAttempts: 3, windowMs: 60_000 });
    expect(r.rows).toEqual([['info', 'restart.on-failure', 'services.web.deploy.restart_policy.condition']]);
    expect(r.codes).not.toContain('deploy.restart-policy-unsupported');

    const job = run({ image: 'x:1', deploy: { mode: 'replicated-job', restart_policy: { condition: 'any' } } });
    expect(job.diagnostics).toEqual([]);
    expect(job.draft.restart.condition).toBe('any');
    expect(run({ image: 'x:1', deploy: { mode: 'replicated-job', restart_policy: { condition: 'none' } } }).diagnostics).toEqual([]);

    expect(only({ image: 'x:1', deploy: { restart_policy: { condition: 'none' } } })).toEqual({
      severity: 'warning',
      code: 'deploy.restart-none',
      path: 'services.web.deploy.restart_policy.condition',
      message: 'restart_policy.condition none cannot be honoured by a long-running workload: Kubernetes restarts its containers',
      hint: 'Use `deploy.mode: replicated-job` for a container that must run once.',
    });
    const invalid = run({ image: 'x:1', deploy: { restart_policy: { condition: 'sometimes', max_attempts: -1 } } });
    expect(invalid.rows).toEqual([
      ['error', 'deploy.invalid-restart-condition', 'services.web.deploy.restart_policy.condition'],
      ['error', 'values.invalid-integer', 'services.web.deploy.restart_policy.max_attempts'],
    ]);
    expect(invalid.diagnostics[0].message).toBe('restart_policy.condition sometimes must be none, on-failure or any');
    expect(invalid.draft.restart).toEqual({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null });
  });

  test('C6 a policy without written limits carries no limit, so the translator never warns about it', () => {
    const r = run({ image: 'postgres:16', deploy: { replicas: 1, restart_policy: { condition: 'any' } } }, { role: 'accessory' });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.restart).toEqual({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null });
  });
});

describe('resources (RES-01..06)', () => {
  test('RES-01 limits and reservations in model units; a limit of 0 means none', () => {
    const r = run({ image: 'x:1', deploy: { resources: { limits: { cpus: '0.5', memory: '512M' }, reservations: { memory: '256m' } } } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.resources).toEqual({
      limits: { cpu: 500, memory: 536_870_912, pids: null },
      reservations: { cpu: null, memory: 268_435_456 },
    });
    const zero = run({ image: 'x:1', deploy: { resources: { limits: { cpus: 0, memory: '0' }, reservations: { cpus: '0.25' } } } });
    expect(zero.draft.resources).toEqual({ limits: { cpu: null, memory: null, pids: null }, reservations: { cpu: 250, memory: null } });
  });

  test('RES-01 CPU precision and invalid values', () => {
    const tiny = run({ image: 'x:1', deploy: { resources: { limits: { cpus: '0.0001' } } } });
    expect(tiny.draft.resources.limits.cpu).toBe(1);
    expect(tiny.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'resources.cpu-rounded',
        path: 'services.web.deploy.resources.limits.cpus',
        message: '0.0001 CPUs rounded up to 1m (Kubernetes CPU precision is 1m)',
      },
    ]);
    const invalid = run({ image: 'x:1', deploy: { resources: { limits: { cpus: 'two', memory: 'lots' } } } });
    expect(invalid.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-cpus',
        path: 'services.web.deploy.resources.limits.cpus',
        message: 'two is not a CPU count',
        hint: 'Write a decimal number of CPUs such as `0.5` or `2`.',
      },
      {
        severity: 'error',
        code: 'values.invalid-bytes',
        path: 'services.web.deploy.resources.limits.memory',
        message: 'lots is not a byte value',
        hint: 'Use bytes or a binary unit such as `512m`, `1g` or `2048k`.',
      },
    ]);
    expect(invalid.draft.resources.limits).toEqual({ cpu: null, memory: null, pids: null });
  });

  test('RES-02 limits.pids is stored and warned; 0 and -1 mean no limit', () => {
    const r = run({ image: 'x:1', deploy: { resources: { limits: { pids: 100 } } } });
    expect(r.draft.resources.limits.pids).toBe(100);
    expect(r.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'resources.pids-unsupported',
        path: 'services.web.deploy.resources.limits.pids',
        message: 'deploy.resources.limits.pids is ignored: Kubernetes has no per-container process limit',
        hint: 'Set `podPidsLimit` in the kubelet configuration if the limit matters.',
      },
    ]);
    for (const pids of [0, -1]) {
      const none = run({ image: 'x:1', deploy: { resources: { limits: { pids } } } });
      expect(none.diagnostics).toEqual([]);
      expect(none.draft.resources.limits.pids).toBeNull();
    }
    expect(run({ image: 'x:1', deploy: { resources: { limits: { pids: 'many' } } } }).codes).toEqual(['values.invalid-integer']);
  });

  test('RES-03 a reservation above its limit is left to the translator (resources.request-exceeds-limit)', () => {
    const r = run({ image: 'x:1', deploy: { resources: { limits: { memory: '1g' }, reservations: { memory: '2g' } } } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.resources).toMatchObject({ limits: { memory: 1_073_741_824 }, reservations: { memory: 2_147_483_648 } });
  });

  test('RES-04 device and generic resource reservations are refused', () => {
    expect(only({ image: 'x:1', deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } })).toEqual({
      severity: 'error',
      code: 'resources.devices-unsupported',
      path: 'services.web.deploy.resources.reservations.devices',
      message: 'device reservations (for example GPUs) are not supported in this Dockflow version',
      hint: 'Remove the device reservation.',
    });
    expect(
      only({ image: 'x:1', deploy: { resources: { reservations: { generic_resources: [{ discrete_resource_spec: { kind: 'gpu', value: 1 } }] } } } }),
    ).toEqual({
      severity: 'error',
      code: 'resources.generic-unsupported',
      path: 'services.web.deploy.resources.reservations.generic_resources',
      message: 'generic_resources is not supported',
      hint: 'Use `x-dockflow.node_selector` to place the service on nodes that have the resource.',
    });
    expect(run({ image: 'x:1', deploy: { resources: { reservations: { devices: [], generic_resources: [] } } } }).diagnostics).toEqual([]);
  });

  test('RES-05 service-level cpus, mem_limit, mem_reservation and pids_limit', () => {
    expect(run({ image: 'x:1', cpus: 1.5 }).draft.resources.limits.cpu).toBe(1500);
    const conflict = run({ image: 'x:1', cpus: 1, deploy: { resources: { limits: { cpus: '2' } } } });
    expect(conflict.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'resources.conflict',
        path: 'services.web.cpus',
        message: 'cpus 1 and deploy.resources.limits.cpus 2 disagree',
        hint: 'Keep `deploy.resources` only.',
      },
    ]);
    expect(conflict.draft.resources.limits.cpu).toBe(2000);
    expect(run({ image: 'x:1', cpus: '2', deploy: { resources: { limits: { cpus: 2 } } } }).diagnostics).toEqual([]);

    const memory = run({ image: 'x:1', mem_limit: '1g', mem_reservation: '128m' });
    expect(memory.diagnostics).toEqual([]);
    expect(memory.draft.resources).toMatchObject({ limits: { memory: 1_073_741_824 }, reservations: { memory: 134_217_728 } });
    expect(run({ image: 'x:1', mem_limit: '1g', deploy: { resources: { limits: { memory: '2g' } } } }).rows).toEqual([
      ['error', 'resources.conflict', 'services.web.mem_limit'],
    ]);
    expect(run({ image: 'x:1', mem_reservation: '1g', deploy: { resources: { reservations: { memory: '2g' } } } }).rows).toEqual([
      ['error', 'resources.conflict', 'services.web.mem_reservation'],
    ]);

    const pids = run({ image: 'x:1', pids_limit: 50 });
    expect(pids.rows).toEqual([['warning', 'resources.pids-unsupported', 'services.web.pids_limit']]);
    expect(pids.diagnostics[0].message).toBe('pids_limit is ignored: Kubernetes has no per-container process limit');
    expect(pids.draft.resources.limits.pids).toBeNull();
    expect(run({ image: 'x:1', pids_limit: -1 }).diagnostics).toEqual([]);
  });

  test('RES-06 cpu_quota and cpu_period; ignored and refused engine keys', () => {
    expect(run({ image: 'x:1', cpu_quota: 50_000 }).draft.resources.limits.cpu).toBe(500);
    expect(run({ image: 'x:1', cpu_quota: 50_000, cpu_period: 200_000 }).draft.resources.limits.cpu).toBe(250);
    const rounded = run({ image: 'x:1', cpu_quota: 33_333 });
    expect(rounded.draft.resources.limits.cpu).toBe(334);
    expect(rounded.rows).toEqual([['info', 'resources.cpu-rounded', 'services.web.cpu_quota']]);
    expect(run({ image: 'x:1', cpu_quota: -1 }).draft.resources.limits.cpu).toBeNull();
    expect(run({ image: 'x:1', cpu_quota: 50_000, cpu_period: 10 }).codes).toEqual(['values.invalid-integer']);

    expect(only({ image: 'x:1', cpu_period: 1_000 })).toEqual({
      severity: 'info',
      code: 'resources.cpu-period-alone',
      path: 'services.web.cpu_period',
      message: 'cpu_period without cpu_quota has no effect',
    });
    expect(only({ image: 'x:1', cpu_shares: 512 })).toEqual({
      severity: 'warning',
      code: 'resources.cpu-shares-ignored',
      path: 'services.web.cpu_shares',
      message: 'cpu_shares is ignored: Kubernetes weighs CPU by reservations',
      hint: 'Set `deploy.resources.reservations.cpus` instead (1024 shares = 1 CPU).',
    });
    expect(only({ image: 'x:1', cpuset: '0-1' })).toEqual({
      severity: 'error',
      code: 'resources.cpuset-unsupported',
      path: 'services.web.cpuset',
      message: 'cpuset is not supported: CPU pinning needs the kubelet static CPU manager',
      hint: 'Remove `cpuset`.',
    });

    const conflicts = run({ image: 'x:1', cpus: 1, cpu_quota: 50_000, deploy: { resources: { limits: { cpus: 1 } } } });
    expect(conflicts.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['resources.conflict', 'services.web.cpu_quota', 'cpu_quota 50000 and deploy.resources.limits.cpus 1 disagree'],
    ]);
    const engineOnly = run({ image: 'x:1', cpus: 1, cpu_quota: 50_000 });
    expect(engineOnly.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['resources.conflict', 'services.web.cpu_quota', 'cpu_quota 50000 and cpus 1 disagree'],
    ]);
    expect(engineOnly.draft.resources.limits.cpu).toBe(1000);
  });

  test('SECU-12/SECU-13 engine keys read by this handler: real-time, Windows-only and swap keys', () => {
    const r = run({ image: 'x:1', cpu_rt_runtime: 950_000, cpu_rt_period: 1_000_000, cpu_count: 2, cpu_percent: 50, mem_swappiness: 0, memswap_limit: '1g' });
    expect(r.rows).toEqual([
      ['error', 'resources.windows-only', 'services.web.cpu_count'],
      ['error', 'resources.windows-only', 'services.web.cpu_percent'],
      ['error', 'resources.realtime-unsupported', 'services.web.cpu_rt_period'],
      ['error', 'resources.realtime-unsupported', 'services.web.cpu_rt_runtime'],
      ['warning', 'resources.swap-ignored', 'services.web.mem_swappiness'],
      ['warning', 'resources.swap-ignored', 'services.web.memswap_limit'],
    ]);
    const byPath = Object.fromEntries(r.diagnostics.map((d) => [d.path, d]));
    expect(byPath['services.web.cpu_count']).toMatchObject({ message: 'cpu_count only applies to Windows containers', hint: 'Remove `cpu_count`.' });
    expect(byPath['services.web.cpu_rt_runtime']).toMatchObject({ message: 'cpu_rt_runtime (real-time scheduling) is not supported' });
    expect(byPath['services.web.memswap_limit'].message).toBe('memswap_limit is ignored: swap is configured per node on Kubernetes');
  });
});

describe('placement (PLC-01..08)', () => {
  const constraints = (list: unknown[], overrides: NormalizeInputOverrides = {}) =>
    run({ image: 'x:1', deploy: { placement: { constraints: list } } }, overrides);

  test('PLC-01 node.role constraints are kept in order with lower-case values', () => {
    const r = constraints(['node.role == manager', 'node.role!=Worker']);
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.placement.constraints).toEqual([
      { attribute: 'node.role', operator: '==', value: 'manager', path: 'services.web.deploy.placement.constraints[0]' },
      { attribute: 'node.role', operator: '!=', value: 'worker', path: 'services.web.deploy.placement.constraints[1]' },
    ]);
  });

  test('PLC-02 node.hostname must name a servers.yml key; the value is kept as written', () => {
    const known = constraints(['node.hostname==Worker_1'], { serverNames: ['server_1', 'Worker_1'] });
    expect(known.diagnostics).toEqual([]);
    expect(known.draft.placement.constraints).toEqual([
      { attribute: 'node.hostname', operator: '==', value: 'Worker_1', path: 'services.web.deploy.placement.constraints[0]' },
    ]);
    // the same Kubernetes node name (nodeNameFor) selects the same node
    expect(constraints(['node.hostname != worker-1'], { serverNames: ['server_1', 'Worker_1'] }).diagnostics).toEqual([]);

    const typo = constraints(['node.hostname==worker1'], { serverNames: ['server_1', 'Worker_1'] });
    expect(typo.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'placement.unknown-server',
        path: 'services.web.deploy.placement.constraints[0]',
        message: 'worker1 is not a server of this environment (servers.yml declares server_1, Worker_1)',
        hint: 'Use one of the servers.yml keys; `node.hostname` selects nodes by their Dockflow name, not by their OS host name.',
      },
    ]);
    expect(typo.draft.placement.constraints).toEqual([]);
  });

  test('PLC-03 node.labels keep key and value verbatim; an invalid label key is refused', () => {
    const r = constraints(['node.labels.zone == eu-1', 'node.labels.Disk != SSD']);
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.placement.constraints).toEqual([
      { attribute: 'node.labels', key: 'zone', operator: '==', value: 'eu-1', path: 'services.web.deploy.placement.constraints[0]' },
      { attribute: 'node.labels', key: 'Disk', operator: '!=', value: 'SSD', path: 'services.web.deploy.placement.constraints[1]' },
    ]);
    const bad = constraints(['node.labels.bad key == x', 'node.labels.-bad == x']);
    expect(bad.rows).toEqual([
      ['error', 'placement.invalid-constraint', 'services.web.deploy.placement.constraints[0]'],
      ['error', 'placement.invalid-constraint', 'services.web.deploy.placement.constraints[1]'],
    ]);
    expect(bad.diagnostics[1].message).toBe('node.labels.-bad == x is not a valid placement constraint: invalid label key -bad');
  });

  test('PLC-04 platform constraints are lower-cased; the translator maps the architecture', () => {
    const r = constraints(['node.platform.arch == x86_64', 'node.platform.os==Linux']);
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.placement.constraints.map((c) => [c.attribute, c.value])).toEqual([
      ['node.platform.arch', 'x86_64'],
      ['node.platform.os', 'linux'],
    ]);
  });

  test('IMG-11 the platform constraints identity.ts appended stay after deploy.placement.constraints', () => {
    const ctx = normalizeContext({ compose: { image: 'x:1', platform: 'linux/arm64', deploy: { placement: { constraints: ['node.role == worker'] } } } });
    const draft = serviceDraft('web', ctx);
    const platformPath = 'services.web.platform';
    draft.placement.constraints.push(
      { attribute: 'node.platform.os', operator: '==', value: 'linux', path: platformPath },
      { attribute: 'node.platform.arch', operator: '==', value: 'arm64', path: platformPath },
    );
    deploy(draft, ctx.input.compose.services.web, ctx);
    expect(draft.placement.constraints.map((c) => [c.attribute, c.value, c.path])).toEqual([
      ['node.role', 'worker', 'services.web.deploy.placement.constraints[0]'],
      ['node.platform.os', 'linux', platformPath],
      ['node.platform.arch', 'arm64', platformPath],
    ]);
  });

  test('PLC-05 node.id and engine.labels are refused with their own codes', () => {
    const r = constraints(['node.id == abc', 'engine.labels.foo == bar']);
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'placement.node-id',
        path: 'services.web.deploy.placement.constraints[0]',
        message: 'node.id constraints are not supported: Swarm node ids do not exist on Kubernetes',
        hint: 'Use `node.hostname == <servers.yml name>` instead.',
      },
      {
        severity: 'error',
        code: 'placement.engine-labels',
        path: 'services.web.deploy.placement.constraints[1]',
        message: 'engine.labels constraints are not supported',
        hint: 'Use `node.labels.<key>` with `node_labels` in `servers.yml`.',
      },
    ]);
  });

  test('PLC-06 syntax, attribute, role and architecture errors name their detail', () => {
    const r = constraints(['node.role = manager', 'node.cpu == 4', 'node.role == leader', 'node.platform.arch == mips', 42]);
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['placement.invalid-constraint', 'node.role = manager is not a valid placement constraint: invalid syntax'],
      ['placement.invalid-constraint', 'node.cpu == 4 is not a valid placement constraint: unknown attribute node.cpu'],
      ['placement.invalid-constraint', 'node.role == leader is not a valid placement constraint: role must be manager or worker'],
      ['placement.invalid-constraint', 'node.platform.arch == mips is not a valid placement constraint: unknown architecture mips'],
      ['values.invalid-type', 'expected string, got number'],
    ]);
    expect(r.diagnostics[0].hint).toBe(
      'Write `<attribute> == <value>` or `<attribute> != <value>`; attributes: `node.role`, `node.hostname`, `node.labels.<key>`, `node.platform.os`, `node.platform.arch`.',
    );
    expect(r.draft.placement.constraints).toEqual([]);
    expect(run({ image: 'x:1', deploy: { placement: { constraints: 'node.role == manager' } } }).codes).toEqual(['values.invalid-type']);
  });

  test('parseConstraint is exported for reuse and keeps the path', () => {
    expect(parseConstraint('  node.labels.tier==db  ', 'p')).toEqual({ attribute: 'node.labels', key: 'tier', operator: '==', value: 'db', path: 'p' });
    expect(parseConstraint('node.hostname == my host', 'p')).toEqual({ attribute: 'node.hostname', operator: '==', value: 'my host', path: 'p' });
    expect(parseConstraint('garbage', 'p')).toEqual({ error: 'syntax', detail: 'garbage' });
  });

  test('PLC-07 spread preferences over node labels, in declaration order', () => {
    const r = run({ image: 'x:1', deploy: { placement: { preferences: [{ spread: 'node.labels.zone' }, { spread: 'node.labels.rack' }] } } });
    expect(r.diagnostics).toEqual([]);
    expect(r.draft.placement.spreadLabels).toEqual(['zone', 'rack']);

    const bad = run({ image: 'x:1', deploy: { placement: { preferences: [{ spread: 'node.id' }, {}, 'zone'] } } });
    expect(bad.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['placement.invalid-preference', 'services.web.deploy.placement.preferences[0].spread', 'spread node.id must be node.labels.<key>'],
      ['placement.invalid-preference', 'services.web.deploy.placement.preferences[1].spread', 'spread must be node.labels.<key>'],
      ['values.invalid-type', 'services.web.deploy.placement.preferences[2]', 'expected mapping, got string'],
    ]);
    expect(bad.draft.placement.spreadLabels).toEqual([]);
  });

  test('PLC-08 max_replicas_per_node: 0 is unset; above 1 is the translator’s warning', () => {
    const max = (n: unknown) => run({ image: 'x:1', deploy: { placement: { max_replicas_per_node: n } } });
    expect(max(1).draft.placement.maxReplicasPerNode).toBe(1);
    expect(max(2).draft.placement.maxReplicasPerNode).toBe(2);
    expect(max(2).diagnostics).toEqual([]);
    expect(max(0).draft.placement.maxReplicasPerNode).toBeNull();
    expect(max(-1).codes).toEqual(['values.invalid-integer']);
  });
});

describe('depends_on (DEP-01..03)', () => {
  const NO_ORDERING =
    'depends_on has no Kubernetes equivalent: containers start in any order and restart until their dependencies answer; accessories are deployed before the app';

  const stack = (web: Record<string, unknown>, overrides: NormalizeInputOverrides = {}) =>
    run({ services: { web: { image: 'x:1', ...web }, db: { image: 'postgres:16' } } }, overrides);

  test('DEP-01 list and service_started forms: one info per service', () => {
    for (const dependsOn of [['db'], { db: { condition: 'service_started' } }, { db: null }]) {
      expect(stack({ depends_on: dependsOn }).diagnostics).toEqual([
        { severity: 'info', code: 'depends_on.no-ordering', path: 'services.web.depends_on', message: NO_ORDERING },
      ]);
    }
    expect(stack({ depends_on: [] }).diagnostics).toEqual([]);
  });

  test('DEP-02 unenforced conditions and restart: true are warnings; required is accepted', () => {
    const r = stack({ depends_on: { db: { condition: 'service_healthy', restart: true, required: false } } });
    expect(r.diagnostics).toEqual([
      { severity: 'info', code: 'depends_on.no-ordering', path: 'services.web.depends_on', message: NO_ORDERING },
      {
        severity: 'warning',
        code: 'depends_on.condition-ignored',
        path: 'services.web.depends_on.db.condition',
        message: 'condition service_healthy on db is not enforced: this service may start before db is healthy',
        hint: 'Make the program retry its connections at startup.',
      },
      {
        severity: 'warning',
        code: 'depends_on.restart-ignored',
        path: 'services.web.depends_on.db.restart',
        message: 'restart: true on db is ignored: Dockflow does not restart this service when db changes',
      },
    ]);
    const completed = stack({ depends_on: { db: { condition: 'service_completed_successfully' } } });
    expect(completed.diagnostics[1].message).toBe(
      'condition service_completed_successfully on db is not enforced: this service may start before db is completed',
    );
  });

  test('DEP-03 an unknown condition is an error; an unknown service a warning; the sibling role counts', () => {
    const condition = stack({ depends_on: { db: { condition: 'ready' } } });
    expect(condition.rows).toEqual([
      ['info', 'depends_on.no-ordering', 'services.web.depends_on'],
      ['error', 'depends_on.invalid-condition', 'services.web.depends_on.db.condition'],
    ]);
    expect(condition.diagnostics[1].message).toBe('condition ready must be service_started, service_healthy or service_completed_successfully');

    const unknown = stack({ depends_on: ['nope'] });
    expect(unknown.diagnostics[1]).toEqual({
      severity: 'warning',
      code: 'depends_on.unknown-service',
      path: 'services.web.depends_on[0]',
      message: 'nope is not a service of docker-compose.yml or accessories.yml',
      hint: 'Fix the name or remove the dependency.',
    });
    expect(stack({ depends_on: { nope: {} } }).rows).toContainEqual(['warning', 'depends_on.unknown-service', 'services.web.depends_on.nope']);
    const sibling = stack({ depends_on: ['redis'] }, { sibling: { services: [{ key: 'redis', name: 'redis', aliases: [], published: [] }] } });
    expect(sibling.codes).toEqual(['depends_on.no-ordering']);
  });

  test('boolean fields follow compose-go: YAML 1.1 spellings warn, anything else is refused', () => {
    const r = stack({ depends_on: { db: { required: 'yes', restart: 'maybe' } } });
    expect(r.diagnostics.slice(1)).toEqual([
      {
        severity: 'warning',
        code: 'values.yaml11-boolean',
        path: 'services.web.depends_on.db.required',
        message: 'yes is read as true; YAML 1.2 only knows true and false',
        hint: 'Write `true`.',
      },
      {
        severity: 'error',
        code: 'values.invalid-boolean',
        path: 'services.web.depends_on.db.restart',
        message: 'expected true or false, got maybe',
        hint: 'Write `true` or `false`.',
      },
    ]);
    expect(stack({ depends_on: 'db' }).rows).toEqual([['error', 'values.invalid-type', 'services.web.depends_on']]);
    expect(stack({ depends_on: { db: 'healthy' } }).rows).toContainEqual(['error', 'values.invalid-type', 'services.web.depends_on.db']);
  });
});

describe('handler contract', () => {
  test('never throws on hostile values and keeps the defaults', () => {
    const hostile = [null, 0, -1, 'x', [], [1, [2]], { a: { b: [] } }, true];
    for (const value of hostile) {
      const body: Record<string, unknown> = { image: 'x:1', scale: value, restart: value, depends_on: value, cpus: value, cpu_quota: value };
      body.deploy = {
        mode: value,
        replicas: value,
        endpoint_mode: value,
        update_config: value,
        rollback_config: value,
        restart_policy: value,
        resources: { limits: value, reservations: { cpus: value, devices: value } },
        placement: { constraints: value, preferences: value, max_replicas_per_node: value },
      };
      expect(() => run(body)).not.toThrow();
    }
  });

  test('a service already marked fatal is left untouched', () => {
    const ctx = normalizeContext({ compose: { image: 'x:1', deploy: { mode: 'bogus', replicas: 3 } } });
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    deploy(draft, ctx.input.compose.services.web, ctx);
    expect(ctx.sink.list()).toEqual([]);
    expect(draft.replicas).toBe(1);
  });

  test('every code deploy.ts emits is exercised by this file (keys.test.ts step 3)', () => {
    const source = readFileSync(join(import.meta.dir, '../../../services/orchestrator/kubernetes/normalize/deploy.ts'), 'utf8');
    const self = readFileSync(join(import.meta.dir, 'deploy.test.ts'), 'utf8');
    const emitted = [...source.matchAll(/sink\.(?:error|warn|info)\(\s*'([a-z_]+\.[a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(40);
    const missing = [...new Set(emitted)].filter((code) => !self.includes(`'${code}'`));
    expect(missing).toEqual([]);
  });
});
