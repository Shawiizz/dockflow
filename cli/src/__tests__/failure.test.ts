import { describe, expect, it } from 'bun:test';
import { convergenceFailureError, type FailureInfo, healthFailureError } from '../services/orchestrator/failure';
import type {
  ConvergenceResult,
  InternalHealthResult,
  RevertResult,
  ServiceFailure,
} from '../services/orchestrator/interfaces';
import { DeployError, ErrorCode } from '../utils/errors';
import { expectCliError } from './kubernetes/support/matchers';

// Every row of design-03 3.5 (DESIGN-CORE 8.1 as amended by I-8).

const APP: FailureInfo = { env: 'production', role: 'app', previousVersion: '1.4.1' };
const FIRST_APP: FailureInfo = { env: 'production', role: 'app', previousVersion: null };
const ACCESSORY: FailureInfo = { env: 'production', role: 'accessory', previousVersion: null };

const CRASH: ServiceFailure = {
  service: 'web',
  reason: 'CrashLoopBackOff',
  message: 'Service web keeps crashing: container web restarted 3 time(s), last exit code 1 (Error)',
};
const PULL: ServiceFailure = {
  service: 'api',
  reason: 'ImagePullBackOff',
  message: 'Service api cannot pull image registry.example.com/shop/api:1.4.2',
};

const NATIVE: RevertResult = { status: 'native', services: [] };

function convergence(fields: Partial<ConvergenceResult> = {}): ConvergenceResult {
  return {
    status: 'failed',
    failures: [CRASH],
    message: 'Service web did not converge',
    suggestion: 'Run `dockflow logs production web` to see why it crashes.',
    ...fields,
  };
}

function unhealthy(fields: Partial<InternalHealthResult> = {}): InternalHealthResult {
  return { healthy: false, rolledBack: false, failures: [CRASH], message: 'Service web restarted during the health window', ...fields };
}

describe('Swarm native revert (revert result native)', () => {
  it('convergence rolled back by Swarm: HEALTH_CHECK_FAILED with its message and a logs suggestion naming the service (U-FLOW-MAP-04)', async () => {
    const c = convergence({ status: 'reverted', failures: [], message: 'Service web was rolled back by Swarm: task failed' });
    const error = await expectCliError(convergenceFailureError(c, NATIVE, APP), {
      type: DeployError,
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: 'Service web was rolled back by Swarm: task failed',
      suggestion: 'Check service logs with `dockflow logs production <service>`.',
    });
    expect(error).toBeInstanceOf(DeployError);

    await expectCliError(convergenceFailureError(convergence({ status: 'reverted' }), NATIVE, APP), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: 'Service web did not converge',
      suggestion: 'Check service logs with `dockflow logs production web`.',
    });
  });

  it('health check rolled back by Swarm: HEALTH_CHECK_FAILED with the health message', async () => {
    await expectCliError(healthFailureError(unhealthy({ rolledBack: true }), NATIVE, APP), {
      type: DeployError,
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: 'Service web restarted during the health window',
      suggestion: 'Check service logs with `dockflow logs production web`.',
    });
  });

  it('accessory suggestions point at `dockflow accessories logs`', async () => {
    const c = convergence({ status: 'reverted', failures: [{ ...CRASH, service: 'cache' }] });
    await expectCliError(convergenceFailureError(c, NATIVE, ACCESSORY), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      suggestion: 'Check service logs with `dockflow accessories logs production cache`.',
    });
    await expectCliError(healthFailureError(unhealthy({ rolledBack: true, failures: [{ ...CRASH, service: 'cache' }] }), NATIVE, ACCESSORY), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      suggestion: 'Check service logs with `dockflow accessories logs production cache`.',
    });
  });

  it('failed or timed out without a Swarm rollback: DEPLOY_FAILED with the convergence message and suggestion (U-FLOW-MAP-05)', async () => {
    await expectCliError(convergenceFailureError(convergence(), NATIVE, APP), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Service web did not converge',
      suggestion: 'Run `dockflow logs production web` to see why it crashes.',
    });
    await expectCliError(convergenceFailureError(convergence({ status: 'timeout', suggestion: undefined }), NATIVE, APP), {
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Service web did not converge',
      suggestion: 'Run `dockflow diagnose production`.',
    });
  });

  it('unhealthy without a Swarm rollback: DEPLOY_FAILED with the health message and the diagnose suggestion', async () => {
    await expectCliError(healthFailureError(unhealthy(), NATIVE, APP), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Service web restarted during the health window',
      suggestion: 'Run `dockflow diagnose production`.',
    });
  });

  it('with neither a message nor a failure, the status still says what happened', async () => {
    await expectCliError(convergenceFailureError({ status: 'timeout', failures: [] }, NATIVE, APP), {
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Services did not converge (timeout)',
    });
  });
});

