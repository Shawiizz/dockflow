// design-07 5.2 T-PULL and T-POD rows (translate/pod.ts, D12, DV5, design-02 5.10).
//
// T-POD-01/02/03/04: design-07's cells describe an equals constraint as "<key> In [<value>]", but
// `requirementFor`'s 'equals' branch feeds `nodePlacement`'s `equals` map, which becomes a plain
// `nodeSelector: {key: value}`, never a `matchExpressions` entry with operator `In` (only the
// `!=` branch produces a `matchExpressions` entry, with `NotIn`). This file follows the source
// (design-02 5.10, confirmed against `translate/pod.ts`) and asserts the plain `nodeSelector` form
// for every `==` constraint.
// T-POD-02's third input ("==ghost", not a server key) is normalizer-refused (`placement.unknown-server`,
// normalize/deploy.ts) before the translator ever sees it; it is not a translator row (design-01 11
// covers it).

import { LABELS } from '../../../../services/orchestrator/kubernetes/constants';
import { k3sDistribution } from '../../../../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../../../../services/orchestrator/kubernetes/naming';
import { type TranslateRow, runTranslateRows } from '../../support/rows';

const NAMESPACE = namespaceFor('shop', 'production');
const SELECTOR = { [LABELS.stack]: NAMESPACE, [LABELS.service]: 'web' };
const HOSTNAME_SPREAD = { labelSelector: { matchLabels: SELECTOR }, matchLabelKeys: ['pod-template-hash'], maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway' };
const CONTROL_PLANE = k3sDistribution.traits.controlPlaneNodeLabel;

const rows: TranslateRow[] = [
  // -- T-PULL --------------------------------------------------------------------------------
  {
    id: 'T-PULL-01',
    title: 'built, import -> image/pullPolicy copied verbatim, no imagePullSecrets (pullSecretName null by default)',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'dockflow.invalid/shop-api:1.4.2', composeRef: 'shop-api:1.4.2', origin: 'built', pullPolicy: 'IfNotPresent' } })] }),
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/image', equals: 'dockflow.invalid/shop-api:1.4.2' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'IfNotPresent' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/imagePullSecrets', absent: true },
    ],
  },
  {
    id: 'T-PULL-02',
    title: 'built, registry, pullSecretName: dockflow-registry -> compose ref, IfNotPresent, imagePullSecrets',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'registry.example.com/shop-api:1.4.2', composeRef: 'registry.example.com/shop-api:1.4.2', origin: 'built', pullPolicy: 'IfNotPresent' } })] }),
    options: { pullSecretName: 'dockflow-registry' },
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/image', equals: 'registry.example.com/shop-api:1.4.2' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/imagePullSecrets', equals: [{ name: 'dockflow-registry' }] },
    ],
  },
  {
    id: 'T-PULL-03-tag',
    title: 'pulled, tagged -> IfNotPresent (D12, set by the normalizer, copied verbatim by the translator)',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'redis:8-alpine', composeRef: 'redis:8-alpine', origin: 'pulled', pullPolicy: 'IfNotPresent' } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'T-PULL-03-latest',
    title: 'pulled, latest -> Always',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'redis:latest', composeRef: 'redis:latest', origin: 'pulled', pullPolicy: 'Always' } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'Always' },
  },
  {
    id: 'T-PULL-03-untagged',
    title: 'pulled, untagged -> Always',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'redis', composeRef: 'redis', origin: 'pulled', pullPolicy: 'Always' } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'Always' },
  },
  {
    id: 'T-PULL-03-digest',
    title: 'pulled, digest -> IfNotPresent',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'redis@sha256:abc', composeRef: 'redis@sha256:abc', origin: 'pulled', pullPolicy: 'IfNotPresent' } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'IfNotPresent' },
  },
  {
    id: 'T-PULL-04',
    title: 'pull_policy: never -> Never',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ image: { ref: 'redis:8-alpine', composeRef: 'redis:8-alpine', origin: 'pulled', pullPolicy: 'Never' } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'Never' },
  },

  // -- T-POD ---------------------------------------------------------------------------------
  {
    id: 'T-POD-01-manager',
    title: 'node.role==manager -> nodeSelector on the control-plane label',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.role', operator: '==', value: 'manager', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { [CONTROL_PLANE.key]: CONTROL_PLANE.value } },
      { object: 'Deployment/web', pointer: '/spec/template/spec/affinity', absent: true },
    ],
  },
  {
    id: 'T-POD-01-not-manager',
    title: 'node.role!=manager -> required nodeAffinity DoesNotExist on the control-plane label',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.role', operator: '!=', value: 'manager', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms/0/matchExpressions',
      equals: [{ key: CONTROL_PLANE.key, operator: 'DoesNotExist' }],
    },
  },
  {
    id: 'T-POD-01-worker',
    title: 'node.role==worker -> the same shape as !=manager',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.role', operator: '==', value: 'worker', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms/0/matchExpressions',
      equals: [{ key: CONTROL_PLANE.key, operator: 'DoesNotExist' }],
    },
  },
  {
    id: 'T-POD-02-hostname-equals',
    title: 'node.hostname==agent_1 -> nodeSelector kubernetes.io/hostname: agent-1 (nodeNameFor)',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.hostname', operator: '==', value: 'agent_1', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { 'kubernetes.io/hostname': 'agent-1' } },
  },
  {
    id: 'T-POD-02-hostname-not-equals',
    title: 'node.hostname!=agent_1 -> required nodeAffinity NotIn [agent-1]',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.hostname', operator: '!=', value: 'agent_1', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms/0/matchExpressions',
      equals: [{ key: 'kubernetes.io/hostname', operator: 'NotIn', values: ['agent-1'] }],
    },
  },
  {
    id: 'T-POD-03-labels-equals',
    title: 'node.labels.zone==a -> nodeSelector zone: a',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.labels', key: 'zone', operator: '==', value: 'a', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { zone: 'a' } },
  },
  {
    id: 'T-POD-03-labels-not-equals',
    title: 'node.labels.zone!=a -> required nodeAffinity zone NotIn [a]',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.labels', key: 'zone', operator: '!=', value: 'a', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms/0/matchExpressions',
      equals: [{ key: 'zone', operator: 'NotIn', values: ['a'] }],
    },
  },
  {
    id: 'T-POD-04-arch-x86',
    title: 'node.platform.arch==x86_64 -> kubernetes.io/arch: amd64',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.platform.arch', operator: '==', value: 'x86_64', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { 'kubernetes.io/arch': 'amd64' } },
  },
  {
    id: 'T-POD-04-arch-aarch64',
    title: 'node.platform.arch==aarch64 -> kubernetes.io/arch: arm64',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.platform.arch', operator: '==', value: 'aarch64', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { 'kubernetes.io/arch': 'arm64' } },
  },
  {
    id: 'T-POD-04-os',
    title: 'node.platform.os==linux -> kubernetes.io/os: linux',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [{ attribute: 'node.platform.os', operator: '==', value: 'linux', path: 'services.web.deploy.placement.constraints[0]' }] } })] }),
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { 'kubernetes.io/os': 'linux' } },
  },
  {
    id: 'T-POD-05',
    title: 'placement.preferences spread: node.labels.zone -> topologySpreadConstraints: the implicit hostname spread, then the declared one',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [], spreadLabels: ['zone'], maxReplicasPerNode: null } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/topologySpreadConstraints',
      equals: [HOSTNAME_SPREAD, { labelSelector: { matchLabels: SELECTOR }, matchLabelKeys: ['pod-template-hash'], maxSkew: 1, topologyKey: 'zone', whenUnsatisfiable: 'ScheduleAnyway' }],
    },
  },
  {
    id: 'T-POD-06',
    title: 'max_replicas_per_node: 1 -> required podAntiAffinity on kubernetes.io/hostname',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ placement: { constraints: [], spreadLabels: [], maxReplicasPerNode: 1 } })] }),
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/affinity/podAntiAffinity/requiredDuringSchedulingIgnoredDuringExecution',
      equals: [{ labelSelector: { matchLabels: SELECTOR }, matchLabelKeys: ['pod-template-hash'], topologyKey: 'kubernetes.io/hostname' }],
    },
  },
  {
    id: 'T-POD-07',
    title: 'x-dockflow node_selector, tolerations, fs_group -> merged nodeSelector, tolerations in order (tolerationSeconds dropped without NoExecute), fsGroup',
    stack: (b) =>
      b.canonicalStack({
        services: [
          b.canonicalService({
            extension: {
              nodeSelector: { zone: 'a' },
              tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoSchedule', tolerationSeconds: 30 }],
              fsGroup: 1000,
            },
          }),
        ],
      }),
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/nodeSelector', equals: { zone: 'a' } },
      { object: 'Deployment/web', pointer: '/spec/template/spec/tolerations', equals: [{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/securityContext/fsGroup', equals: 1000 },
      { object: 'Deployment/web', pointer: '/spec/template/spec/securityContext/fsGroupChangePolicy', equals: 'OnRootMismatch' },
    ],
  },
];

runTranslateRows('translate/pod (T-PULL, T-POD)', rows);
