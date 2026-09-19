import { describe, expect, test } from 'bun:test';
import type { HelmReleaseStatus } from '../../../services/orchestrator/interfaces';
import type { DistributionTraits } from '../../../services/orchestrator/kubernetes/distribution';
import {
  capabilitiesFromValues,
  classlessIngressWarning,
  hostPortRefusals,
  type InternalProxyPlan,
  INTENT_FIELDS,
  intentFieldHashes,
  intentSha256,
  missingValuesRevisionSelector,
  newerValuesRevisionSelector,
  PROXY_STATE_SCHEMA,
  type PlanProxyInput,
  type ProxyObservation,
  type ProxyState,
  parseProxyState,
  pendingStaleAfterS,
  planProxy,
  podPortConflicts,
  podPortRefusal,
  proxyReleaseFrom,
  proxyStateData,
  schedulingFailures,
} from '../../../services/orchestrator/kubernetes/helm/plan';
import { buildTraefikValues, type ProxyWarning, type TraefikIntent } from '../../../services/orchestrator/kubernetes/helm/traefik-values';
import type { Event, Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import { ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';

type TraefikChartPin = NonNullable<Parameters<typeof buildTraefikValues>[3]>;

const PIN: TraefikChartPin = {
  chart: 'traefik',
  repo: 'https://traefik.github.io/charts',
  version: '41.6.0',
  url: 'https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz',
  sha256: 'cd7254ea853da73bdb88edc896f079b88d43ffa0bfe699fdbf21081361eac365',
  appVersion: 'v3.7.13',
};

const TRAITS: DistributionTraits = {
  name: 'k3s',
  defaultStorageClass: 'dockflow-local',
  defaultStorageClassAccessModes: ['ReadWriteOnce'],
  controlPlaneNodeLabel: { key: 'node-role.kubernetes.io/control-plane', value: 'true' },
  loadBalancerNodePorts: false,
  clusterDnsNameservers: 1,
  helperImage: 'registry.example.com/helper:1',
  imageStoreRoot: '/var/lib/images',
  headlessServiceNeedsPort: true,
  headlessPlaceholderPort: { port: 9, protocol: 'TCP' },
  reservedHostPorts: [],
};

const NOW = new Date('2026-09-17T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();
const STALE_S = pendingStaleAfterS(300);

const PRODUCTION = { stackId: 'dockflow-shop-production', stackName: 'shop-production' };
const STAGING = { stackId: 'dockflow-shop-staging', stackName: 'shop-staging' };
const WIKI = { stackId: 'dockflow-wiki-production', stackName: 'wiki-production' };

function intent(overrides: Partial<TraefikIntent> = {}): TraefikIntent {
  return {
    acme: true,
    email: 'ops@example.com',
    caServer: null,
    caBundle: null,
    dashboard: { enabled: false, domain: null },
    defaultIngressClass: false,
    ...overrides,
  };
}
const HTTP = intent({ acme: false, email: null });

const desiredFor = (value: TraefikIntent, hostname = 'main'): Record<string, unknown> => buildTraefikValues(value, TRAITS, { hostname }, PIN);

function stateFor(owner: { stackId: string; stackName: string }, value: TraefikIntent, hostname = 'main'): ProxyState {
  const data = proxyStateData({
    owner,
    intent: value,
    desired: desiredFor(value, hostname),
    placement: { hostname, node: hostname },
    dockflowVersion: '2.0.0',
    now: NOW,
    pin: PIN,
  });
  const state = parseProxyState(data);
  if (state === null) throw new Error('state expected');
  return state;
}

/** A deployed, ready, unchanged proxy managed by `owner` with `value` on node main. */
function healthy(value: TraefikIntent, owner = PRODUCTION): ProxyObservation {
  return {
    release: { revision: 3, status: 'deployed', chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: ago(3600) },
    deployedValues: desiredFor(value),
    state: stateFor(owner, value),
    crdsPresent: true,
    deployment: { replicas: 1, readyReplicas: 1 },
    pods: [{ name: 'dockflow-traefik-abc', node: 'main', phase: 'Running', ready: true, status: 'Running' }],
    ownerNamespaceExists: owner === PRODUCTION ? null : true,
    pendingSince: null,
    lastDeployedRevision: 3,
    deployedValuesNewer: false,
    revisionLabelMissing: false,
  };
}

const ABSENT: ProxyObservation = {
  release: null,
  deployedValues: null,
  state: null,
  crdsPresent: false,
  deployment: null,
  pods: [],
  ownerNamespaceExists: null,
  pendingSince: null,
  lastDeployedRevision: null,
  deployedValuesNewer: false,
  revisionLabelMissing: false,
};

function managing(value: TraefikIntent, observation: ProxyObservation, overrides: Partial<PlanProxyInput> = {}): InternalProxyPlan {
  return planProxy({
    manage: true,
    intent: value,
    desired: desiredFor(value),
    placement: { hostname: 'main' },
    me: PRODUCTION,
    env: 'production',
    distribution: 'k3s',
    observation,
    now: NOW,
    pin: PIN,
    ...overrides,
  });
}

function consuming(value: TraefikIntent, observation: ProxyObservation, me = STAGING): InternalProxyPlan {
  return planProxy({
    manage: false,
    intent: value,
    desired: null,
    placement: null,
    me,
    env: 'staging',
    distribution: 'k3s',
    observation,
    now: NOW,
    pin: PIN,
  });
}

const codes = (warnings: readonly ProxyWarning[]): string[] => warnings.map((warning) => warning.code);

function expectRefusal(plan: InternalProxyPlan, code: string): Extract<InternalProxyPlan, { kind: 'refuse' }>['refusal'] {
  if (plan.kind !== 'refuse') throw new Error(`expected a refusal, got ${plan.kind}`);
  expect(plan.refusal.code).toBe(code);
  return plan.refusal;
}

function expectPlan(plan: InternalProxyPlan, kind: Exclude<InternalProxyPlan['kind'], 'refuse'>): Extract<InternalProxyPlan, { kind: typeof kind }> {
  if (plan.kind === 'refuse') throw new Error(`expected ${kind}, got a refusal: ${plan.refusal.message}`);
  expect(plan.kind).toBe(kind);
  return plan;
}

const FIREWALL_SUGGESTION = 'If your nodes run ufw or firewalld, re-run `dockflow setup k3s production` to open ports 80 and 443.';

// ---------------------------------------------------------------------------
// Recorded state (2.8.1)
// ---------------------------------------------------------------------------

describe('proxy state', () => {
  test('proxyStateData holds hashes, capabilities and the pinned node, never the e-mail', () => {
    const value = intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } });
    const desired = desiredFor(value);
    const data = proxyStateData({ owner: PRODUCTION, intent: value, desired, placement: { hostname: 'main', node: 'main' }, dockflowVersion: '2.0.0', now: NOW, pin: PIN });
    expect(data).toEqual({
      schema: '2',
      owner: 'dockflow-shop-production',
      'owner-stack-name': 'shop-production',
      'chart-version': '41.6.0',
      'values-revision': '3',
      'values-sha256': sha256Hex(canonicalJson(desired)),
      'intent-sha256': intentSha256(value),
      'intent-fields': canonicalJson(intentFieldHashes(value)),
      capabilities: '{"acme":true,"dashboard":true,"defaultIngressClass":false,"redirectToHttps":true}',
      'node-hostname': 'main',
      node: 'main',
      'dockflow-version': '2.0.0',
      'updated-at': '2026-09-17T12:00:00.000Z',
    });
    expect(JSON.stringify(data)).not.toContain('ops@example.com');
  });

  test('parseProxyState reads what proxyStateData writes, and is lenient with damaged data', () => {
    const state = stateFor(PRODUCTION, intent());
    expect(state).toMatchObject({
      schema: PROXY_STATE_SCHEMA,
      owner: 'dockflow-shop-production',
      ownerStackName: 'shop-production',
      chartVersion: '41.6.0',
      valuesRevision: 3,
      intentSha256: intentSha256(intent()),
      intentFields: intentFieldHashes(intent()),
      capabilities: { acme: true, redirectToHttps: true, dashboard: false, defaultIngressClass: false },
      nodeHostname: 'main',
      node: 'main',
      dockflowVersion: '2.0.0',
      updatedAt: '2026-09-17T12:00:00.000Z',
    });
    expect(parseProxyState(null)).toBeNull();
    expect(parseProxyState(undefined)).toBeNull();
    expect(parseProxyState({ schema: 'x', 'intent-fields': '{broken', capabilities: '{"acme":"yes"}', 'values-revision': '' })).toEqual({
      schema: null,
      owner: null,
      ownerStackName: null,
      chartVersion: null,
      valuesRevision: null,
      valuesSha256: null,
      intentSha256: null,
      intentFields: null,
      capabilities: null,
      nodeHostname: null,
      node: null,
      dockflowVersion: null,
      updatedAt: null,
    });
    expect(parseProxyState({ 'intent-fields': '{"acme":"a","email":7,"unknown":"x"}' })?.intentFields).toEqual({ acme: 'a' });
  });

  test('intent hashes: one per field, each field changes its own hash only', () => {
    const base = intentFieldHashes(intent());
    expect(Object.keys(base)).toEqual([...INTENT_FIELDS]);
    expect(base.acme).toBe(sha256Hex('true'));
    const other = intentFieldHashes(intent({ email: 'admin@example.com' }));
    expect(INTENT_FIELDS.filter((field) => other[field] !== base[field])).toEqual(['email']);
    expect(intentSha256(intent({ email: 'admin@example.com' }))).not.toBe(intentSha256(intent()));
  });
});