describe('backend revert reverted', () => {
  it('HEALTH_CHECK_FAILED: first failure message, then what the revert did (U-FLOW-MAP-01)', async () => {
    const r: RevertResult = { status: 'reverted', services: ['web', 'api'], message: 'reverted web, api to 1.4.1' };
    await expectCliError(convergenceFailureError(convergence({ failures: [CRASH, PULL] }), r, APP), {
      type: DeployError,
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message:
        'Service web keeps crashing: container web restarted 3 time(s), last exit code 1 (Error); reverted web, api to 1.4.1',
      suggestion: 'Run `dockflow logs production web` to see why it crashes.',
    });
  });

  it('a revert without a message is described from its services and the previous version', async () => {
    const r: RevertResult = { status: 'reverted', services: ['web'] };
    await expectCliError(convergenceFailureError(convergence(), r, APP), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: `${CRASH.message}; reverted web to 1.4.1`,
    });
  });

  it('without failures the convergence message leads', async () => {
    const r: RevertResult = { status: 'reverted', services: ['web'], message: 'reverted web to 1.4.1' };
    await expectCliError(convergenceFailureError(convergence({ status: 'timeout', failures: [] }), r, APP), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: 'Service web did not converge; reverted web to 1.4.1',
    });
  });

  it('an unhealthy role that was reverted is HEALTH_CHECK_FAILED too', async () => {
    const r: RevertResult = { status: 'reverted', services: ['web'], message: 'reverted web to 1.4.1' };
    const error = await expectCliError(healthFailureError(unhealthy(), r, APP), {
      code: ErrorCode.HEALTH_CHECK_FAILED,
      message: `${CRASH.message}; reverted web to 1.4.1`,
    });
    expect(error.suggestion).toBeUndefined();
  });
});

describe('backend revert failed', () => {
  it('ROLLBACK_FAILED naming the revert detail, with status then rollback as the way out (U-FLOW-MAP-02)', async () => {
    const r: RevertResult = { status: 'failed', services: ['web'], message: 'deployment/web-app did not become ready within 180s' };
    const expected = {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Deploy failed and the automatic revert did not converge (deployment/web-app did not become ready within 180s)',
      suggestion: 'Run `dockflow status production`, then `dockflow rollback production`.',
    };
    await expectCliError(convergenceFailureError(convergence(), r, APP), expected);
    await expectCliError(healthFailureError(unhealthy(), r, APP), expected);
  });
});

describe('backend revert nothing-to-revert', () => {
  it('first deployment: DEPLOY_FAILED ending with the left-in-place sentence (U-FLOW-MAP-03)', async () => {
    const r: RevertResult = {
      status: 'nothing-to-revert',
      services: [],
      message: 'nothing to roll back to (first deployment of this stack); workloads were left in place for debugging',
    };
    const error = await expectCliError(convergenceFailureError(convergence(), r, FIRST_APP), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      suggestion: 'Run `dockflow logs production web` to see why it crashes.',
    });
    expect(error.message).toBe(
      `${CRASH.message}; nothing to roll back to (first deployment of this stack); workloads were left in place for debugging`,
    );
  });

  it('the revert message carries the real cause, not a fixed first-deploy text (I-8)', async () => {
    const r: RevertResult = {
      status: 'nothing-to-revert',
      services: [],
      message: 'web was not reverted because its update_config.failure_action is pause',
    };
    const error = await expectCliError(convergenceFailureError(convergence(), r, APP), { code: ErrorCode.DEPLOY_FAILED });
    expect(error.message).toBe(`${CRASH.message}; web was not reverted because its update_config.failure_action is pause`);
    expect(error.message).not.toContain('first deployment');

    const health = await expectCliError(healthFailureError(unhealthy(), r, APP), { code: ErrorCode.DEPLOY_FAILED });
    expect(health.message).toBe(`${CRASH.message}; web was not reverted because its update_config.failure_action is pause`);
  });

  it('without a revert message, only a first app deploy claims there was nothing before', async () => {
    const r: RevertResult = { status: 'nothing-to-revert', services: [] };
    const first = await expectCliError(convergenceFailureError(convergence(), r, FIRST_APP), { code: ErrorCode.DEPLOY_FAILED });
    expect(first.message).toEndWith('nothing to roll back to (first deployment of this stack); workloads were left in place for debugging');
    const later = await expectCliError(convergenceFailureError(convergence(), r, APP), { code: ErrorCode.DEPLOY_FAILED });
    expect(later.message).not.toContain('first deployment');
  });
});
