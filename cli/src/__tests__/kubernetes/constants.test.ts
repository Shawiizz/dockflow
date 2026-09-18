import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as constants from '../../services/orchestrator/kubernetes/constants';
import {
  ANNOTATIONS,
  DNS_LABEL_MAX,
  DOCKFLOW_K8S_PREFIX,
  deleteWaitS,
  HELM_BIN_PATH,
  HELM_CHART_CACHE_DAYS,
  HELM_CHARTS_DIR,
  HELM_DEFAULT_TIMEOUT,
  HELM_HOME_DIR,
  HELM_TMP_DIR,
  K8S_APPLY_TIMEOUT_S,
  K8S_DELETE_WAIT_S,
  K8S_DEPLOYER_CLUSTER_ROLE_BINDING,
  K8S_DEPLOYER_SERVICE_ACCOUNT,
  K8S_DEPLOYER_TOKEN_SECRET,
  K8S_FIELD_MANAGER,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_IMAGE_IMPORT_GUARD_S,
  K8S_IMPORTED_IMAGE_REGISTRY,
  K8S_KUBECONFIG_DIR,
  K8S_KUBECONFIG_PATH,
  K8S_MANAGED_BY,
  K8S_NAMESPACE_PREFIX,
  K8S_POLL_INITIAL_S,
  K8S_PROBE_GUARD_S,
  K8S_PROBE_TIMEOUT_S,
  K8S_PROGRESS_DEADLINE_S,
  K8S_PROXY_ACME_CA_SECRET,
  K8S_PROXY_ACME_CLAIM,
  K8S_PROXY_ACME_RESTORE_POD,
  K8S_PROXY_CONFIGMAP,
  K8S_PROXY_INGRESS_CLASS,
  K8S_PROXY_LOCK_NAME,
  K8S_PROXY_RELEASE,
  K8S_REGISTRY_SECRET,
  K8S_REQUEST_TIMEOUT_S,
  K8S_REVERT_TIMEOUT_S,
  K8S_STATE_CONFIGMAP,
  K8S_STORAGE_CLASS,
  K8S_SYSTEM_NAMESPACE,
  K8S_TRANSPORT_FAILURES_TOLERATED,
  LABELS,
  MAX_LOAD_BALANCER_PORTS,
  MAX_MIN_READY_S,
  minReadySecondsFor,
  PARTS,
  PORTS_EXPANSION_MAX,
  progressDeadlineFor,
  revertWaitS,
  SERVICE_NAME_MAX,
  TRAEFIK_CRD_WAIT_S,
  TRAEFIK_HISTORY_MAX,
  TRAEFIK_LOCK_WAIT_S,
  TRAEFIK_TIMEOUT_S,
} from '../../services/orchestrator/kubernetes/constants';

const CLI_SRC = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(CLI_SRC, '..', '..');
/** the generic outer deadline of DESIGN-CORE 8.6, pinned here rather than imported (GATE-UNIT 4) */
const CONVERGENCE_TIMEOUT_S = 300;

// Kubernetes qualified name: optional DNS-1123 subdomain prefix, then a name part of at most 63.
const QUALIFIED_NAME_PART = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function splitKey(key: string): { prefix: string | null; name: string } {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? { prefix: null, name: key } : { prefix: key.slice(0, slash), name: key.slice(slash + 1) };
}

describe('U-CONST-01 label prefix and keys', () => {
  it('uses the host of the documentation site as prefix', () => {
    const docs = readFileSync(join(REPO_ROOT, 'packages', 'mcp-server', 'src', 'docs.ts'), 'utf8');
    const match = /const BASE_URL = ['"]([^'"]+)['"]/.exec(docs);
    expect(match).not.toBeNull();
    expect(DOCKFLOW_K8S_PREFIX).toBe(new URL(match?.[1] ?? '').host);
  });

  it('every LABELS and ANNOTATIONS key is a qualified name with a name part of at most 63', () => {
    for (const key of [...Object.values(LABELS), ...Object.values(ANNOTATIONS)]) {
      const { prefix, name } = splitKey(key);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(QUALIFIED_NAME_PART.test(name)).toBe(true);
      expect(prefix).not.toBeNull();
      expect((prefix ?? '').length).toBeLessThanOrEqual(253);
      expect(DNS_SUBDOMAIN.test(prefix ?? '')).toBe(true);
    }
  });

  it('keys are unique', () => {
    const labels = Object.values(LABELS);
    const annotations = Object.values(ANNOTATIONS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(annotations).size).toBe(annotations.length);
  });
});

