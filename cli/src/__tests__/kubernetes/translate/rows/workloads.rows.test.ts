// design-07 5.2 T-STRAT rows (translate/workloads.ts): rollout strategy, timing (PD-5) and the
// per-kind mandatory field set (K30).
//
// T-STRAT-05: design-07's cell names `volumes.rwo-global`, but that code is `checkGlobalService`'s
// (DaemonSet/global mode, `deploy.mode`). A replicated service whose replicas exceed what a shared
// RWO/RWOP claim allows is `checkSharedClaimReplicas`'s `volumes.rwo-replicas`, at
// `deploy.replicas` (design-02 4.2, 11.2, confirmed against the source of translate/workloads.ts).
// This file follows design-02 and asserts `volumes.rwo-replicas` for that case.

import { describe, expect, test } from 'bun:test';
import { expectPointer, jsonPointer } from '../../support/normalize';
import { type TranslateRow, runTranslateRows, translateRow } from '../../support/rows';

const rows: TranslateRow[] = [
  {
    id: 'T-STRAT-01',
    title: 'role app defaults: RollingUpdate 1/0, minReadySeconds 30, progressDeadlineSeconds 240',
    compose: 'image: nginx:1.27',
    expect: [
      { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } } },
      { object: 'Deployment/web', pointer: '/spec/minReadySeconds', equals: 30 },
      { object: 'Deployment/web', pointer: '/spec/progressDeadlineSeconds', equals: 240 },
    ],
  },
  {
    id: 'T-STRAT-02',
    title: 'order: stop-first, parallelism: 2 -> maxSurge 0, maxUnavailable 2',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          order: stop-first
          parallelism: 2
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 2 } } },
  },
  {
    id: 'T-STRAT-03',
    title: 'parallelism: 0 -> "100%" in the moving field',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          parallelism: 0
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/strategy/rollingUpdate/maxSurge', equals: '100%' },
      { object: 'Deployment/web', pointer: '/spec/strategy/rollingUpdate/maxUnavailable', equals: 0 },
    ],
  },
  {
    id: 'T-STRAT-04',
    title: 'mounts a ReadWriteOnce claim -> strategy Recreate, no rollingUpdate key',
    compose: `
      services:
        web:
          image: nginx:1.27
          volumes:
            - data:/var/lib/data
      volumes:
        data: {}
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'Recreate' } },
      { object: 'Deployment/web', pointer: '/spec/strategy/rollingUpdate', absent: true },
    ],
  },
  {
    id: 'T-STRAT-05',
    title: 'replicas: 2 sharing a Dockflow-managed RWO claim -> volumes.rwo-replicas (design-02)',
    compose: `
      services:
        web:
          image: nginx:1.27
          deploy:
            replicas: 2
          volumes:
            - data:/var/lib/data
      volumes:
        data: {}
    `,
    expect: {
      diagnostics: [{ severity: 'error', code: 'volumes.rwo-replicas', path: 'services.web.deploy.replicas' }],
    },
  },
  {
    id: 'T-STRAT-05-external',
    title: 'replicas: 2 sharing an external RWO claim -> the same volumes.rwo-replicas (not about who created it)',
    compose: `
      services:
        web:
          image: nginx:1.27
          deploy:
            replicas: 2
          volumes:
            - data:/var/lib/data
      volumes:
        data:
          external: true
          name: legacy-data
    `,
    expect: {
      diagnostics: [{ severity: 'error', code: 'volumes.rwo-replicas', path: 'services.web.deploy.replicas' }],
    },
  },
  {
    id: 'T-STRAT-05b',
    title: 'replicas: 2 mounting a ReadWriteMany claim -> no diagnostic',
    compose: `
      services:
        web:
          image: nginx:1.27
          deploy:
            replicas: 2
          volumes:
            - data:/var/lib/data
      volumes:
        data:
          x-dockflow:
            access_mode: ReadWriteMany
            storage_class: network-fs
    `,
    expect: { diagnostics: [] },
  },
  {
    id: 'T-STRAT-06',
    title: 'x-dockflow.kind: statefulset + per_replica volume -> StatefulSet with volumeClaimTemplates, no standalone PVC, serviceName web-hl',
    compose: `
      services:
        web:
          image: nginx:1.27
          x-dockflow:
            kind: statefulset
          deploy:
            replicas: 2
          volumes:
            - data:/var/lib/data
      volumes:
        data:
          x-dockflow:
            per_replica: true
    `,
    expect: [
      { object: 'StatefulSet/web', pointer: '/spec/serviceName', equals: 'web-hl' },
      { object: 'StatefulSet/web', pointer: '/spec/volumeClaimTemplates/0/metadata/name', equals: 'data' },
      { object: 'PersistentVolumeClaim/data', absent: true },
      { object: 'Service/web-hl', pointer: '/spec/clusterIP', equals: 'None' },
    ],
  },
  {
    id: 'T-STRAT-07',
    title: 'a hostPort binding forces stop-first although update_config.order is start-first (the default) -> info, not Recreate',
    compose: `
      services:
        web:
          image: nginx:1.27
          ports:
            - target: 80
              published: 8080
              mode: host
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } } },
      {
        diagnostics: [{ severity: 'info', code: 'update.surge-disabled', path: 'services.web.deploy.update_config.order' }],
      },
    ],
  },
  {
    id: 'T-STRAT-08a',
    title: 'update_config.monitor: 90s -> minReadySeconds 90, progressDeadlineSeconds 240 (floor)',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          monitor: 90s
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/minReadySeconds', equals: 90 },
      { object: 'Deployment/web', pointer: '/spec/progressDeadlineSeconds', equals: 240 },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'T-STRAT-08b',
    title: 'update_config.monitor: 200s -> minReadySeconds 200, progressDeadlineSeconds 260 (raised)',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          monitor: 200s
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/minReadySeconds', equals: 200 },
      { object: 'Deployment/web', pointer: '/spec/progressDeadlineSeconds', equals: 260 },
    ],
  },
  {
    id: 'T-STRAT-08c',
    title: 'update_config.monitor: 250s -> render error update.monitor-too-long (PD-5, over MAX_MIN_READY_S)',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          monitor: 250s
    `,
    expect: {
      diagnostics: [{ severity: 'error', code: 'update.monitor-too-long', path: 'services.web.deploy.update_config.monitor' }],
    },
  },
  {
    id: 'T-STRAT-08d',
    title: 'update_config.monitor: 10m -> render error update.monitor-too-long',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          monitor: 10m
    `,
    expect: {
      diagnostics: [{ severity: 'error', code: 'update.monitor-too-long', path: 'services.web.deploy.update_config.monitor' }],
    },
  },
  {
    id: 'T-STRAT-09a',
    title: 'revisionHistoryLimit follows TranslateOptions verbatim (keep_releases 1 -> 2 is render.ts\'s clamp, not the translator\'s)',
    compose: 'image: nginx:1.27',
    options: { revisionHistoryLimit: 2 },
    expect: { object: 'Deployment/web', pointer: '/spec/revisionHistoryLimit', equals: 2 },
  },
  {
    id: 'T-STRAT-09b',
    title: 'revisionHistoryLimit 5',
    compose: 'image: nginx:1.27',
    options: { revisionHistoryLimit: 5 },
    expect: { object: 'Deployment/web', pointer: '/spec/revisionHistoryLimit', equals: 5 },
  },
  {
    id: 'T-STRAT-10',
    title: 'deploy.mode: global -> DaemonSet, no replicas, RollingUpdate 1/0',
    compose: `
      image: nginx:1.27
      deploy:
        mode: global
    `,
    expect: [
      { kinds: ['DaemonSet/web', 'Service/web'] },
      { object: 'DaemonSet/web', pointer: '/spec/replicas', absent: true },
      { object: 'DaemonSet/web', pointer: '/spec/updateStrategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } } },
    ],
  },
  {
    id: 'T-STRAT-12a',
    title: 'failure_action: pause does not change the rollout strategy',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          failure_action: pause
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } } },
  },
  {
    id: 'T-STRAT-12b',
    title: 'failure_action: continue does not change the rollout strategy',
    compose: `
      image: nginx:1.27
      deploy:
        update_config:
          failure_action: continue
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/strategy', equals: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } } },
  },
  {
    id: 'T-STRAT-14-deployment',
    title: 'Deployment mandatory fields: replicas, revisionHistoryLimit, progressDeadlineSeconds, strategy; minReadySeconds present',
    compose: 'image: nginx:1.27',
    expect: [
      { object: 'Deployment/web', pointer: '/spec/replicas', equals: 1 },
      { object: 'Deployment/web', pointer: '/spec/revisionHistoryLimit', equals: 3 },
      { object: 'Deployment/web', pointer: '/spec/progressDeadlineSeconds', equals: 240 },
      { object: 'Deployment/web', pointer: '/spec/minReadySeconds', equals: 30 },
      { object: 'Deployment/web', pointer: '/spec/persistentVolumeClaimRetentionPolicy', absent: true },
      { object: 'Deployment/web', pointer: '/spec/updateStrategy', absent: true },
    ],
  },
  {
    id: 'T-STRAT-14-statefulset',
    title: 'StatefulSet mandatory fields: replicas, revisionHistoryLimit, updateStrategy, persistentVolumeClaimRetentionPolicy; no progressDeadlineSeconds',
    compose: `
      image: nginx:1.27
      x-dockflow:
        kind: statefulset
    `,
    expect: [
      { object: 'StatefulSet/web', pointer: '/spec/replicas', equals: 1 },
      { object: 'StatefulSet/web', pointer: '/spec/revisionHistoryLimit', equals: 3 },
      { object: 'StatefulSet/web', pointer: '/spec/updateStrategy', equals: { type: 'RollingUpdate' } },
      { object: 'StatefulSet/web', pointer: '/spec/persistentVolumeClaimRetentionPolicy', equals: { whenDeleted: 'Retain', whenScaled: 'Retain' } },
      { object: 'StatefulSet/web', pointer: '/spec/minReadySeconds', equals: 30 },
      { object: 'StatefulSet/web', pointer: '/spec/progressDeadlineSeconds', absent: true },
    ],
  },
  {
    id: 'T-STRAT-14-daemonset',
    title: 'DaemonSet mandatory fields: revisionHistoryLimit, updateStrategy; no replicas, no progressDeadlineSeconds',
    compose: `
      image: nginx:1.27
      deploy:
        mode: global
    `,
    expect: [
      { object: 'DaemonSet/web', pointer: '/spec/revisionHistoryLimit', equals: 3 },
      { object: 'DaemonSet/web', pointer: '/spec/replicas', absent: true },
      { object: 'DaemonSet/web', pointer: '/spec/progressDeadlineSeconds', absent: true },
      { object: 'DaemonSet/web', pointer: '/spec/minReadySeconds', equals: 30 },
    ],
  },
];

runTranslateRows('translate/workloads (T-STRAT)', rows);

// ---------------------------------------------------------------------------
// Job rows (T-STRAT-11, T-STRAT-13): the Job's name carries a content checksum, so it is looked up
// by kind rather than asserted through runTranslateRows' exact object key.
// ---------------------------------------------------------------------------

describe('translate/workloads Job rows (T-STRAT-11, T-STRAT-13)', () => {
  function jobOf(restart: string | undefined) {
    const restartLine = restart === undefined ? '' : `\n        restart: ${restart}`;
    const { objects } = translateRow({
      id: `job-${restart ?? 'absent'}`,
      title: 'job',
      compose: `
        image: nginx:1.27${restartLine}
        deploy:
          mode: replicated-job
      `,
      expect: [],
    });
    const job = objects.find((o) => o.kind === 'Job');
    if (job === undefined) throw new Error('no Job object was produced');
    return job;
  }

  test('T-STRAT-11 restart: "no" -> restartPolicy Never, backoffLimit 0', () => {
    const job = jobOf('"no"');
    expectPointer(job, '/spec/template/spec/restartPolicy', { equals: 'Never' }, 'Job');
    expectPointer(job, '/spec/backoffLimit', { equals: 0 }, 'Job');
  });

  test('T-STRAT-11 restart: on-failure -> restartPolicy Never, backoffLimit not 0', () => {
    const job = jobOf('on-failure');
    expectPointer(job, '/spec/template/spec/restartPolicy', { equals: 'Never' }, 'Job');
    expect(jsonPointer(job, '/spec/backoffLimit').value).not.toBe(0);
  });

  test('T-STRAT-11 restart absent -> restartPolicy Never, backoffLimit not 0', () => {
    const job = jobOf(undefined);
    expectPointer(job, '/spec/template/spec/restartPolicy', { equals: 'Never' }, 'Job');
    expect(jsonPointer(job, '/spec/backoffLimit').value).not.toBe(0);
  });

  test('T-STRAT-13 a Job carries no selector, manualSelector or controller-uid pod label', () => {
    const job = jobOf(undefined);
    expectPointer(job, '/spec/selector', { absent: true }, 'Job');
    expectPointer(job, '/spec/manualSelector', { absent: true }, 'Job');
    expectPointer(job, '/spec/template/metadata/labels/controller-uid', { absent: true }, 'Job');
    expectPointer(job, '/spec/template/metadata/labels/batch.kubernetes.io~1controller-uid', { absent: true }, 'Job');
  });

  test('T-STRAT-14 Job mandatory fields: none of replicas, revisionHistoryLimit, progressDeadlineSeconds, minReadySeconds', () => {
    const job = jobOf(undefined);
    expectPointer(job, '/spec/replicas', { absent: true }, 'Job');
    expectPointer(job, '/spec/revisionHistoryLimit', { absent: true }, 'Job');
    expectPointer(job, '/spec/progressDeadlineSeconds', { absent: true }, 'Job');
    expectPointer(job, '/spec/minReadySeconds', { absent: true }, 'Job');
  });
});
