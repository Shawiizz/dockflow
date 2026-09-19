import { describe, expect, it } from 'bun:test';
import {
  hashedObjectLabels,
  helperPodLabels,
  type LabelMap,
  leaseLabels,
  namespaceLabels,
  podTemplateLabels,
  registrySecretLabels,
  releaseBackupSecretLabels,
  releaseSecretLabels,
  SEL_HASHED,
  SEL_POD,
  SEL_RELEASE,
  SEL_RELEASE_BACKUP,
  SEL_ROLE,
  selectorLabels,
  serviceObjectLabels,
  serviceSelector,
  stackObjectLabels,
  stackSelector,
  stateConfigMapLabels,
  systemObjectLabels,
  volumeClaimLabels,
} from '../../services/orchestrator/kubernetes/labels';
import { isLabelKey, isLabelValue } from '../../services/orchestrator/kubernetes/model/units';
import { releaseSlug } from '../../services/orchestrator/kubernetes/naming';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const id = { project: 'shop', namespace: NS };

/** the rows of DESIGN-CORE 5.2 every object in the stack namespace carries */
const inNamespace = {
  'app.kubernetes.io/managed-by': 'dockflow',
  'app.kubernetes.io/part-of': 'shop',
  'app.kubernetes.io/instance': NS,
  [`${P}/stack`]: NS,
};

function expectValidLabels(labels: LabelMap): void {
  for (const [key, value] of Object.entries(labels)) {
    expect([key, isLabelKey(key)]).toEqual([key, true]);
    expect([value, isLabelValue(value)]).toEqual([value, true]);
  }
}

