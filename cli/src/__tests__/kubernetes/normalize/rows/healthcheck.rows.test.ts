// design-07 4.2 row catalogue, group N-HC (`healthcheck`; design-01 5.7, D10). Every row runs the
// full pipeline (PD-11 (a)).

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-HC-01',
    title: 'a CMD exec test with Docker timing defaults',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "curl", "-f", "http://localhost"]',
    expect: {
      select: '/services/0/healthcheck',
      equals: {
        test: { type: 'exec', argv: ['curl', '-f', 'http://localhost'] },
        intervalMs: 30_000,
        timeoutMs: 30_000,
        retries: 3,
        startPeriodMs: 0,
        startIntervalMs: 5_000,
        path: 'services.web.healthcheck',
      },
    },
  },
  {
    id: 'N-HC-02a',
    title: 'CMD-SHELL becomes a shell test',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD-SHELL", "curl -f http://localhost"]',
    expect: { select: '/services/0/healthcheck/test', equals: { type: 'shell', command: 'curl -f http://localhost' } },
  },
  {
    id: 'N-HC-02b',
    title: 'a plain string test is CMD-SHELL',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: curl -f http://localhost',
    expect: { select: '/services/0/healthcheck/test', equals: { type: 'shell', command: 'curl -f http://localhost' } },
  },
  {
    id: 'N-HC-03a',
    title: 'test: [NONE] disables the healthcheck',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: [NONE]',
    expect: { select: '/services/0/healthcheck', equals: null },
  },
  {
    id: 'N-HC-03b',
    title: 'disable: true disables the healthcheck',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "curl", "-f", "http://localhost"]\n  disable: true',
    expect: { select: '/services/0/healthcheck', equals: null },
  },
  {
    id: 'N-HC-04',
    title: 'interval, timeout, start_period and start_interval are mapped in milliseconds',
    compose:
      'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\n  interval: 1m30s\n  timeout: 500ms\n  start_period: 1.5s\n  start_interval: 2s\n  retries: 5',
    expect: {
      select: '/services/0/healthcheck',
      equals: {
        test: { type: 'exec', argv: ['true'] },
        intervalMs: 90_000,
        timeoutMs: 500,
        retries: 5,
        startPeriodMs: 1500,
        startIntervalMs: 2000,
        path: 'services.web.healthcheck',
      },
    },
  },
  {
    id: 'N-HC-05a',
    title: 'an empty test list is refused',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: []',
    expect: { diagnostics: [{ severity: 'warning', code: 'healthcheck.inherits-image', path: 'services.web.healthcheck' }] },
  },
  {
    id: 'N-HC-05b',
    title: 'CMD with no command is refused',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD"]',
    expect: { diagnostics: [{ severity: 'error', code: 'healthcheck.empty-test', path: 'services.web.healthcheck.test' }] },
  },
  {
    id: 'N-HC-06a',
    title: 'retries: 0 keeps the default (Docker semantics)',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\n  retries: 0',
    expect: { select: '/services/0/healthcheck/retries', equals: 3 },
  },
  {
    id: 'N-HC-06b',
    title: 'timeout: 0s keeps the default',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\n  timeout: 0s',
    expect: { select: '/services/0/healthcheck/timeoutMs', equals: 30_000 },
  },
  {
    id: 'N-HC-07',
    title: 'an invalid duration is refused',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\n  interval: 10x',
    expect: { diagnostics: [{ severity: 'error', code: 'values.invalid-duration', path: 'services.web.healthcheck.interval' }] },
  },
];

runNormalizeRows('normalize/healthcheck (N-HC)', rows);
