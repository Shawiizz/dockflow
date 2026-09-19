// translate/namespace.ts (DESIGN-CORE 5.5, C8; design-03 5.2): the stack Namespace, validated with
// support/schema like every builder of an object outside artifacts (PD-11 (e)).

import { describe, expect, test } from 'bun:test';
import { ANNOTATIONS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { namespaceFor } from '../../../services/orchestrator/kubernetes/naming';
import { namespaceObject } from '../../../services/orchestrator/kubernetes/translate/namespace';
import { identity, stackRef } from '../support/builders';
import { failures, formatIssues, validateSemantics } from '../support/schema/semantic';
import { validateObject } from '../support/schema/validate';

const P = 'dockflow.shawiizz.dev';

describe('namespaceObject (DESIGN-CORE 5.5)', () => {
  test('is the object of design-03 5.2, exactly', () => {
    expect(namespaceObject(stackRef())).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'dockflow-shop-production',
        labels: {
          'app.kubernetes.io/instance': 'dockflow-shop-production',
          'app.kubernetes.io/managed-by': 'dockflow',
          'app.kubernetes.io/part-of': 'shop',
          [`${P}/stack`]: 'dockflow-shop-production',
        },
        annotations: { [`${P}/stack-name`]: 'shop-production' },
      },
    });
  });

  test('carries no Pod Security Admission label, no role, no part and no spec (C8)', () => {
    const namespace = namespaceObject(stackRef());
    const labels = Object.keys(namespace.metadata.labels ?? {});
    expect(labels.filter((key) => key.startsWith('pod-security.kubernetes.io/'))).toEqual([]);
    expect(labels).not.toContain(LABELS.role);
    expect(labels).not.toContain(LABELS.part);
    expect(namespace).not.toHaveProperty('spec');
    expect(namespace.metadata).not.toHaveProperty('namespace');
  });

  test('is the same object for both roles and for a StackIdentity', () => {
    const app = namespaceObject(stackRef({ role: 'app' }));
    expect(namespaceObject(stackRef({ role: 'accessory' }))).toEqual(app);
    expect(namespaceObject(identity())).toEqual(app);
  });

  test('a long project gets the hashed namespace name; the stack name annotation stays verbatim', () => {
    const project = `p${'x'.repeat(62)}`;
    const env = `e${'y'.repeat(49)}`;
    const namespace = namespaceObject({ project, env });
    const name = namespaceFor(project, env);
    expect(name.length).toBe(63);
    expect(namespace.metadata.name).toBe(name);
    expect(namespace.metadata.labels?.[LABELS.stack]).toBe(name);
    expect(namespace.metadata.labels?.[LABELS.instance]).toBe(name);
    expect(namespace.metadata.labels?.[LABELS.partOf]).toBe(project);
    expect(namespace.metadata.annotations?.[ANNOTATIONS.stackName]).toBe(`${project}-${env}`);
  });

  test('returns a fresh object on every call', () => {
    const first = namespaceObject(stackRef());
    if (first.metadata.labels) first.metadata.labels.extra = 'x';
    expect(namespaceObject(stackRef()).metadata.labels).not.toHaveProperty('extra');
  });

  test('is valid for the API server (schema, names, labels)', () => {
    for (const ref of [stackRef(), { project: `p${'x'.repeat(62)}`, env: `e${'y'.repeat(49)}` }]) {
      const namespace = namespaceObject(ref);
      expect(validateObject(namespace)).toEqual([]);
      // S20 is the artifact ownership rule; a Namespace is never an artifact object.
      const issues = failures(validateSemantics([namespace], { namespace: namespace.metadata.name, skipRules: ['S20'] }));
      expect(formatIssues(issues)).toBe('');
    }
  });
});
