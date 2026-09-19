/**
 * The one error a deploy reports when a role did not converge or failed its health check, given
 * what the automatic revert did about it (DESIGN-CORE 8.1, design-03 3.5). Pure: deploy-phases
 * throws what these functions return.
 */

import { DeployError, ErrorCode } from '../../utils/errors';
import type { ConvergenceResult, InternalHealthResult, RevertResult, ServiceFailure, StackRole } from './interfaces';

export interface FailureInfo {
  env: string;
  role: StackRole;
  /** release the app role ran before this deploy; null on a first deploy and for accessories */
  previousVersion: string | null;
}

interface FailedOutcome {
  failures: ServiceFailure[];
  message?: string;
  suggestion?: string;
  /** Swarm rolled the update back by itself (failure_action: rollback) */
  nativeRolledBack: boolean;
  /** used only when neither a message nor a failure says what happened */
  fallback: string;
}

const FIRST_DEPLOY_LEFT_IN_PLACE =
  'nothing to roll back to (first deployment of this stack); workloads were left in place for debugging';

export function convergenceFailureError(c: ConvergenceResult, r: RevertResult, info: FailureInfo): DeployError {
  return failureError(
    {
      failures: c.failures,
      message: c.message,
      suggestion: c.suggestion,
      nativeRolledBack: c.status === 'reverted',
      fallback:
        c.status === 'reverted' ? 'The orchestrator rolled the update back' : `Services did not converge (${c.status})`,
    },
    r,
    info,
  );
}

export function healthFailureError(h: InternalHealthResult, r: RevertResult, info: FailureInfo): DeployError {
  return failureError(
    {
      failures: h.failures,
      message: h.message,
      nativeRolledBack: h.rolledBack,
      fallback: h.rolledBack ? 'The orchestrator rolled the update back' : 'Services did not pass the health check',
    },
    r,
    info,
  );
}

function failureError(outcome: FailedOutcome, r: RevertResult, info: FailureInfo): DeployError {
  // the revert's own message carries the real cause (I-8): failure_action, a Job, no history
  const first = outcome.failures[0]?.message ?? outcome.message ?? outcome.fallback;
  switch (r.status) {
    case 'failed':
      return new DeployError(
        `Deploy failed and the automatic revert did not converge (${r.message ?? 'no detail was reported'})`,
        ErrorCode.ROLLBACK_FAILED,
        `Run \`dockflow status ${info.env}\`, then \`dockflow rollback ${info.env}\`.`,
      );
    case 'reverted':
      return new DeployError(
        `${first}; ${r.message ?? revertedText(r, info)}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        outcome.suggestion,
      );
    case 'nothing-to-revert':
      return new DeployError(`${first}; ${r.message ?? leftInPlaceText(info)}`, ErrorCode.DEPLOY_FAILED, outcome.suggestion);
    case 'native': {
      const message = outcome.message ?? outcome.failures[0]?.message ?? outcome.fallback;
      if (outcome.nativeRolledBack) {
        return new DeployError(message, ErrorCode.HEALTH_CHECK_FAILED, logsSuggestion(outcome, info));
      }
      return new DeployError(
        message,
        ErrorCode.DEPLOY_FAILED,
        outcome.suggestion ?? `Run \`dockflow diagnose ${info.env}\`.`,
      );
    }
  }
}

function revertedText(r: RevertResult, info: FailureInfo): string {
  const services = r.services.length > 0 ? ` ${r.services.join(', ')}` : '';
  return info.previousVersion === null ? `reverted${services}` : `reverted${services} to ${info.previousVersion}`;
}

function leftInPlaceText(info: FailureInfo): string {
  if (info.role === 'app' && info.previousVersion === null) return FIRST_DEPLOY_LEFT_IN_PLACE;
  return 'nothing was rolled back; workloads were left in place for debugging';
}

function logsSuggestion(outcome: FailedOutcome, info: FailureInfo): string {
  const service = outcome.failures[0]?.service ?? '<service>';
  const command = info.role === 'accessory' ? 'dockflow accessories logs' : 'dockflow logs';
  return `Check service logs with \`${command} ${info.env} ${service}\`.`;
}
