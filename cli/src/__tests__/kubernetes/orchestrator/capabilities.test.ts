import { describe, expect, it } from 'bun:test';
import {
  capabilitiesFor,
  capabilityRefusal,
  requireCapability,
  requireCapabilityFor,
} from '../../../services/orchestrator/capabilities';
import type { CapabilityName, Orchestrator, OrchestratorKind } from '../../../services/orchestrator/interfaces';
import { ErrorCode, UnsupportedOperationError } from '../../../utils/errors';

const CAPABILITY_NAMES: CapabilityName[] = ['execAsUser', 'remoteBuild', 'helm', 'volumes', 'networkPrune'];

/** Every member except `capabilities` throws: requireCapability must decide from the table alone. */
function bundle(kind: OrchestratorKind): Orchestrator {
  const capabilities = capabilitiesFor(kind);
  return new Proxy({} as Orchestrator, {
    get(_target, property) {
      if (property === 'capabilities') return capabilities;
      throw new Error(`requireCapability read orchestrator.${String(property)}`);
    },
  });
}

function refusal(run: () => void): UnsupportedOperationError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsupportedOperationError) return error;
    throw error;
  }
  throw new Error('expected an UnsupportedOperationError');
}

/** DESIGN-CORE 6.2, suggestions in the backticked form of design-06 I23 */
const EXPECTED: Record<CapabilityName, { missingOn: OrchestratorKind; message: string; suggestion?: string }> = {
  execAsUser: {
    missingOn: 'k3s',
    message:
      'dockflow exec --user is not supported with orchestrator: k3s: the Kubernetes exec API runs commands as the container user',
    suggestion:
      "Set `user:` in docker-compose.yml, or run: `dockflow exec <env> <service> -- su -s /bin/sh <user> -c '<command>'`.",
  },
  remoteBuild: {
    missingOn: 'k3s',
    message:
      'dockflow exec --user is not supported with orchestrator: k3s: k3s nodes run containerd only and ship no image builder',
    suggestion: 'Build locally (remove `options.remote_build`) or push to a registry.',
  },
  helm: {
    missingOn: 'swarm',
    message: 'dockflow exec --user requires orchestrator: k3s',
    suggestion: 'Helm releases are only supported on Kubernetes.',
  },
  volumes: {
    missingOn: 'swarm',
    message: 'dockflow exec --user is not supported with orchestrator: swarm',
    suggestion: 'List Swarm volumes on a node with `dockflow ssh <env>`, then `docker volume ls`.',
  },
  networkPrune: {
    missingOn: 'k3s',
    message: 'dockflow exec --user is not supported with orchestrator: k3s: the pod network is managed by the cluster',
  },
};

describe('capabilitiesFor (U-CAP-01)', () => {
  it('returns the Swarm row of the table', () => {
    expect(capabilitiesFor('swarm')).toEqual({
      revert: 'native',
      execAsUser: true,
      remoteBuild: true,
      helm: false,
      volumes: false,
      networkPrune: true,
      clusterState: false,
      artifactFormat: 'swarm-compose/1',
    });
  });

  it('returns the k3s row of the table', () => {
    expect(capabilitiesFor('k3s')).toEqual({
      revert: 'backend',
      execAsUser: false,
      remoteBuild: false,
      helm: true,
      volumes: true,
      networkPrune: false,
      clusterState: true,
      artifactFormat: 'k8s-manifests/1',
    });
  });

  it('returns a copy the caller may change', () => {
    const first = capabilitiesFor('k3s');
    first.helm = false;
    expect(capabilitiesFor('k3s').helm).toBe(true);
  });
});

describe('requireCapability and requireCapabilityFor (U-CAP-01)', () => {
  const operation = 'dockflow exec --user';

  for (const capability of CAPABILITY_NAMES) {
    const expected = EXPECTED[capability];
    const present: OrchestratorKind = expected.missingOn === 'k3s' ? 'swarm' : 'k3s';

    it(`${capability}: refuses on ${expected.missingOn} with the table's message and suggestion`, () => {
      for (const err of [
        refusal(() => requireCapability(bundle(expected.missingOn), capability, operation)),
        refusal(() => requireCapabilityFor(expected.missingOn, capability, operation)),
      ]) {
        expect(err.message).toBe(expected.message);
        expect(err.suggestion).toBe(expected.suggestion);
        expect(err.code).toBe(ErrorCode.UNSUPPORTED_OPERATION);
      }
      expect(capabilityRefusal(capability, operation)).toEqual(
        expected.suggestion === undefined
          ? { message: expected.message }
          : { message: expected.message, suggestion: expected.suggestion },
      );
    });

    it(`${capability}: allows ${present}`, () => {
      expect(() => requireCapability(bundle(present), capability, operation)).not.toThrow();
      expect(() => requireCapabilityFor(present, capability, operation)).not.toThrow();
    });
  }

  it('follows the message style: no trailing period, suggestions are sentences', () => {
    for (const capability of CAPABILITY_NAMES) {
      const { message, suggestion } = capabilityRefusal(capability, 'dockflow prune --networks');
      expect(message.startsWith('dockflow prune --networks ')).toBe(true);
      expect(message.endsWith('.')).toBe(false);
      if (suggestion !== undefined) expect(suggestion.endsWith('.')).toBe(true);
    }
  });

  it('requireCapabilityFor throws synchronously, before any bundle or remote call exists', () => {
    let thrown: unknown;
    let returned: unknown = 'unset';
    try {
      returned = requireCapabilityFor('k3s', 'networkPrune', 'dockflow prune --networks');
    } catch (error) {
      thrown = error;
    }
    expect(returned).toBe('unset');
    expect(thrown).toBeInstanceOf(UnsupportedOperationError);
    expect(requireCapabilityFor('swarm', 'networkPrune', 'dockflow prune --networks')).toBeUndefined();
  });
});