describe('observation helpers', () => {
  test('proxyReleaseFrom picks dockflow-traefik and splits the chart version', () => {
    const rows: HelmReleaseStatus[] = [
      { name: 'other', namespace: 'dockflow-system', role: null, revision: 1, status: 'deployed', chart: 'other-1.0.0', appVersion: null, updated: null },
      { name: 'dockflow-traefik', namespace: 'dockflow-system', role: null, revision: 4, status: 'pending-upgrade', chart: 'traefik-41.6.0', appVersion: 'v3.7.13', updated: ago(5) },
    ];
    expect(proxyReleaseFrom(rows)).toEqual({ revision: 4, status: 'pending-upgrade', chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: ago(5) });
    expect(proxyReleaseFrom(rows.slice(0, 1))).toBeNull();
  });

  test('O8 selectors name only the proxy release and read labels', () => {
    expect(newerValuesRevisionSelector()).toBe(
      'owner=helm,name=dockflow-traefik,status=deployed,dockflow.shawiizz.dev/values-revision,dockflow.shawiizz.dev/values-revision notin (1,2,3)',
    );
    expect(missingValuesRevisionSelector()).toBe('owner=helm,name=dockflow-traefik,status=deployed,!dockflow.shawiizz.dev/values-revision');
  });

  test('capabilitiesFromValues reads ACME, the redirect, the dashboard and the default class back', () => {
    expect(capabilitiesFromValues(desiredFor(intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } })))).toEqual({
      acme: true,
      redirectToHttps: true,
      dashboard: true,
      defaultIngressClass: false,
    });
    expect(capabilitiesFromValues(desiredFor(intent({ acme: false, email: null, defaultIngressClass: true })))).toEqual({
      acme: false,
      redirectToHttps: false,
      dashboard: false,
      defaultIngressClass: true,
    });
    expect(capabilitiesFromValues({})).toEqual({ acme: false, redirectToHttps: false, dashboard: false, defaultIngressClass: false });
    expect(capabilitiesFromValues(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Consuming rows C1-C4
// ---------------------------------------------------------------------------

describe('planProxy, consuming stack (proxy.manage: false)', () => {
  test('C1: nothing installed -> E-PX-ABSENT', () => {
    expect(consuming(HTTP, ABSENT)).toEqual({
      kind: 'refuse',
      warnings: [],
      refusal: {
        code: 'E-PX-ABSENT',
        errorCode: ErrorCode.VALIDATION_FAILED,
        message: 'No Dockflow Traefik is installed on this cluster and `proxy.manage` is false, so this stack has nothing to route through',
        suggestion: 'Deploy the stack that manages the proxy first, or set `proxy.manage: true` here to install it.',
      },
    });
  });

  test('C2: only traefik.io CRDs -> consume a proxy installed outside Dockflow, with W-PX-FOREIGN-PROXY', () => {
    const plan = expectPlan(consuming(HTTP, { ...ABSENT, crdsPresent: true }), 'consume');
    expect(plan.warnings).toEqual([
      {
        code: 'W-PX-FOREIGN-PROXY',
        message:
          'No Dockflow-managed Traefik is installed, so the routes of shop-staging are applied for the Traefik that owns the traefik.io CRDs, whose entry points Dockflow cannot check',
        suggestion: 'Check that its entry points are named `web` and `websecure`, or set `proxy.manage: true` to let Dockflow install its own Traefik.',
      },
    ]);
    expect(plan).toMatchObject({ applyCrds: false, recoverTo: null, adoptState: false });
    // a Deployment without release, ConfigMap or values: nothing tells what it offers
    const bare = consuming(intent({ email: null }), { ...ABSENT, crdsPresent: true, deployment: { replicas: 1, readyReplicas: 1 } });
    expect(codes(expectPlan(bare, 'consume').warnings)).toEqual(['W-PX-FOREIGN-PROXY']);
  });

  test('C3: routes that need ACME behind a proxy without it -> E-PX-INCOMPATIBLE', () => {
    const refusal = expectRefusal(consuming(intent({ email: null }), healthy(HTTP, STAGING), PRODUCTION), 'E-PX-INCOMPATIBLE');
    expect(refusal).toEqual({
      code: 'E-PX-INCOMPATIBLE',
      errorCode: ErrorCode.VALIDATION_FAILED,
      message:
        'Traefik in dockflow-system was installed without ACME by stack shop-staging, so the websecure entry point is not published and the letsencrypt resolver does not exist',
      suggestion:
        'Let the stack with `proxy.acme: true` manage the proxy (`proxy.manage: true` here, `proxy.manage: false` in shop-staging), or set `proxy.acme: false` here to route over HTTP.',
    });
  });

  test('C3 reads the capabilities from the deployed values when no ConfigMap exists', () => {
    expectRefusal(consuming(intent({ email: null }), { ...healthy(HTTP, STAGING), state: null }, PRODUCTION), 'E-PX-INCOMPATIBLE');
    expectPlan(consuming(intent({ email: null }), { ...healthy(intent()), state: null }, STAGING), 'consume');
  });

  test('C4: consume, never refused for a pending or failed release', () => {
    for (const status of ['pending-upgrade', 'failed'] as const) {
      const observation = healthy(intent());
      observation.release = { revision: 4, status, chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: ago(60) };
      observation.pendingSince = ago(60);
      expect(consuming(HTTP, observation)).toEqual({ kind: 'consume', reasons: [], warnings: [], applyCrds: false, recoverTo: null, adoptState: false });
    }
  });

  test('C4: settings a consuming stack cannot apply are reported by name', () => {
    const mine = intent({
      email: null,
      caServer: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      dashboard: { enabled: true, domain: 'traefik-staging.example.com' },
      defaultIngressClass: true,
    });
    const plan = expectPlan(consuming(mine, healthy(intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } }))), 'consume');
    expect(plan.warnings).toEqual([
      {
        code: 'W-PX-SETTINGS-IGNORED',
        message:
          'proxy.dashboard, proxy.default_ingress_class, proxy.acme_ca_server of shop-staging differ from the Traefik that shop-production manages and are ignored, because shop-staging sets proxy.manage: false',
        suggestion: 'Change these settings in shop-production, or remove them from this stack.',
      },
    ]);
    // settings left at their defaults are never reported, even when the owner's differ
    expect(expectPlan(consuming(HTTP, healthy(intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } }))), 'consume').warnings).toEqual([]);
  });

  test('C4: not ready and missing CRDs are warned about', () => {
    const observation = { ...healthy(intent()), crdsPresent: false, deployment: { replicas: 1, readyReplicas: 0 } };
    observation.pods = [{ name: 'dockflow-traefik-abc', node: 'main', phase: 'Running', ready: false, status: 'CrashLoopBackOff' }];
    expect(expectPlan(consuming(HTTP, observation), 'consume').warnings).toEqual([
      {
        code: 'W-PX-NOT-READY',
        message: 'Traefik in dockflow-system is not ready (CrashLoopBackOff), so routes do not serve traffic until it recovers',
        suggestion: 'Run `dockflow diagnose staging`.',
      },
      {
        code: 'W-PX-CRDS-MISSING',
        message: 'The cluster has no traefik.io CRDs, so the routes of shop-staging cannot be applied',
        suggestion: 'Deploy the stack that manages the proxy first, or set `proxy.manage: true` here.',
      },
    ]);
  });

  test('a consuming stack needs no placement and never gets a placement warning or refusal', () => {
    const plan = planProxy({
      manage: false,
      intent: HTTP,
      desired: null,
      placement: { hostname: 'ghost', warnings: [{ code: 'W-PX-NODE-MOVED', message: 'x' }] },
      me: STAGING,
      env: 'staging',
      distribution: 'k3s',
      observation: healthy(intent()),
      now: NOW,
      pin: PIN,
    });
    expect(expectPlan(plan, 'consume').warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two environments of one project (K21)
// ---------------------------------------------------------------------------

describe('planProxy, two environments of one project (K21)', () => {
  test('production manages with ACME, staging consumes over HTTP: no refusal and no redirect warning', () => {
    expect(consuming(HTTP, healthy(intent()))).toEqual({ kind: 'consume', reasons: [], warnings: [], applyCrds: false, recoverTo: null, adoptState: false });
  });

  test('the reverse assignment refuses the ACME stack with E-PX-INCOMPATIBLE', () => {
    const refusal = expectRefusal(consuming(intent({ email: null }), healthy(HTTP, STAGING), PRODUCTION), 'E-PX-INCOMPATIBLE');
    expect(refusal.message).toBe(
      'Traefik in dockflow-system was installed without ACME by stack shop-staging, so the websecure entry point is not published and the letsencrypt resolver does not exist',
    );
  });

  test('both managing: E-PX-CONFLICT names acme and the stack with proxy.acme: false as the follower', () => {
    const staging = managing(HTTP, healthy(intent()), { me: STAGING, env: 'staging' });
    expect(expectRefusal(staging, 'E-PX-CONFLICT')).toEqual({
      code: 'E-PX-CONFLICT',
      errorCode: ErrorCode.VALIDATION_FAILED,
      message:
        'Traefik in dockflow-system is managed by stack shop-production with different proxy settings (acme, email); one Traefik serves every stack on the cluster',
      suggestion:
        "Use the same `proxy.acme` and `proxy.email` in both stacks, or set `proxy.manage: false` in shop-staging, the stack with `proxy.acme: false`, so it uses the other stack's Traefik without changing it.",
    });
    const production = managing(intent(), healthy(HTTP, STAGING));
    expect(expectRefusal(production, 'E-PX-CONFLICT').suggestion).toBe(
      "Use the same `proxy.acme` and `proxy.email` in both stacks, or set `proxy.manage: false` in shop-staging, the stack with `proxy.acme: false`, so it uses the other stack's Traefik without changing it.",
    );
  });
});

// ---------------------------------------------------------------------------
// Managing rows M1-M9
// ---------------------------------------------------------------------------

function pending(status: 'pending-install' | 'pending-upgrade' | 'pending-rollback', since: string | null, lastDeployedRevision: number | null): ProxyObservation {
  const observation = healthy(intent());
  observation.release = { revision: 4, status, chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: since };
  observation.pendingSince = since;
  observation.lastDeployedRevision = lastDeployedRevision;
  return observation;
}

describe('planProxy, managing stack: pending and uninstalling releases (M1-M4)', () => {
  test('M1: stale pending with a deployed revision -> recover then upgrade', () => {
    expect(managing(intent(), pending('pending-upgrade', ago(STALE_S + 1), 3))).toEqual({
      kind: 'upgrade',
      reasons: ['recovering from an interrupted upgrade'],
      warnings: [],
      applyCrds: false,
      recoverTo: 3,
      adoptState: false,
    });
  });

  test('M2: stale pending-install without a deployed revision -> E-PX-PENDING-INSTALL naming the uninstall', () => {
    const since = ago(STALE_S + 1);
    expect(managing(intent(), pending('pending-install', since, null))).toEqual({
      kind: 'refuse',
      warnings: [],
      refusal: {
        code: 'E-PX-PENDING-INSTALL',
        errorCode: ErrorCode.DEPLOY_FAILED,
        message: `Traefik in dockflow-system has been stuck in pending-install since ${since} with no deployed revision to return to, so the interrupted operation will never finish`,
        suggestion:
          'Remove the unfinished release with `dockflow helm uninstall production --system --force -y`, then deploy again; no route or certificate is lost, because the ACME volume is kept.',
      },
    });
    // a pending-upgrade whose only earlier revision failed is the same dead end
    const upgrade = expectRefusal(managing(intent(), pending('pending-upgrade', since, null)), 'E-PX-PENDING-INSTALL');
    expect(upgrade.message).toContain('stuck in pending-upgrade');
  });

  test('M3: a fresh pending release -> E-PX-PENDING naming status and rollback', () => {
    const since = ago(120);
    expect(expectRefusal(managing(intent(), pending('pending-upgrade', since, 3)), 'E-PX-PENDING')).toEqual({
      code: 'E-PX-PENDING',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: `Traefik in dockflow-system has a Helm operation in progress since ${since} (pending-upgrade)`,
      suggestion:
        'Wait for it to finish and inspect it with `dockflow helm status production --system`; if nothing is running, return to the last good revision with `dockflow helm rollback production --system 3`.',
    });
    expect(expectRefusal(managing(intent(), pending('pending-install', since, null)), 'E-PX-PENDING').suggestion).toBe(
      'Wait for it to finish and inspect it with `dockflow helm status production --system`; if nothing is running, return to the last good revision with `dockflow helm rollback production --system <revision>`.',
    );
  });

  test('staleness boundary at 2 640 s', () => {
    expect(STALE_S).toBe(2640);
    expectRefusal(managing(intent(), pending('pending-rollback', ago(2640), 3)), 'E-PX-PENDING');
    expect(expectPlan(managing(intent(), pending('pending-rollback', ago(2641), 3)), 'upgrade').recoverTo).toBe(3);
    expectRefusal(managing(intent(), pending('pending-upgrade', 'yesterday', 3)), 'E-PX-PENDING');
  });

  test('M4: uninstalling -> E-PX-UNINSTALLING', () => {
    const observation = healthy(intent());
    observation.release = { revision: 3, status: 'uninstalling', chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: ago(10) };
    expect(expectRefusal(managing(intent(), observation), 'E-PX-UNINSTALLING')).toEqual({
      code: 'E-PX-UNINSTALLING',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: 'Traefik in dockflow-system is being uninstalled',
      suggestion: 'Wait for the uninstall to finish, then deploy again.',
    });
  });
});

describe('planProxy, managing stack: never downgrade (M5)', () => {
  test('a newer chart -> keep-newer with W-PX-NEWER', () => {
    const observation = healthy(intent());
    observation.release = { revision: 9, status: 'deployed', chartVersion: '42.1.0', appVersion: 'v3.8.0', updated: ago(10) };
    expect(managing(intent(), observation)).toEqual({
      kind: 'keep-newer',
      reasons: ['chart 42.1.0 is newer than this Dockflow release'],
      warnings: [
        {
          code: 'W-PX-NEWER',
          message: 'Traefik chart 42.1.0 in dockflow-system is newer than this Dockflow release (41.6.0), so the proxy is left unchanged',
          suggestion: 'Upgrade the Dockflow CLI used for shop-production.',
        },
      ],
      applyCrds: false,
      recoverTo: null,
      adoptState: false,
    });
  });

  test('same chart with a newer values revision label -> keep-newer', () => {
    const plan = expectPlan(managing(intent(), { ...healthy(HTTP), deployedValuesNewer: true }), 'keep-newer');
    expect(plan.warnings[0].message).toBe(
      'Traefik chart 41.6.0 with a newer values revision in dockflow-system is newer than this Dockflow release (41.6.0 with values revision 3), so the proxy is left unchanged',
    );
  });

  test('label missing and the ConfigMap records a newer values revision -> keep-newer', () => {
    const observation = { ...healthy(HTTP), revisionLabelMissing: true };
    observation.state = { ...(observation.state as ProxyState), valuesRevision: 4 };
    const plan = expectPlan(managing(intent(), observation), 'keep-newer');
    expect(plan.warnings[0].message).toContain('41.6.0 with values revision 4');
  });

  test('a newer ConfigMap schema -> keep-newer, with W-PX-NOT-READY when the pod is not ready', () => {
    const observation = { ...healthy(HTTP), deployment: { replicas: 1, readyReplicas: 0 } };
    observation.state = { ...(observation.state as ProxyState), schema: 3 };
    const plan = expectPlan(managing(intent(), observation), 'keep-newer');
    expect(codes(plan.warnings)).toEqual(['W-PX-NEWER', 'W-PX-NOT-READY']);
    expect(plan.warnings[0].message).toContain('with state schema 3');
  });
});

describe('planProxy, managing stack: unchanged and adoption of state (M6)', () => {
  test('identical -> unchanged, no Helm call, no warning', () => {
    expect(managing(intent(), healthy(intent()))).toEqual({ kind: 'unchanged', reasons: [], warnings: [], applyCrds: false, recoverTo: null, adoptState: false });
  });

  test('identical + not ready -> unchanged with W-PX-NOT-READY', () => {
    const observation = { ...healthy(intent()), deployment: { replicas: 1, readyReplicas: 0 } };
    observation.pods = [{ name: 'dockflow-traefik-abc', node: 'main', phase: 'Pending', ready: false, status: 'Pending' }];
    expect(expectPlan(managing(intent(), observation), 'unchanged').warnings).toEqual([
      {
        code: 'W-PX-NOT-READY',
        message: 'Traefik in dockflow-system is not ready (Pending), so routes do not serve traffic until it recovers',
        suggestion: 'Run `dockflow diagnose production`.',
      },
    ]);
  });

  test('identical + no ConfigMap -> unchanged, state adopted silently', () => {
    const plan = expectPlan(managing(intent(), { ...healthy(intent()), state: null }), 'unchanged');
    expect(plan.adoptState).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  test('identical + owner namespace gone -> unchanged, state adopted with W-PX-TAKEOVER', () => {
    const plan = expectPlan(managing(intent(), { ...healthy(intent(), WIKI), ownerNamespaceExists: false }), 'unchanged');
    expect(plan.adoptState).toBe(true);
    expect(plan.warnings).toEqual([
      {
        code: 'W-PX-TAKEOVER',
        message: 'Traefik in dockflow-system was managed by stack wiki-production, which no longer exists, so shop-production manages it from now on',
      },
    ]);
  });

  test('identical to what a live other stack manages -> unchanged, ownership kept by the first owner', () => {
    expect(managing(intent(), healthy(intent(), WIKI))).toEqual({ kind: 'unchanged', reasons: [], warnings: [], applyCrds: false, recoverTo: null, adoptState: false });
  });

  test('identical + CRDs missing -> crds-only', () => {
    expect(managing(intent(), { ...healthy(intent()), crdsPresent: false })).toEqual({
      kind: 'crds-only',
      reasons: ['traefik.io CRDs missing'],
      warnings: [],
      applyCrds: true,
      recoverTo: null,
      adoptState: false,
    });
  });
});

describe('planProxy, managing stack: conflicts, install and upgrades (M7-M9)', () => {
  test('M7: values differ and a live other owner has another intent -> E-PX-CONFLICT naming fields, never values', () => {
    const mine = intent({ email: 'admin@example.com', dashboard: { enabled: true, domain: 'traefik.example.com' } });
    const refusal = expectRefusal(managing(mine, healthy(intent(), WIKI)), 'E-PX-CONFLICT');
    expect(refusal).toEqual({
      code: 'E-PX-CONFLICT',
      errorCode: ErrorCode.VALIDATION_FAILED,
      message:
        'Traefik in dockflow-system is managed by stack wiki-production with different proxy settings (email, dashboard); one Traefik serves every stack on the cluster',
      suggestion:
        "Use the same `proxy.email` and `proxy.dashboard` in both stacks, or set `proxy.manage: false` in the stack that should follow so it uses the other stack's Traefik without changing it.",
    });
    const text = `${refusal.message} ${refusal.suggestion}`;
    expect(text).not.toContain('admin@example.com');
    expect(text).not.toContain('ops@example.com');
    expect(text).not.toContain('traefik.example.com');
  });

  test('M7 also refuses before an install when the recorded owner is alive', () => {
    const observation = { ...ABSENT, state: stateFor(WIKI, intent()), ownerNamespaceExists: true };
    expectRefusal(managing(intent({ email: 'admin@example.com' }), observation), 'E-PX-CONFLICT');
  });

  test('values differ, live other owner, same intent (values revision bump) -> upgrade, owner kept', () => {
    const observation = healthy(intent(), WIKI);
    observation.deployedValues = { ...desiredFor(intent()), resources: {} };
    observation.state = { ...(observation.state as ProxyState), valuesRevision: 2 };
    expect(managing(intent(), observation)).toEqual({
      kind: 'upgrade',
      reasons: ['values revision 2 -> 3'],
      warnings: [],
      applyCrds: false,
      recoverTo: null,
      adoptState: false,
    });
  });

  test('values differ and the owner namespace is gone -> upgrade with W-PX-TAKEOVER', () => {
    const observation = { ...healthy(intent(), WIKI), ownerNamespaceExists: false };
    const plan = expectPlan(managing(intent({ email: 'admin@example.com' }), observation), 'upgrade');
    expect(plan.reasons).toEqual(['settings changed (email)']);
    expect(plan.adoptState).toBe(true);
    expect(codes(plan.warnings)).toEqual(['W-PX-TAKEOVER']);
  });

  test('M8: not installed -> install with CRDs and W-PX-FIREWALL', () => {
    expect(managing(intent(), ABSENT)).toEqual({
      kind: 'install',
      reasons: ['not installed'],
      warnings: [
        {
          code: 'W-PX-FIREWALL',
          message: 'Ports 80 and 443 have to be open on main for Traefik to answer',
          suggestion: FIREWALL_SUGGESTION,
        },
      ],
      applyCrds: true,
      recoverTo: null,
      adoptState: true,
    });
    const http = expectPlan(managing(HTTP, { ...ABSENT, crdsPresent: true }), 'install');
    expect(http.warnings[0].message).toBe('Port 80 has to be open on main for Traefik to answer');
    // an uninstalled release with kept history is an install too
    const uninstalled = { ...ABSENT, release: { revision: 2, status: 'uninstalled' as const, chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: null } };
    expectPlan(managing(intent(), uninstalled), 'install');
  });

  test('no ConfigMap and no values-revision label is revision 1', () => {
    const observation = { ...healthy(HTTP), state: null, revisionLabelMissing: true };
    observation.deployedValues = { ...desiredFor(intent()), global: {} };
    const plan = expectPlan(managing(intent(), observation), 'upgrade');
    expect(plan.reasons).toEqual(['values revision 1 -> 3']);
    expect(plan.adoptState).toBe(true);
  });

  test('M9 reasons: failed release, missing Deployment, scaled to 0, older chart', () => {
    const failed = healthy(intent());
    failed.release = { revision: 4, status: 'failed', chartVersion: '41.6.0', appVersion: 'v3.7.13', updated: ago(60) };
    expect(expectPlan(managing(intent(), failed), 'upgrade').reasons).toEqual(['release status failed']);

    expect(expectPlan(managing(intent(), { ...healthy(intent()), deployment: null, pods: [] }), 'upgrade').reasons).toEqual(['deployment missing']);

    const scaled = { ...healthy(intent()), deployment: { replicas: 0, readyReplicas: 0 }, pods: [] };
    expect(managing(intent(), scaled)).toEqual({
      kind: 'upgrade',
      reasons: ['deployment scaled to 0'],
      warnings: [],
      applyCrds: false,
      recoverTo: null,
      adoptState: false,
    });

    const older = healthy(intent());
    older.release = { revision: 2, status: 'deployed', chartVersion: '40.0.0', appVersion: 'v3.5.0', updated: ago(60) };
    const plan = expectPlan(managing(intent(), older), 'upgrade');
    expect(plan.reasons).toEqual(['chart 40.0.0 -> 41.6.0']);
    expect(plan.applyCrds).toBe(true);

    const noCrds = expectPlan(managing(intent(), { ...failed, crdsPresent: false }), 'upgrade');
    expect(noCrds.applyCrds).toBe(true);
  });

  test('M9: a pod running off its pinned node is moved back with W-PX-NODE-DRIFT and W-PX-FIREWALL', () => {
    const observation = healthy(intent());
    observation.pods = [{ name: 'dockflow-traefik-abc', node: 'server-2', phase: 'Running', ready: true, status: 'Running' }];
    expect(managing(intent(), observation)).toEqual({
      kind: 'upgrade',
      reasons: ['running on server-2, pinned to main'],
      warnings: [
        {
          code: 'W-PX-NODE-DRIFT',
          message: 'Traefik runs on server-2 but is pinned to main, so it is moved back to main',
          suggestion: 'Check who edited Deployment dockflow-traefik; DNS for this environment must point at main.',
        },
        { code: 'W-PX-FIREWALL', message: 'Ports 80 and 443 have to be open on main for Traefik to answer', suggestion: FIREWALL_SUGGESTION },
      ],
      applyCrds: false,
      recoverTo: null,
      adoptState: false,
    });
  });

  test('M9: a node move and turning ACME on are the upgrades that print W-PX-FIREWALL', () => {
    const moved = healthy(intent());
    moved.state = stateFor(PRODUCTION, intent(), 'server-2');
    moved.deployedValues = desiredFor(intent(), 'server-2');
    moved.pods = [];
    const plan = expectPlan(managing(intent(), moved), 'upgrade');
    expect(plan.reasons).toEqual(['node server-2 -> main']);
    expect(plan.warnings).toEqual([{ code: 'W-PX-FIREWALL', message: 'Ports 80 and 443 have to be open on main for Traefik to answer', suggestion: FIREWALL_SUGGESTION }]);

    const acmeOn = expectPlan(managing(intent(), healthy(HTTP)), 'upgrade');
    expect(acmeOn.reasons).toEqual(['settings changed (acme, email)']);
    expect(acmeOn.warnings).toEqual([{ code: 'W-PX-FIREWALL', message: 'Port 443 has to be open on main for Traefik to answer', suggestion: FIREWALL_SUGGESTION }]);

    const acmeOff = expectPlan(managing(HTTP, healthy(intent())), 'upgrade');
    expect(acmeOff.warnings).toEqual([]);
  });

  test('M9: reasons of a settings change, and a values change nothing else explains', () => {
    const dashboard = intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } });
    expect(expectPlan(managing(dashboard, healthy(intent())), 'upgrade').reasons).toEqual(['settings changed (dashboard)']);
    const edited = healthy(intent());
    edited.deployedValues = { ...desiredFor(intent()), replicas: 2 };
    expect(expectPlan(managing(intent(), edited), 'upgrade').reasons).toEqual(['values changed']);
  });

  test('placement warnings are prepended to the plan warnings, refusals included', () => {
    const moved: ProxyWarning = { code: 'W-PX-NODE-MOVED', message: 'Traefik moves from old to main', suggestion: 'Point DNS at main.' };
    const plan = managing(intent(), ABSENT, { placement: { hostname: 'main', warnings: [moved] } });
    expect(codes(plan.warnings)).toEqual(['W-PX-NODE-MOVED', 'W-PX-FIREWALL']);
    const refused = managing(intent(), pending('pending-upgrade', ago(10), 3), { placement: { hostname: 'main', warnings: [moved] } });
    expect(refused.kind).toBe('refuse');
    expect(codes(refused.warnings)).toEqual(['W-PX-NODE-MOVED']);
  });

  test('a managing plan needs desired values and a placement', () => {
    expect(() => managing(intent(), ABSENT, { desired: null })).toThrow('planProxy needs the desired values and placement of a managing stack');
    expect(() => managing(intent(), ABSENT, { placement: null })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Port conflicts and scheduling (2.10)
// ---------------------------------------------------------------------------

function pod(namespace: string, name: string, nodeName: string | undefined, ports: { hostPort?: number; protocol?: 'TCP' | 'UDP' }[], extra: Partial<Pod> = {}): Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, ...(extra.metadata ?? {}) },
    spec: {
      ...(nodeName ? { nodeName } : {}),
      containers: [{ name: 'c', image: 'registry.example.com/app:1', ports: ports.map((port) => ({ containerPort: port.hostPort ?? 8080, protocol: port.protocol ?? 'TCP', ...port })) }],
    },
    status: extra.status ?? { phase: 'Running' },
  };
}

describe('port conflicts (2.10)', () => {
  test('hostPortRefusals: one E-PX-HOSTPORT per proxy port with a listener', () => {
    const listeners = [
      { port: 8080, local: '127.0.0.1:8080' },
      { port: 80, local: '0.0.0.0:80' },
      { port: 80, local: '[::]:80' },
      { port: 443, local: '*:443' },
    ];
    expect(hostPortRefusals(listeners, [80], 'main')).toEqual([
      {
        code: 'E-PX-HOSTPORT',
        errorCode: ErrorCode.DEPLOY_FAILED,
        message: "Port 80 on main is used by a host process (0.0.0.0:80), and Dockflow's Traefik publishes ports 80 and 443 on that node, so it would take its traffic",
        suggestion: 'Stop that service (the host nginx of the nginx plugin, for example), or set `proxy.enabled: false` for this environment.',
      },
    ]);
    expect(hostPortRefusals(listeners, [443, 80], 'main').map((refusal) => refusal.message.slice(0, 16))).toEqual(['Port 80 on main ', 'Port 443 on main']);
    expect(hostPortRefusals([{ port: 8080, local: '127.0.0.1:8080' }], [80, 443], 'main')).toEqual([]);
  });

  test('podPortConflicts: other pods publishing 80/443 as TCP hostPorts, Traefik and finished pods excluded', () => {
    const pods: Pod[] = [
      pod('kube-system', 'svclb-web-lb-x1', 'server-2', [{ hostPort: 443 }, { hostPort: 80 }]),
      pod('dockflow-system', 'dockflow-traefik-abc', 'main', [{ hostPort: 80 }], { metadata: { name: 'x', labels: { 'app.kubernetes.io/name': 'traefik' } } }),
      pod('shop', 'quic', 'main', [{ hostPort: 443, protocol: 'UDP' }]),
      pod('shop', 'done', 'main', [{ hostPort: 80 }], { status: { phase: 'Succeeded' } }),
      pod('shop', 'unscheduled', undefined, [{ hostPort: 80 }], { status: { phase: 'Pending' } }),
      pod('shop', 'other-port', 'main', [{ hostPort: 8443 }]),
      pod('shop', 'plain', 'main', [{}]),
      pod('apps', 'legacy-proxy', 'main', [{ hostPort: 80 }]),
    ];
    const conflicts = podPortConflicts(pods, [80, 443]);
    expect(conflicts).toEqual([
      { port: 80, namespace: 'apps', pod: 'legacy-proxy', node: 'main' },
      { port: 80, namespace: 'kube-system', pod: 'svclb-web-lb-x1', node: 'server-2' },
      { port: 443, namespace: 'kube-system', pod: 'svclb-web-lb-x1', node: 'server-2' },
    ]);
    expect(podPortConflicts(pods, [80]).map((conflict) => conflict.port)).toEqual([80, 80]);
    expect(podPortRefusal(conflicts[1])).toEqual({
      code: 'E-PX-PODPORT',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: 'Port 80 is already published by pod kube-system/svclb-web-lb-x1 on server-2',
      suggestion: 'Remove that workload or its published port, then deploy again.',
    });
  });

  test('schedulingFailures keeps the FailedScheduling messages that explain a Pending Traefik', () => {
    const event = (reason: string, message: string): Event => ({ apiVersion: 'v1', kind: 'Event', metadata: { name: `e-${message.length}` }, reason, message });
    const ports = "0/3 nodes are available: 1 node(s) didn't have free ports for the requested pod ports.";
    const affinity = "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.";
    expect(
      schedulingFailures([
        event('FailedScheduling', ports),
        event('FailedScheduling', ports),
        event('FailedScheduling', '0/3 nodes are available: 3 Insufficient memory.'),
        event('Scheduled', affinity),
        event('FailedScheduling', affinity),
      ]),
    ).toEqual([ports, affinity]);
  });

  test('classlessIngressWarning lists at most 5 classless Ingress objects outside stack namespaces', () => {
    const ingress = (namespace: string, name: string, className?: string, annotated = false) => ({
      metadata: { name, namespace, ...(annotated ? { annotations: { 'kubernetes.io/ingress.class': 'nginx' } } : {}) },
      spec: className ? { ingressClassName: className } : {},
    });
    const ingresses = [
      ingress('tools', 'b'),
      ingress('tools', 'a'),
      ingress('ops', 'grafana'),
      ingress('ops', 'prometheus'),
      ingress('ops', 'alerts'),
      ingress('ops', 'loki'),
      ingress('ops', 'classed', 'traefik'),
      ingress('ops', 'legacy', undefined, true),
      ingress('dockflow-shop-production', 'chart-ingress'),
    ];
    expect(classlessIngressWarning(ingresses, new Set(['dockflow-shop-production']))).toEqual({
      code: 'W-PX-CLASSLESS-INGRESS',
      message:
        '`proxy.default_ingress_class` publishes 6 Ingress object(s) that set no ingressClassName on ports 80 and 443: ops/alerts, ops/grafana, ops/loki, ops/prometheus, tools/a, ...',
      suggestion: 'Set `ingressClassName` on those objects, or set `proxy.default_ingress_class: false` and add `ingressClassName: traefik` where routing is wanted.',
    });
    expect(classlessIngressWarning([ingress('ops', 'classed', 'traefik')], new Set())).toBeNull();
  });
});