describe('U-CONST-01 DESIGN-CORE 5.1 values', () => {
  it('names and field managers', () => {
    expect(DOCKFLOW_K8S_PREFIX).toBe('dockflow.shawiizz.dev');
    expect(K8S_MANAGED_BY).toBe('dockflow');
    expect(K8S_FIELD_MANAGER).toBe('dockflow');
    expect(K8S_FIELD_MANAGER_RELEASE_STATE).toBe('dockflow-release-state');
    expect(K8S_FIELD_MANAGER_ACCESSORIES_STATE).toBe('dockflow-accessories-state');
    expect(K8S_NAMESPACE_PREFIX).toBe('dockflow');
    expect(K8S_SYSTEM_NAMESPACE).toBe('dockflow-system');
  });

  it('label keys', () => {
    expect(LABELS).toMatchObject({
      managedBy: 'app.kubernetes.io/managed-by',
      partOf: 'app.kubernetes.io/part-of',
      instance: 'app.kubernetes.io/instance',
      name: 'app.kubernetes.io/name',
      stack: 'dockflow.shawiizz.dev/stack',
      role: 'dockflow.shawiizz.dev/role',
      service: 'dockflow.shawiizz.dev/service',
      part: 'dockflow.shawiizz.dev/part',
      hashed: 'dockflow.shawiizz.dev/hashed',
      volume: 'dockflow.shawiizz.dev/volume',
      releaseVersion: 'dockflow.shawiizz.dev/release-version',
    });
    expect(LABELS.specHash).toBe('dockflow.shawiizz.dev/spec-hash');
    expect(LABELS.valuesRevision).toBe('dockflow.shawiizz.dev/values-revision');
  });

  it('annotation keys', () => {
    expect(ANNOTATIONS).toEqual({
      stackName: 'dockflow.shawiizz.dev/stack-name',
      composeService: 'dockflow.shawiizz.dev/compose-service',
      composeVolume: 'dockflow.shawiizz.dev/compose-volume',
      release: 'dockflow.shawiizz.dev/release',
      configHash: 'dockflow.shawiizz.dev/config-hash',
      replicasBeforeStop: 'dockflow.shawiizz.dev/replicas-before-stop',
      epoch: 'dockflow.shawiizz.dev/epoch',
      lock: 'dockflow.shawiizz.dev/lock',
      nodeLabels: 'dockflow.shawiizz.dev/node-labels',
      helmValues: 'dockflow.shawiizz.dev/helm-values-sha256',
      helmChartDigest: 'dockflow.shawiizz.dev/helm-chart-sha256',
      reclaimPolicyBefore: 'dockflow.shawiizz.dev/reclaim-policy-before',
      defaultContainer: 'kubectl.kubernetes.io/default-container',
    });
  });

  it('object parts, including the release backup part of design-03 13.4', () => {
    const parts: string[] = Object.values(PARTS);
    expect(parts.sort()).toEqual(
      ['helper', 'registry', 'release', 'release-backup', 'stack', 'state', 'system'].sort(),
    );
    expect(PARTS.releaseBackup).toBe('release-backup');
  });

  it('reserved object names, paths and limits', () => {
    expect(K8S_STATE_CONFIGMAP).toBe('dockflow-state');
    expect(K8S_REGISTRY_SECRET).toBe('dockflow-registry');
    expect(K8S_STORAGE_CLASS).toBe('dockflow-local');
    expect(K8S_PROXY_RELEASE).toBe('dockflow-traefik');
    expect(K8S_PROXY_CONFIGMAP).toBe('dockflow-proxy');
    expect(K8S_PROXY_LOCK_NAME).toBe('lock-dockflow-proxy');
    expect(K8S_DEPLOYER_SERVICE_ACCOUNT).toBe('dockflow-deployer');
    expect(K8S_DEPLOYER_TOKEN_SECRET).toBe('dockflow-deployer-token');
    expect(K8S_DEPLOYER_CLUSTER_ROLE_BINDING).toBe('dockflow-deployer');
    expect(K8S_IMPORTED_IMAGE_REGISTRY).toBe('dockflow.invalid');
    expect(K8S_KUBECONFIG_DIR).toBe('/var/lib/dockflow/kube');
    expect(K8S_KUBECONFIG_PATH).toBe('/var/lib/dockflow/kube/config');
    expect(HELM_BIN_PATH).toBe('/usr/local/lib/dockflow/bin/helm');
    expect(HELM_HOME_DIR).toBe('/var/lib/dockflow/helm');
    expect(SERVICE_NAME_MAX).toBe(52);
    expect(DNS_LABEL_MAX).toBe(63);
  });
});

describe('DESIGN-CORE 8.6 timeouts', () => {
  it('values', () => {
    expect(K8S_REQUEST_TIMEOUT_S).toBe(30);
    expect(K8S_APPLY_TIMEOUT_S).toBe(120);
    expect(K8S_PROBE_TIMEOUT_S).toBe(5);
    expect(K8S_PROBE_GUARD_S).toBe(10);
    expect(K8S_PROGRESS_DEADLINE_S).toBe(240);
    expect(K8S_POLL_INITIAL_S).toBe(2);
    expect(K8S_REVERT_TIMEOUT_S).toBe(180);
    expect(K8S_DELETE_WAIT_S).toBe(120);
    expect(K8S_TRANSPORT_FAILURES_TOLERATED).toBe(2);
    expect(HELM_DEFAULT_TIMEOUT).toBe('5m');
    expect(K8S_IMAGE_IMPORT_GUARD_S).toBe(900);
  });

  it('the progress deadline is strictly below the convergence deadline', () => {
    expect(K8S_PROGRESS_DEADLINE_S).toBeLessThan(CONVERGENCE_TIMEOUT_S);
  });

  it('declares no Kubernetes stability window (HEALTH_STABILITY_WINDOW_S is the only one)', () => {
    expect('K8S_STABILITY_WINDOW_S' in constants).toBe(false);
  });
});

