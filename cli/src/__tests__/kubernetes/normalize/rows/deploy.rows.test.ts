// design-07 4.2 row catalogue, group N-DEP (`deploy.*`, `scale`, `restart`, `depends_on`, and the
// engine-level resource keys; design-01 5.8, 5.9, 5.10). Every row runs the full pipeline
// (PD-11 (a)). N-ID-26/27/28 (replicas, mode, x-dockflow.kind conflict) are grouped in
// identity.rows.test.ts, as design-07 4.2 lists them there.
//
// Difference from the design-07 proposal: `deploy.restart-policy-unsupported` (C6, N-DEP-04) is
// emitted by the TRANSLATOR over the model deploy.ts already built (its own comment says so), never
// by the normalizer; a normalizer row cannot assert it, so N-DEP-04 only asserts the mapped model.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-DEP-01',
    title: 'role app with no update_config gets the Dockflow defaults',
    role: 'app',
    compose: 'image: nginx:1.27',
    expect: {
      select: '/services/0/update',
      equals: { parallelism: 1, delayMs: 10_000, failureAction: 'rollback', monitorMs: 30_000, order: 'start-first', maxFailureRatio: 0, defaults: 'dockflow' },
    },
  },
  {
    id: 'N-DEP-02',
    title: 'role accessory with no update_config gets the Docker defaults',
    role: 'accessory',
    compose: 'image: nginx:1.27',
    expect: {
      select: '/services/0/update',
      equals: { parallelism: 1, delayMs: 0, failureAction: 'pause', monitorMs: 5_000, order: 'stop-first', maxFailureRatio: 0, defaults: 'docker' },
    },
  },
  {
    id: 'N-DEP-03',
    title: 'update_config.order alone differs from the app default',
    role: 'app',
    compose: 'image: nginx:1.27\ndeploy:\n  update_config:\n    order: stop-first',
    expect: { select: '/services/0/update/order', equals: 'stop-first' },
  },
  {
    id: 'N-DEP-04',
    title: 'restart_policy is mapped, with a warning',
    compose: 'image: nginx:1.27\ndeploy:\n  restart_policy:\n    condition: on-failure\n    max_attempts: 3\n    delay: 5s\n    window: 1m',
    expect: [
      { select: '/services/0/restart', equals: { condition: 'on-failure', delayMs: 5000, maxAttempts: 3, windowMs: 60_000 } },
      { diagnostics: [{ severity: 'info', code: 'restart.on-failure', path: 'services.web.deploy.restart_policy.condition' }] },
    ],
  },
  {
    id: 'N-DEP-05',
    title: 'limits and reservations are converted to millicores and bytes',
    compose:
      'image: nginx:1.27\ndeploy:\n  resources:\n    limits:\n      cpus: "0.5"\n      memory: 512M\n      pids: 100\n    reservations:\n      cpus: 0.25\n      memory: 128m',
    expect: [
      {
        select: '/services/0/resources',
        equals: { limits: { cpu: 500, memory: 536_870_912, pids: 100 }, reservations: { cpu: 250, memory: 134_217_728 } },
      },
      { diagnostics: [{ severity: 'warning', code: 'resources.pids-unsupported', path: 'services.web.deploy.resources.limits.pids' }] },
    ],
  },
  {
    id: 'N-DEP-06',
    title: 'a fractional CPU count below one millicore rounds up',
    compose: 'image: nginx:1.27\ndeploy:\n  resources:\n    limits:\n      cpus: "0.0001"',
    expect: { select: '/services/0/resources/limits/cpu', equals: 1 },
  },
  {
    id: 'N-DEP-07',
    title: 'four placement constraints are kept in order, values verbatim',
    compose:
      'image: nginx:1.27\ndeploy:\n  placement:\n    constraints:\n      - node.role==manager\n      - node.hostname != agent_1\n      - node.labels.zone == a\n      - node.platform.arch==x86_64',
    expect: {
      select: '/services/0/placement/constraints',
      equals: [
        { attribute: 'node.role', operator: '==', value: 'manager', path: 'services.web.deploy.placement.constraints[0]' },
        { attribute: 'node.hostname', operator: '!=', value: 'agent_1', path: 'services.web.deploy.placement.constraints[1]' },
        { attribute: 'node.labels', key: 'zone', operator: '==', value: 'a', path: 'services.web.deploy.placement.constraints[2]' },
        { attribute: 'node.platform.arch', operator: '==', value: 'x86_64', path: 'services.web.deploy.placement.constraints[3]' },
      ],
    },
  },
  {
    id: 'N-DEP-08a',
    title: 'node.id constraints are refused',
    compose: 'image: nginx:1.27\ndeploy:\n  placement:\n    constraints:\n      - node.id==abc',
    expect: { diagnostics: [{ severity: 'error', code: 'placement.node-id', path: 'services.web.deploy.placement.constraints[0]' }] },
  },
  {
    id: 'N-DEP-08b',
    title: 'engine.labels constraints are refused',
    compose: 'image: nginx:1.27\ndeploy:\n  placement:\n    constraints:\n      - engine.labels.x==y',
    expect: { diagnostics: [{ severity: 'error', code: 'placement.engine-labels', path: 'services.web.deploy.placement.constraints[0]' }] },
  },
  {
    id: 'N-DEP-08c',
    title: 'node.role must be manager or worker',
    compose: 'image: nginx:1.27\ndeploy:\n  placement:\n    constraints:\n      - node.role=manager',
    expect: { diagnostics: [{ severity: 'error', code: 'placement.invalid-constraint', path: 'services.web.deploy.placement.constraints[0]' }] },
  },
  {
    id: 'N-DEP-09',
    title: 'spread preferences and max_replicas_per_node',
    compose: 'image: nginx:1.27\ndeploy:\n  placement:\n    preferences:\n      - spread: node.labels.zone\n    max_replicas_per_node: 1',
    expect: [
      { select: '/services/0/placement/spreadLabels', equals: ['zone'] },
      { select: '/services/0/placement/maxReplicasPerNode', equals: 1 },
    ],
  },
  {
    id: 'N-DEP-10',
    title: 'endpoint_mode dnsrr is mapped',
    compose: 'image: nginx:1.27\ndeploy:\n  endpoint_mode: dnsrr',
    expect: { select: '/services/0/network/endpointMode', equals: 'dnsrr' },
  },
  {
    id: 'N-DEP-11',
    title: 'rollback_config with a written key is never silent',
    compose: 'image: nginx:1.27\ndeploy:\n  rollback_config:\n    parallelism: 2',
    expect: { diagnostics: [{ severity: 'info', code: 'deploy.rollback-config', path: 'services.web.deploy.rollback_config' }] },
  },
  {
    id: 'N-DEP-12',
    title: 'deploy.labels: traefik and com.docker keys are filtered, the rest kept',
    compose: 'image: nginx:1.27\ndeploy:\n  labels: ["traefik.enable=true", "team=a", "com.docker.x=y"]',
    expect: [
      { select: '/services/0/serviceLabels', equals: { team: 'a' } },
      { diagnostics: [{ severity: 'warning', code: 'routing.proxy-disabled', path: 'services.web' }] },
    ],
  },
  {
    id: 'N-DEP-13',
    title: 'service-level cpus and mem_limit map directly when deploy.resources is absent',
    compose: 'image: nginx:1.27\ncpus: 0.5\nmem_limit: 256m',
    expect: [
      { select: '/services/0/resources/limits/cpu', equals: 500 },
      { select: '/services/0/resources/limits/memory', equals: 268_435_456 },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-DEP-14a',
    title: 'a replicated-job carries the compose restart value unchanged, no deploy.job-restart-any',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: replicated-job\nrestart: "on-failure"',
    expect: [
      { select: '/services/0/restart/condition', equals: 'on-failure' },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-DEP-14b',
    title: 'a replicated-job with no restart written keeps the model default',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: replicated-job',
    expect: [
      { select: '/services/0/restart/condition', equals: 'any' },
      { diagnostics: [], exact: true },
    ],
  },
  {
    id: 'N-DEP-15',
    title: 'an accessory global service with no deploy.replicas gets no restart-policy warning',
    role: 'accessory',
    compose: 'image: nginx:1.27\ndeploy:\n  mode: global',
    expect: { diagnostics: [], exact: true },
  },
  {
    id: 'N-DEP-DEPENDS-01',
    title: 'depends_on has no Kubernetes equivalent',
    compose: 'image: nginx:1.27\ndepends_on: [db]',
    sibling: { services: ['db'] },
    expect: { diagnostics: [{ severity: 'info', code: 'depends_on.no-ordering', path: 'services.web.depends_on' }] },
  },
  {
    id: 'N-DEP-DEPENDS-02',
    title: 'an unknown depends_on service warns',
    compose: 'image: nginx:1.27\ndepends_on: [ghost]',
    expect: {
      diagnostics: [
        { severity: 'warning', code: 'depends_on.unknown-service', path: 'services.web.depends_on[0]' },
        { severity: 'info', code: 'depends_on.no-ordering', path: 'services.web.depends_on' },
      ],
    },
  },
  {
    id: 'N-DEP-RES-01',
    title: 'a resources conflict between the engine-level and deploy.resources forms is refused',
    compose: 'image: nginx:1.27\nmem_limit: 256m\ndeploy:\n  resources:\n    limits:\n      memory: 512m',
    expect: { diagnostics: [{ severity: 'error', code: 'resources.conflict', path: 'services.web.mem_limit' }] },
  },
  {
    id: 'N-DEP-RES-02',
    title: 'cpuset is not supported',
    compose: 'image: nginx:1.27\ncpuset: "0-1"',
    expect: { diagnostics: [{ severity: 'error', code: 'resources.cpuset-unsupported', path: 'services.web.cpuset' }] },
  },
];

runNormalizeRows('normalize/deploy (N-DEP)', rows);
