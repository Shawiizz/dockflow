// design-07 4.2 row catalogue, group N-EXT (`x-dockflow`; design-01 8, DESIGN-CORE 7.3). Every row
// runs the full pipeline (PD-11 (a)).
//
// Difference from the design-07 proposal: `toleration_seconds` requires `effect: NoExecute`
// (compose-extension.schema.ts `superRefine`), which the design-07 N-EXT-06 example did not use;
// the row uses `NoExecute` so the toleration validates.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-EXT-01a',
    title: 'kind: deployment is mapped',
    compose: 'image: nginx:1.27\nx-dockflow:\n  kind: deployment',
    expect: { select: '/services/0/workloadKind', equals: 'Deployment' },
  },
  {
    id: 'N-EXT-01b',
    title: 'kind: statefulset is mapped',
    compose: 'image: nginx:1.27\nx-dockflow:\n  kind: statefulset',
    expect: { select: '/services/0/workloadKind', equals: 'StatefulSet' },
  },
  {
    id: 'N-EXT-01c',
    title: 'kind: job is refused by the schema',
    compose: 'image: nginx:1.27\nx-dockflow:\n  kind: job',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.kind' }] },
  },
  {
    id: 'N-EXT-02a',
    title: 'publish: loadbalancer is mapped',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  publish: loadbalancer',
    expect: { select: '/services/0/extension/publish', equals: 'loadbalancer' },
  },
  {
    id: 'N-EXT-02b',
    title: 'publish: hostport is mapped',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  publish: hostport',
    expect: { select: '/services/0/extension/publish', equals: 'hostport' },
  },
  {
    id: 'N-EXT-02c',
    title: 'publish: none is mapped',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  publish: none',
    expect: { select: '/services/0/extension/publish', equals: 'none' },
  },
  {
    id: 'N-EXT-02d',
    title: 'publish: nodeport is refused',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  publish: nodeport',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.publish' }] },
  },
  {
    id: 'N-EXT-03a',
    title: 'lb_source_ranges is sorted and deduplicated',
    compose:
      'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  lb_source_ranges: ["10.0.0.0/8", "10.0.0.0/8", "2001:db8::/32"]',
    expect: { select: '/services/0/extension/loadBalancerSourceRanges', equals: ['10.0.0.0/8', '2001:db8::/32'] },
  },
  {
    id: 'N-EXT-03b',
    title: 'a bare IP without a prefix length is refused',
    compose: 'image: nginx:1.27\nports: ["8080:80"]\nx-dockflow:\n  lb_source_ranges: ["10.0.0.1"]',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.lb_source_ranges[0]' }] },
  },
  {
    id: 'N-EXT-04a',
    title: 'probes.use is mapped',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\nx-dockflow:\n  probes:\n    use: readiness',
    expect: { select: '/services/0/extension/probes/use', equals: 'readiness' },
  },
  {
    id: 'N-EXT-04b',
    title: 'probes.http is mapped',
    compose: 'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\nx-dockflow:\n  probes:\n    http:\n      path: /health\n      port: 8080',
    expect: { select: '/services/0/extension/probes/handler', equals: { type: 'http', path: '/health', port: 8080, scheme: 'HTTP' } },
  },
  {
    id: 'N-EXT-04c',
    title: 'http and tcp together is refused',
    compose:
      'image: nginx:1.27\nhealthcheck:\n  test: ["CMD", "true"]\nx-dockflow:\n  probes:\n    http:\n      path: /health\n      port: 8080\n    tcp:\n      port: 8080',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.probes.tcp' }] },
  },
  {
    id: 'N-EXT-05a',
    title: 'node_selector is mapped',
    compose: 'image: nginx:1.27\nx-dockflow:\n  node_selector:\n    zone: a',
    expect: { select: '/services/0/extension/nodeSelector', equals: { zone: 'a' } },
  },
  {
    id: 'N-EXT-05b',
    title: 'an invalid node_selector key is refused',
    compose: 'image: nginx:1.27\nx-dockflow:\n  node_selector:\n    "bad key!": a',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.node_selector["bad key!"]' }] },
  },
  {
    id: 'N-EXT-06',
    title: 'tolerations are mapped',
    compose:
      'image: nginx:1.27\nx-dockflow:\n  tolerations:\n    - key: dedicated\n      operator: Equal\n      value: db\n      effect: NoExecute\n      toleration_seconds: 30',
    expect: {
      select: '/services/0/extension/tolerations',
      equals: [{ key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoExecute', tolerationSeconds: 30 }],
    },
  },
  {
    id: 'N-EXT-07a',
    title: 'fs_group is mapped',
    compose: 'image: nginx:1.27\nx-dockflow:\n  fs_group: 1000',
    expect: { select: '/services/0/extension/fsGroup', equals: 1000 },
  },
  {
    id: 'N-EXT-07b',
    title: 'a negative fs_group is refused',
    compose: 'image: nginx:1.27\nx-dockflow:\n  fs_group: -1',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.fs_group' }] },
  },
  {
    id: 'N-EXT-08a',
    title: 'pod_labels is mapped',
    compose: 'image: nginx:1.27\nx-dockflow:\n  pod_labels:\n    team: a',
    expect: { select: '/services/0/extension/podLabels', equals: { team: 'a' } },
  },
  {
    id: 'N-EXT-08b',
    title: 'an app.kubernetes.io pod label key is refused',
    compose: 'image: nginx:1.27\nx-dockflow:\n  pod_labels:\n    "app.kubernetes.io/name": x',
    expect: {
      diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.pod_labels["app.kubernetes.io/name"]' }],
    },
  },
  {
    id: 'N-EXT-08c',
    title: 'a dockflow.shawiizz.dev pod label key is refused',
    compose: 'image: nginx:1.27\nx-dockflow:\n  pod_labels:\n    "dockflow.shawiizz.dev/x": y',
    expect: {
      diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.pod_labels["dockflow.shawiizz.dev/x"]' }],
    },
  },
  {
    id: 'N-EXT-09',
    title: 'an unknown x-dockflow key is refused',
    compose: 'image: nginx:1.27\nx-dockflow:\n  unknown: 1',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.invalid', path: 'services.web.x-dockflow.unknown' }] },
  },
  {
    id: 'N-EXT-10',
    title: 'a top-level x-dockflow key is refused',
    compose: 'services:\n  web:\n    image: nginx:1.27\nx-dockflow: {}\n',
    expect: { diagnostics: [{ severity: 'error', code: 'extension.misplaced', path: 'x-dockflow' }] },
  },
  {
    id: 'N-EXT-11',
    title: 'a YAML anchor merged with <<: is resolved at load, with no extra diagnostic',
    // `builders.composeYaml` only treats a string starting with the literal `services:` as a full
    // document, so the anchor (which must precede its alias) is defined on an earlier service's
    // key instead of a top-level `x-common`; the point asserted is the same one design-01 makes:
    // the merge is resolved before the normalizer ever sees the document, so nothing about it is
    // reported.
    compose:
      'services:\n  base:\n    image: nginx:1.27\n    x-shared: &common\n      labels:\n        team: core\n  web:\n    <<: *common\n    image: nginx:1.27\n',
    expect: { select: '/services/1/containerLabels', equals: { team: 'core' } },
  },
];

runNormalizeRows('normalize/extension (N-EXT)', rows);