describe('label builders (U-LABELS-01, DESIGN-CORE 5.2, design-02 1.3)', () => {
  it('namespace: managed-by, part-of, instance and P/stack; no part and no role', () => {
    expect(namespaceLabels(id)).toEqual(inNamespace);
  });

  it('workload, Service of every shape (main, -lb, -hl, alias), IngressRoute', () => {
    const expected = {
      ...inNamespace,
      [`${P}/role`]: 'app',
      [`${P}/part`]: 'stack',
      'app.kubernetes.io/name': 'web',
      [`${P}/service`]: 'web',
    };
    expect(serviceObjectLabels(id, 'app', 'web')).toEqual(expected);
  });

  it('pod template: exactly the selector labels, name, instance, role and pod_labels', () => {
    expect(podTemplateLabels(id, 'accessory', 'db')).toEqual({
      [`${P}/stack`]: NS,
      [`${P}/service`]: 'db',
      'app.kubernetes.io/name': 'db',
      'app.kubernetes.io/instance': NS,
      [`${P}/role`]: 'accessory',
    });
    expect(podTemplateLabels(id, 'app', 'web', { tier: 'frontend' })).toEqual({
      tier: 'frontend',
      [`${P}/stack`]: NS,
      [`${P}/service`]: 'web',
      'app.kubernetes.io/name': 'web',
      'app.kubernetes.io/instance': NS,
      [`${P}/role`]: 'app',
    });
  });

  it('pod template: Dockflow keys win over pod_labels', () => {
    const labels = podTemplateLabels(id, 'app', 'web', { 'app.kubernetes.io/name': 'other', tier: 'x' });
    expect(labels['app.kubernetes.io/name']).toBe('web');
    expect(labels.tier).toBe('x');
  });

  it('pod template carries no release version, managed-by or part (an unchanged service never rolls)', () => {
    const labels = podTemplateLabels(id, 'app', 'web');
    expect(Object.keys(labels).filter((k) => k.includes('release') || k.endsWith('/part') || k.endsWith('managed-by'))).toEqual([]);
  });

  it('env Secret: service labels plus P/hashed', () => {
    expect(hashedObjectLabels(id, 'app', 'web')).toEqual({ ...serviceObjectLabels(id, 'app', 'web'), [`${P}/hashed`]: 'true' });
  });

  it('compose secret Secret and config ConfigMap: stack labels plus P/hashed, no service', () => {
    expect(hashedObjectLabels(id, 'accessory', null)).toEqual({
      ...inNamespace,
      [`${P}/role`]: 'accessory',
      [`${P}/part`]: 'stack',
      [`${P}/hashed`]: 'true',
    });
  });

  it('Middleware and middleware auth Secret: stack labels', () => {
    expect(stackObjectLabels(id, 'app')).toEqual({ ...inNamespace, [`${P}/role`]: 'app', [`${P}/part`]: 'stack' });
  });

  it('PVC and claim template: stack labels plus P/volume; volume labels merge under them', () => {
    expect(volumeClaimLabels(id, 'accessory', 'postgres-data')).toEqual({
      ...inNamespace,
      [`${P}/role`]: 'accessory',
      [`${P}/part`]: 'stack',
      [`${P}/volume`]: 'postgres-data',
    });
    const merged = volumeClaimLabels(id, 'app', 'data', { backup: 'daily', 'app.kubernetes.io/part-of': 'other' });
    expect(merged.backup).toBe('daily');
    expect(merged['app.kubernetes.io/part-of']).toBe('shop');
  });

  it('release Secret: stack namespace labels, P/part=release, P/release-version=releaseSlug(version)', () => {
    expect(releaseSecretLabels(id, '1.4.2')).toEqual({ ...inNamespace, [`${P}/part`]: 'release', [`${P}/release-version`]: '1.4.2' });
    expect(releaseSecretLabels(id, '1.4.2+Build_7')[`${P}/release-version`]).toBe(releaseSlug('1.4.2+Build_7'));
    expect(releaseBackupSecretLabels(id, '1.4.2')).toEqual({
      ...inNamespace,
      [`${P}/part`]: 'release-backup',
      [`${P}/release-version`]: '1.4.2',
    });
  });

  it('state ConfigMap, registry Secret and helper pod', () => {
    expect(stateConfigMapLabels(id)).toEqual({ ...inNamespace, [`${P}/part`]: 'state' });
    expect(registrySecretLabels(id)).toEqual({ ...inNamespace, [`${P}/part`]: 'registry' });
    expect(helperPodLabels(id)).toEqual({ ...inNamespace, [`${P}/part`]: 'helper' });
  });

  it('Lease: managed-by, P/part=system and the stack for a deploy lock; no stack for the proxy lock', () => {
    expect(leaseLabels(NS)).toEqual({ 'app.kubernetes.io/managed-by': 'dockflow', [`${P}/part`]: 'system', [`${P}/stack`]: NS });
    expect(leaseLabels(null)).toEqual({ 'app.kubernetes.io/managed-by': 'dockflow', [`${P}/part`]: 'system' });
    expect(systemObjectLabels()).toEqual({ 'app.kubernetes.io/managed-by': 'dockflow', [`${P}/part`]: 'system' });
  });

  it('selector labels: P/stack and P/service only', () => {
    expect(selectorLabels(id, 'web')).toEqual({ [`${P}/stack`]: NS, [`${P}/service`]: 'web' });
  });

  it('every builder produces valid label keys and values', () => {
    for (const labels of [
      namespaceLabels(id),
      stackObjectLabels(id, 'app'),
      serviceObjectLabels(id, 'app', 'a'.repeat(52)),
      hashedObjectLabels(id, 'app', 'web'),
      volumeClaimLabels(id, 'app', 'd'.repeat(63)),
      podTemplateLabels(id, 'app', 'web', { tier: 'x' }),
      releaseSecretLabels(id, `1.0.0+${'B'.repeat(120)}`),
      releaseBackupSecretLabels(id, '2.0.0'),
      stateConfigMapLabels(id),
      registrySecretLabels(id),
      helperPodLabels(id),
      leaseLabels(NS),
      systemObjectLabels(),
    ]) {
      expectValidLabels(labels);
    }
  });

  it('builders return fresh maps', () => {
    const a = serviceObjectLabels(id, 'app', 'web');
    a.extra = 'x';
    expect(serviceObjectLabels(id, 'app', 'web').extra).toBeUndefined();
  });
});

