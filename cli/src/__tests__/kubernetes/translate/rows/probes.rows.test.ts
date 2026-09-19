// design-07 5.2 T-PROBE rows (translate/probes.ts, formula owned by S1): which of startup, readiness
// and liveness a service gets, their handler and their whole-second timings.

import { expect, test } from 'bun:test';
import { k8sExpand } from '../../support/k8s-expand';
import { jsonPointer } from '../../support/normalize';
import { type TranslateRow, runTranslateRows, translateRow } from '../../support/rows';

const CONTAINER_PROBE = '/spec/template/spec/containers/0';

const rows: TranslateRow[] = [
  {
    id: 'T-PROBE-01',
    title: 'exec test with Docker default timings -> readiness/liveness, no startup',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","wget","-qO-","http://127.0.0.1/"]
    `,
    expect: [
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/readinessProbe`,
        equals: {
          exec: { command: ['wget', '-qO-', 'http://127.0.0.1/'] },
          failureThreshold: 3,
          initialDelaySeconds: 0,
          periodSeconds: 30,
          successThreshold: 1,
          timeoutSeconds: 30,
        },
      },
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/livenessProbe`,
        equals: {
          exec: { command: ['wget', '-qO-', 'http://127.0.0.1/'] },
          failureThreshold: 3,
          initialDelaySeconds: 30,
          periodSeconds: 30,
          successThreshold: 1,
          timeoutSeconds: 30,
        },
      },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-02',
    title: 'interval 30s, retries 3, start_period 60s, start_interval 5s -> startup failureThreshold ceil((60+3*30)/5)=30',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 30s
        retries: 3
        start_period: 60s
        start_interval: 5s
    `,
    expect: [
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/startupProbe`,
        equals: { exec: { command: ['true'] }, periodSeconds: 5, timeoutSeconds: 30, failureThreshold: 30, successThreshold: 1, initialDelaySeconds: 0 },
      },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe/initialDelaySeconds`, equals: 0 },
    ],
  },
  {
    id: 'T-PROBE-03',
    title: 'interval 2500ms, timeout 500ms -> periodSeconds 3, timeoutSeconds 1 (ceil to whole seconds)',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 2500ms
        timeout: 500ms
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/periodSeconds`, equals: 3 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/timeoutSeconds`, equals: 1 },
    ],
  },
  {
    id: 'T-PROBE-03b',
    title: 'the whole-seconds startup formula (design-02 5.6): interval 1500ms, timeout 900ms, start_period 500ms, retries 3 -> failureThreshold 2',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 1500ms
        timeout: 900ms
        start_period: 500ms
        retries: 3
    `,
    expect: {
      object: 'Deployment/web',
      pointer: `${CONTAINER_PROBE}/startupProbe`,
      equals: { exec: { command: ['true'] }, periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 2, successThreshold: 1, initialDelaySeconds: 0 },
    },
  },
  {
    id: 'T-PROBE-03b-start-interval',
    title: 'the same input with start_interval 1200ms (SI=2) -> failureThreshold ceil(7/2)=4, not 5 (the millisecond formula would give)',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 1500ms
        timeout: 900ms
        start_period: 500ms
        retries: 3
        start_interval: 1200ms
    `,
    expect: { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe/failureThreshold`, equals: 4 },
  },
  {
    id: 'T-PROBE-03c-readiness',
    title: 'sub-second timings, x-dockflow.probes.use: readiness -> readiness only, no startup although start_period is written',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        start_period: 500ms
      x-dockflow:
        probes:
          use: readiness
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/periodSeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-03c-liveness',
    title: 'sub-second timings, x-dockflow.probes.use: liveness -> liveness plus the startup probe',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        start_period: 500ms
      x-dockflow:
        probes:
          use: liveness
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe/periodSeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe/periodSeconds`, equals: 5 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-03c-none',
    title: 'sub-second timings, x-dockflow.probes.use: none -> nothing emitted',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        start_period: 500ms
      x-dockflow:
        probes:
          use: none
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-04a',
    title: 'test: [NONE] -> no probe keys',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["NONE"]
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-04b',
    title: 'disable: true -> no probe keys',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        disable: true
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-05-readiness',
    title: 'x-dockflow.probes.use: readiness, no start_period -> only readiness',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
      x-dockflow:
        probes:
          use: readiness
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/periodSeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-05-liveness',
    title: 'x-dockflow.probes.use: liveness, no start_period -> only liveness (no startup: start_period is 0)',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
      x-dockflow:
        probes:
          use: liveness
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe/initialDelaySeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-05-none',
    title: 'x-dockflow.probes.use: none, no start_period -> nothing',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
      x-dockflow:
        probes:
          use: none
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe`, absent: true },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/startupProbe`, absent: true },
    ],
  },
  {
    id: 'T-PROBE-06',
    title: 'x-dockflow.probes.http overrides the handler while keeping the healthcheck timings',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 10s
      x-dockflow:
        probes:
          http:
            path: /health
            port: 8080
            scheme: HTTPS
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/httpGet`, equals: { path: '/health', port: 8080, scheme: 'HTTPS' } },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/periodSeconds`, equals: 10 },
    ],
  },
  {
    id: 'T-PROBE-07',
    title: 'x-dockflow.probes.tcp with no healthcheck -> tcpSocket handler, Docker default timings',
    compose: `
      image: nginx:1.27
      x-dockflow:
        probes:
          tcp:
            port: 5432
    `,
    expect: [
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/tcpSocket`, equals: { port: 5432 } },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/periodSeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/timeoutSeconds`, equals: 30 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/readinessProbe/failureThreshold`, equals: 3 },
      { object: 'Deployment/web', pointer: `${CONTAINER_PROBE}/livenessProbe/tcpSocket`, equals: { port: 5432 } },
    ],
  },
  {
    id: 'T-PROBE-08',
    title: 'CMD-SHELL with a literal $(hostname) after compose reduction ($$ -> $) is doubled so the kubelet never expands it',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD-SHELL", "curl -f http://localhost/$$(hostname)"]
    `,
    expect: {
      object: 'Deployment/web',
      pointer: `${CONTAINER_PROBE}/readinessProbe/exec/command`,
      equals: ['/bin/sh', '-c', 'curl -f http://localhost/$$(hostname)'],
    },
  },
  {
    id: 'T-PROBE-09',
    title: 'every emitted probe carries periodSeconds, timeoutSeconds, failureThreshold, successThreshold and initialDelaySeconds',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD","true"]
        interval: 20s
        timeout: 4s
        retries: 2
        start_period: 40s
        start_interval: 8s
    `,
    expect: [
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/startupProbe`,
        equals: { exec: { command: ['true'] }, periodSeconds: 8, timeoutSeconds: 4, failureThreshold: 10, successThreshold: 1, initialDelaySeconds: 0 },
      },
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/readinessProbe`,
        equals: { exec: { command: ['true'] }, periodSeconds: 20, timeoutSeconds: 4, failureThreshold: 2, successThreshold: 1, initialDelaySeconds: 0 },
      },
      {
        object: 'Deployment/web',
        pointer: `${CONTAINER_PROBE}/livenessProbe`,
        equals: { exec: { command: ['true'] }, periodSeconds: 20, timeoutSeconds: 4, failureThreshold: 2, successThreshold: 1, initialDelaySeconds: 0 },
      },
    ],
  },
];

runTranslateRows('translate/probes (T-PROBE)', rows);

test('T-PROBE-08 the emitted command round-trips through the kubelet expander to the literal (design-02 T4)', () => {
  const { objects } = translateRow({
    id: 'k8sExpand-roundtrip',
    title: 'k8sExpand roundtrip',
    compose: `
      image: nginx:1.27
      healthcheck:
        test: ["CMD-SHELL", "curl -f http://localhost/$$(hostname)"]
    `,
    expect: [],
  });
  const deployment = objects.find((o) => o.kind === 'Deployment');
  if (deployment === undefined) throw new Error('no Deployment object was produced');
  const emitted = jsonPointer(deployment, `${CONTAINER_PROBE}/readinessProbe/exec/command`).value as string[];
  expect(k8sExpand(emitted, {})).toEqual(['/bin/sh', '-c', 'curl -f http://localhost/$(hostname)']);
});