describe('design-03 21.1 derived wait budgets', () => {
  it('deleteWaitS keeps the floor and follows the longest grace period', () => {
    expect(deleteWaitS([])).toBe(120);
    expect(deleteWaitS([{ graceSeconds: 300 }])).toBe(330);
    expect(deleteWaitS([{ graceSeconds: 10 }, { graceSeconds: 30 }])).toBe(120);
    expect(deleteWaitS([{ graceSeconds: 10 }, { graceSeconds: 600 }, { graceSeconds: 30 }])).toBe(630);
  });

  it('revertWaitS keeps the floor and follows the longest grace period', () => {
    expect(revertWaitS([])).toBe(180);
    expect(revertWaitS([{ graceSeconds: 300 }])).toBe(360);
    expect(revertWaitS([{ graceSeconds: 30 }])).toBe(180);
  });
});

describe('PD-5 rollout timing', () => {
  it('MAX_MIN_READY_S leaves 90 s of the convergence deadline', () => {
    expect(MAX_MIN_READY_S).toBe(210);
    expect(MAX_MIN_READY_S).toBe(CONVERGENCE_TIMEOUT_S - 90);
  });

  it('minReadySecondsFor rounds the monitor up to whole seconds and never caps it', () => {
    expect(minReadySecondsFor(0)).toBe(0);
    expect(minReadySecondsFor(1)).toBe(1);
    expect(minReadySecondsFor(1500)).toBe(2);
    expect(minReadySecondsFor(5_000)).toBe(5);
    expect(minReadySecondsFor(30_000)).toBe(30);
    expect(minReadySecondsFor(250_000)).toBe(250);
    expect(minReadySecondsFor(600_000)).toBe(600);
  });

  it('progressDeadlineFor', () => {
    expect(progressDeadlineFor(0)).toBe(240);
    expect(progressDeadlineFor(200)).toBe(260);
    expect(progressDeadlineFor(210)).toBe(270);
  });

  it('T-STRAT-08 values: 90s -> 240, 200s -> 260', () => {
    expect(progressDeadlineFor(minReadySecondsFor(90_000))).toBe(240);
    expect(progressDeadlineFor(minReadySecondsFor(200_000))).toBe(260);
    expect(minReadySecondsFor(250_000)).toBeGreaterThan(MAX_MIN_READY_S);
  });

  it('for every whole second up to MAX_MIN_READY_S, minReady < deadline < CONVERGENCE_TIMEOUT_S', () => {
    for (let minReady = 0; minReady <= MAX_MIN_READY_S; minReady++) {
      const deadline = progressDeadlineFor(minReady);
      expect(deadline).toBeGreaterThan(minReady);
      expect(deadline).toBeLessThan(CONVERGENCE_TIMEOUT_S);
      expect(deadline).toBeGreaterThanOrEqual(K8S_PROGRESS_DEADLINE_S);
      expect(deadline).toBeLessThanOrEqual(270);
    }
  });
});

describe('design-04 1 proxy and Helm constants', () => {
  it('values', () => {
    expect(K8S_PROXY_ACME_CLAIM).toBe('dockflow-traefik');
    expect(K8S_PROXY_ACME_CA_SECRET).toBe('dockflow-traefik-acme-ca');
    expect(K8S_PROXY_ACME_RESTORE_POD).toBe('dockflow-acme-restore');
    expect(K8S_PROXY_INGRESS_CLASS).toBe('traefik');
    expect(HELM_TMP_DIR).toBe('/var/lib/dockflow/helm/tmp');
    expect(HELM_CHARTS_DIR).toBe('/var/lib/dockflow/helm/charts');
    expect(HELM_CHART_CACHE_DAYS).toBe(30);
    expect(TRAEFIK_TIMEOUT_S).toBe(300);
    expect(TRAEFIK_HISTORY_MAX).toBe(5);
    expect(TRAEFIK_LOCK_WAIT_S).toBe(300);
    expect(TRAEFIK_CRD_WAIT_S).toBe(60);
  });
});

describe('port limits', () => {
  it('values', () => {
    expect(MAX_LOAD_BALANCER_PORTS).toBe(10);
    expect(PORTS_EXPANSION_MAX).toBe(100);
  });
});

describe('module boundaries', () => {
  it('imports only CONVERGENCE_TIMEOUT_S from cli/src/constants.ts and nothing else', () => {
    const source = readFileSync(join(CLI_SRC, 'services', 'orchestrator', 'kubernetes', 'constants.ts'), 'utf8');
    const imports = source.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
    expect(imports).toEqual(["import { CONVERGENCE_TIMEOUT_S } from '../../../constants';"]);
  });
});