describe('selector strings (U-LABELS-02, design-03 0)', () => {
  it('whole stack, role scope and one service', () => {
    expect(stackSelector('<id>')).toBe('app.kubernetes.io/managed-by=dockflow,dockflow.shawiizz.dev/stack=<id>');
    expect(SEL_ROLE('<id>', 'app')).toBe(
      'app.kubernetes.io/managed-by=dockflow,dockflow.shawiizz.dev/stack=<id>,dockflow.shawiizz.dev/role=app,dockflow.shawiizz.dev/part=stack',
    );
    expect(serviceSelector('<id>', 'web')).toBe('dockflow.shawiizz.dev/stack=<id>,dockflow.shawiizz.dev/service=web');
  });

  it('SEL_POD: stack and role, optionally a sorted, deduplicated service set (PD-9)', () => {
    expect(SEL_POD(NS, 'app')).toBe(`${P}/stack=${NS},${P}/role=app`);
    expect(SEL_POD(NS, 'accessory', ['redis', 'db', 'redis'])).toBe(`${P}/stack=${NS},${P}/role=accessory,${P}/service in (db,redis)`);
    expect(() => SEL_POD(NS, 'app', [])).toThrow();
  });

  it('SEL_POD matches pod template labels, which carry no managed-by or part', () => {
    const pod = podTemplateLabels(id, 'app', 'web');
    const terms = SEL_POD(NS, 'app', ['web'])
      .replace(/ in \((.*)\)$/, '=$1')
      .split(',')
      .map((term) => term.split('='));
    for (const [key, value] of terms) expect([key, pod[key]]).toEqual([key, value]);
  });

  it('SEL_HASHED, SEL_RELEASE and SEL_RELEASE_BACKUP', () => {
    expect(SEL_HASHED(NS, 'app')).toBe(`${SEL_ROLE(NS, 'app')},${P}/hashed=true`);
    expect(SEL_RELEASE(NS)).toBe(`app.kubernetes.io/managed-by=dockflow,${P}/stack=${NS},${P}/part=release`);
    expect(SEL_RELEASE_BACKUP(NS)).toBe(`app.kubernetes.io/managed-by=dockflow,${P}/stack=${NS},${P}/part=release-backup`);
  });

  it('each selector matches the labels of the objects it is meant for', () => {
    const matches = (selector: string, labels: LabelMap): boolean =>
      selector.split(',').every((term) => {
        const [key, value] = term.split('=');
        return labels[key] === value;
      });
    expect(matches(SEL_ROLE(NS, 'app'), serviceObjectLabels(id, 'app', 'web'))).toBe(true);
    expect(matches(SEL_ROLE(NS, 'app'), serviceObjectLabels(id, 'accessory', 'db'))).toBe(false);
    expect(matches(SEL_ROLE(NS, 'app'), releaseSecretLabels(id, '1.0.0'))).toBe(false);
    expect(matches(SEL_HASHED(NS, 'app'), hashedObjectLabels(id, 'app', 'web'))).toBe(true);
    expect(matches(SEL_HASHED(NS, 'app'), serviceObjectLabels(id, 'app', 'web'))).toBe(false);
    expect(matches(SEL_RELEASE(NS), releaseSecretLabels(id, '1.0.0'))).toBe(true);
    expect(matches(SEL_RELEASE(NS), releaseBackupSecretLabels(id, '1.0.0'))).toBe(false);
    expect(matches(SEL_RELEASE_BACKUP(NS), releaseBackupSecretLabels(id, '1.0.0'))).toBe(true);
    expect(matches(stackSelector(NS), namespaceLabels(id))).toBe(true);
    expect(matches(serviceSelector(NS, 'web'), podTemplateLabels(id, 'app', 'web'))).toBe(true);
  });
});
