// design-03 5.4.4 (K43), design-07 U-APPLY-09 (pure part): an existing Job is never re-applied, a
// failed one is deleted and run again, a running one is left alone and not waited on.

import { describe, expect, it } from 'bun:test';
import { dropUnchangedJobs, planJobRecreations, runningJobs } from '../../../services/orchestrator/kubernetes/apply/pre-apply';
import { diffSnapshots, type LiveWorkload, type Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const JOB = 'migrate-3f9a1c2e';

function job(name: string, service = 'migrate'): Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NS, annotations: { [`${P}/compose-service`]: service } },
    spec: {
      backoffLimit: 6,
      completions: 1,
      parallelism: 1,
      template: { metadata: {}, spec: { restartPolicy: 'Never', containers: [{ name: service, image: 'registry.example.com/app:2' }] } },
    },
  };
}

function web(): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: NS, annotations: { [`${P}/compose-service`]: 'web' } },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'web', image: 'registry.example.com/web:2' }] } } },
  };
}

function liveJob(name: string, state: LiveWorkload['job']): LiveWorkload {
  return {
    kind: 'Job',
    name,
    service: 'migrate',
    uid: `uid-${name}`,
    generation: 1,
    replicas: null,
    revision: null,
    pendingRevision: null,
    revisionNumber: null,
    graceSeconds: 30,
    paused: false,
    deleting: false,
    job: state,
    claimTemplates: [],
    refs: { secrets: [], configMaps: [], claims: [], images: [] },
  };
}

const snapshot = (...workloads: LiveWorkload[]): Snapshot => ({ takenAt: new Date(0), workloads, services: [] });

/** The pre-apply steps of deploy() for Jobs, in their order (design-03 5.1). */
function prepare(applied: ManifestObject[], before: Snapshot) {
  const recreate = planJobRecreations(applied, before);
  return { recreate, toApply: dropUnchangedJobs(applied, before, recreate), running: runningJobs(applied, before) };
}

const names = (objects: ManifestObject[]) => objects.map((o) => `${o.kind}/${o.metadata.name}`);

describe('Jobs under server-side apply (K43)', () => {
  it('absent: applied, not recreated, not reported as running', () => {
    const { recreate, toApply, running } = prepare([web(), job(JOB)], snapshot());
    expect(names(toApply)).toEqual(['Deployment/web', `Job/${JOB}`]);
    expect(recreate).toEqual([]);
    expect(running).toEqual([]);
  });

  it('Complete=True: dropped from the apply and not waited on', () => {
    const before = snapshot(liveJob(JOB, { finished: 'complete', active: 0 }));
    const { recreate, toApply, running } = prepare([web(), job(JOB)], before);
    expect(names(toApply)).toEqual(['Deployment/web']);
    expect(recreate).toEqual([]);
    expect(running).toEqual([]);
  });

  it('Failed=True: deleted and applied again, then reported as created so it is waited on', () => {
    const before = snapshot(liveJob(JOB, { finished: 'failed', active: 0 }));
    const { recreate, toApply } = prepare([web(), job(JOB)], before);
    expect(recreate).toEqual([{ kind: 'Job', name: JOB, service: 'migrate' }]);
    expect(names(toApply)).toEqual(['Deployment/web', `Job/${JOB}`]);
    const after = snapshot(liveJob(JOB, { finished: null, active: 1 }));
    expect(diffSnapshots(before, after, toApply, recreate)).toEqual([
      {
        service: 'migrate',
        kind: 'Job',
        name: JOB,
        created: true,
        previousRevision: null,
        previousRevisionNumber: null,
        previousReplicas: null,
        generation: 1,
      },
    ]);
  });

  it('still active: left alone, not applied, not waited on, and reported for the warning', () => {
    const running = liveJob(JOB, { finished: null, active: 1 });
    const result = prepare([job(JOB)], snapshot(running));
    expect(result.toApply).toEqual([]);
    expect(result.recreate).toEqual([]);
    expect(result.running).toEqual([running]);
  });

  it('a changed spec has another name: the new Job is applied, the old one is left to finalize', () => {
    const before = snapshot(liveJob('migrate-00000000', { finished: 'complete', active: 0 }));
    const { recreate, toApply } = prepare([job(JOB)], before);
    expect(names(toApply)).toEqual([`Job/${JOB}`]);
    expect(recreate).toEqual([]);
  });

  it('a failed Job of another name is not recreated', () => {
    const before = snapshot(liveJob('migrate-00000000', { finished: 'failed', active: 0 }));
    expect(planJobRecreations([job(JOB)], before)).toEqual([]);
  });

  it('passes objects through untouched: no selector and no manualSelector is ever added', () => {
    const applied = [web(), job(JOB)];
    const pristine = structuredClone(applied);
    const toApply = dropUnchangedJobs(applied, snapshot(), []);
    expect(toApply).toEqual(pristine);
    expect(toApply[1]).toBe(applied[1]);
    const spec: object = (toApply[1] as Job).spec;
    expect('selector' in spec).toBe(false);
    expect('manualSelector' in spec).toBe(false);
  });

  it('only Jobs are dropped: a Deployment whose name matches a live Job stays', () => {
    const before = snapshot({ ...liveJob('web', { finished: 'complete', active: 0 }) });
    expect(names(dropUnchangedJobs([web()], before, []))).toEqual(['Deployment/web']);
  });
});
