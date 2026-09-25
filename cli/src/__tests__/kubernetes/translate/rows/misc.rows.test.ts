// design-07 5.2 T-WORK/T-SEC/T-NET/T-STOR/T-META rows (WORK-PACKAGES.md P50 spec: grouped in one
// file), covering workloads.ts's shared metadata/selector helpers, pod.ts's security context and
// DNS/hosts fields, storage.ts's claim shapes and the emitter-facing array-order and quantity rules.
//
// T-NET-03: design-07's cell claims "(S1) dnsPolicy: None with nameservers and search list", but
// `networkFields` (translate/pod.ts) never sets `dnsPolicy` for extra nameservers, only for
// `hostNetwork`; the design-02 11.2 message of `network.dns-secondary` ("used only when cluster DNS
// does not answer") confirms cluster DNS stays authoritative. This file follows the source and
// asserts `dnsPolicy` absent (default ClusterFirst) with the nameserver added to `dnsConfig`.
// T-STOR-03: design-07's cell claims a `hostPath.type: DirectoryOrCreate`, but the `Volume` type's
// own comment ("the translator never emits `type`... helper pods do") and `bindMount()` confirm no
// `type` field is ever written. This file asserts `hostPath` carries only `path`.
// T-STOR-05/T-META-07 (quantities): tested through container resource limits, where `cpuQuantity`/
// `memoryQuantity` actually run; a bare `x-dockflow.size` string is normalized by `canonicalQuantity`
// alone, which does not upgrade a plain decimal byte count to binary form (design-02 1.2, 7.1).
// T-META-04 (the ComposeTranslationError message/suggestion format) is render.ts's concern
// (P38), not a translate/*.ts row.
// T-META-05 (a diagnostic reported by both layers reaches the user once, on the merged list) is the
// same case: `translateRow` (support/rows.ts) shares one DiagnosticSink across normalize and
// translate "as in render()", and the dedupe-by-(code,path)/sort-by-(path,code) contract it relies
// on belongs to DiagnosticSink itself (orchestrator/diagnostics.ts, P01), already asserted by
// T/orchestrator/diagnostics.test.ts. No translate/*.ts module decides that behaviour, so there is
// nothing translate-specific for a row here to pin.

import { expect, test } from 'bun:test';
import { ANNOTATIONS, LABELS } from '../../../../services/orchestrator/kubernetes/constants';
import { podTemplateLabels, selectorLabels, serviceObjectLabels } from '../../../../services/orchestrator/kubernetes/labels';
import { namespaceFor } from '../../../../services/orchestrator/kubernetes/naming';
import { KIND_REGISTRY } from '../../../../services/orchestrator/kubernetes/resources/registry';
import { k8sExpand } from '../../support/k8s-expand';
import { type TranslateRow, runTranslateRows, translateRow } from '../../support/rows';

const NAMESPACE = namespaceFor('shop', 'production');
const IDENTITY = { project: 'shop', namespace: NAMESPACE };

const rows: TranslateRow[] = [
  // -- T-WORK ----------------------------------------------------------------------------------
  {
    id: 'T-WORK-01',
    title: 'app service -> the full label and annotation set, no P/release',
    compose: 'image: nginx:1.27',
    expect: [
      { object: 'Deployment/web', pointer: '/metadata/labels', equals: serviceObjectLabels(IDENTITY, 'app', 'web') },
      { object: 'Deployment/web', pointer: `/metadata/annotations/${ANNOTATIONS.composeService.replace('/', '~1')}`, equals: 'web' },
      { object: 'Deployment/web', pointer: `/metadata/annotations/${ANNOTATIONS.release.replace('/', '~1')}`, absent: true },
    ],
  },
  {
    id: 'T-WORK-02',
    title: 'accessory service -> no P/release annotation anywhere on the workload',
    compose: 'image: nginx:1.27',
    normalize: { role: 'accessory' },
    expect: { object: 'Deployment/web', pointer: `/metadata/annotations/${ANNOTATIONS.release.replace('/', '~1')}`, absent: true },
  },
  {
    id: 'T-WORK-03',
    title: 'selector matchLabels is exactly {P/stack, P/service}',
    compose: 'image: nginx:1.27',
    expect: { object: 'Deployment/web', pointer: '/spec/selector', equals: { matchLabels: selectorLabels(IDENTITY, 'web') } },
  },
  {
    id: 'T-WORK-04',
    title: 'pod template labels: selector + app.kubernetes.io/name, instance, P/role, x-dockflow.pod_labels',
    compose: `
      image: nginx:1.27
      x-dockflow:
        pod_labels:
          team: a
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/metadata/labels', equals: podTemplateLabels(IDENTITY, 'app', 'web', { team: 'a' }) },
  },
  {
    id: 'T-WORK-05',
    title: 'pod template annotations: default-container, P/compose-service, P/config-hash, compose labels/annotations',
    compose: `
      image: nginx:1.27
      environment:
        A: "1"
      labels:
        team: a
      annotations:
        note: b
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1default-container', equals: 'web' },
      { object: 'Deployment/web', pointer: `/spec/template/metadata/annotations/${ANNOTATIONS.composeService.replace('/', '~1')}`, equals: 'web' },
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/team', equals: 'a' },
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/note', equals: 'b' },
    ],
  },
  {
    id: 'T-WORK-07',
    title: 'mandatory fields common to every kind',
    compose: 'image: nginx:1.27',
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/terminationGracePeriodSeconds', equals: 10 },
      { object: 'Deployment/web', pointer: '/spec/template/spec/enableServiceLinks', equals: false },
      { object: 'Deployment/web', pointer: '/spec/template/spec/automountServiceAccountToken', equals: false },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/imagePullPolicy', equals: 'IfNotPresent' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/securityContext/seccompProfile', equals: { type: 'RuntimeDefault' } },
    ],
  },

  // -- T-SEC -----------------------------------------------------------------------------------
  {
    id: 'T-SEC-01',
    title: 'a full security profile: capabilities sorted, readOnlyRootFilesystem, allowPrivilegeEscalation false, seccomp/apparmor, sysctls sorted, runAsUser/Group, supplementalGroups',
    stack: (b) =>
      b.canonicalStack({
        services: [
          b.canonicalService({
            security: {
              privileged: false,
              capAdd: ['NET_RAW', 'NET_ADMIN'],
              capDrop: ['ALL'],
              readOnlyRootFilesystem: true,
              noNewPrivileges: true,
              seccomp: 'unconfined',
              apparmor: { localhostProfile: 'my-profile' },
              sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0', 'net.ipv4.tcp_syncookies': '1' },
              hostPid: true,
              hostIpc: true,
            },
            process: { user: { uid: 1000, gid: 1000 }, groupAdd: [2000, 1000] },
          }),
        ],
      }),
    expect: [
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/containers/0/securityContext',
        equals: {
          capabilities: { add: ['NET_ADMIN', 'NET_RAW'], drop: ['ALL'] },
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          runAsUser: 1000,
          runAsGroup: 1000,
        },
      },
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/securityContext',
        equals: {
          seccompProfile: { type: 'Unconfined' },
          appArmorProfile: { type: 'Localhost', localhostProfile: 'my-profile' },
          sysctls: [
            { name: 'net.ipv4.ip_unprivileged_port_start', value: '0' },
            { name: 'net.ipv4.tcp_syncookies', value: '1' },
          ],
          supplementalGroups: [1000, 2000],
        },
      },
      { object: 'Deployment/web', pointer: '/spec/template/spec/hostPID', equals: true },
      { object: 'Deployment/web', pointer: '/spec/template/spec/hostIPC', equals: true },
    ],
  },
  {
    id: 'T-SEC-02',
    title: 'init: true -> shareProcessNamespace: true',
    compose: `
      image: nginx:1.27
      init: true
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/shareProcessNamespace', equals: true },
  },

  // -- T-NET -----------------------------------------------------------------------------------
  {
    id: 'T-NET-01',
    title: 'two names on one IP -> one hostAliases entry with both hostnames',
    compose: `
      image: nginx:1.27
      extra_hosts:
        - "h1:10.0.0.1"
        - "h2:10.0.0.1"
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/hostAliases', equals: [{ ip: '10.0.0.1', hostnames: ['h1', 'h2'] }] },
  },
  {
    id: 'T-NET-02',
    title: 'dns_search and dns_opt -> dnsConfig.searches/options, dnsPolicy unchanged (absent)',
    compose: `
      image: nginx:1.27
      dns_search: [example.internal]
      dns_opt: ["ndots:2"]
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsConfig/searches', equals: ['example.internal'] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsConfig/options', equals: [{ name: 'ndots', value: '2' }] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsPolicy', absent: true },
    ],
  },
  {
    id: 'T-NET-03',
    title: 'dns: 1.1.1.1 -> dnsConfig.nameservers, cluster DNS stays authoritative (dnsPolicy absent, design-02)',
    compose: `
      image: nginx:1.27
      dns: 1.1.1.1
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsConfig/nameservers', equals: ['1.1.1.1'] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsPolicy', absent: true },
      { diagnostics: [{ severity: 'warning', code: 'network.dns-secondary', path: 'services.web.dns' }] },
    ],
  },
  {
    id: 'T-NET-04',
    title: 'network_mode: host -> hostNetwork, dnsPolicy ClusterFirstWithHostNet',
    compose: `
      image: nginx:1.27
      network_mode: host
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/hostNetwork', equals: true },
      { object: 'Deployment/web', pointer: '/spec/template/spec/dnsPolicy', equals: 'ClusterFirstWithHostNet' },
      { diagnostics: [{ severity: 'warning', code: 'network.host-network', path: 'services.web.network_mode' }] },
    ],
  },
  {
    id: 'T-NET-05',
    title: 'hostname: api -> spec.hostname',
    compose: `
      image: nginx:1.27
      hostname: api
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/hostname', equals: 'api' },
  },

  // -- T-STOR ----------------------------------------------------------------------------------
  {
    id: 'T-STOR-01',
    title: 'named volume -> PVC with storageClassName, accessModes, requested storage, P/volume, P/compose-volume',
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
      {
        object: 'PersistentVolumeClaim/data',
        pointer: '/spec',
        equals: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
      },
      { object: 'PersistentVolumeClaim/data', pointer: `/metadata/labels/${LABELS.volume.replace('/', '~1')}`, equals: 'data' },
      { object: 'PersistentVolumeClaim/data', pointer: `/metadata/annotations/${ANNOTATIONS.composeVolume.replace('/', '~1')}`, equals: 'data' },
    ],
  },
  {
    id: 'T-STOR-02',
    title: 'external volume -> no PVC; the pod claims the external name directly',
    compose: `
      services:
        web:
          image: nginx:1.27
          volumes:
            - data:/var/lib/data
      volumes:
        data:
          external: true
          name: legacy-data
    `,
    expect: [
      { object: 'PersistentVolumeClaim/data', absent: true },
      { object: 'PersistentVolumeClaim/legacy-data', absent: true },
      { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/persistentVolumeClaim', equals: { claimName: 'legacy-data' } },
    ],
  },
  {
    id: 'T-STOR-03a',
    title: 'bind mount, createHostPath true (default) -> hostPath carries only path (never type, design-02 5.5)',
    compose: `
      image: nginx:1.27
      volumes:
        - /srv/app:/app
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/hostPath', equals: { path: '/srv/app' } },
  },
  {
    id: 'T-STOR-03b',
    title: 'bind mount, createHostPath false -> the same hostPath shape (the warning is the only difference)',
    compose: `
      services:
        web:
          image: nginx:1.27
          volumes:
            - type: bind
              source: /srv/app
              target: /app
              bind:
                create_host_path: false
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/hostPath', equals: { path: '/srv/app' } },
      { diagnostics: [{ severity: 'warning', code: 'volumes.bind-create-host-path', path: 'services.web.volumes[0]' }] },
    ],
  },
  {
    id: 'T-STOR-04a',
    title: 'tmpfs 64m -> emptyDir Memory, sizeLimit 64Mi',
    compose: `
      image: nginx:1.27
      tmpfs:
        - /cache:size=64m
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/emptyDir', equals: { medium: 'Memory', sizeLimit: '64Mi' } },
  },
  {
    id: 'T-STOR-04b',
    title: 'shm_size 1g -> emptyDir at /dev/shm, sizeLimit 1Gi',
    compose: `
      image: nginx:1.27
      shm_size: 1g
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/volumeMounts/0/mountPath', equals: '/dev/shm' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/emptyDir', equals: { medium: 'Memory', sizeLimit: '1Gi' } },
    ],
  },
  {
    id: 'T-STOR-04c',
    title: 'anonymous volume -> emptyDir {}',
    compose: `
      image: nginx:1.27
      volumes:
        - /data
    `,
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/volumes/0/emptyDir', equals: {} },
  },
  {
    id: 'T-STOR-05',
    title: 'resource quantities are canonical: 536870912 bytes -> 512Mi, 500 millicores -> 500m',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ resources: { limits: { cpu: 500, memory: 536870912, pids: null } } })] }),
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/resources/limits/memory', equals: '512Mi' },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/resources/limits/cpu', equals: '500m' },
    ],
  },

  // -- T-META ----------------------------------------------------------------------------------
  {
    id: 'T-META-02',
    title: 'an invalid label key never reaches the pod template (already filtered by the normalizer)',
    compose: `
      image: nginx:1.27
      labels:
        "bad key!": x
        team: a
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/team', equals: 'a' },
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/bad key!', absent: true },
      { diagnostics: [{ severity: 'warning', code: 'labels.invalid-key', path: 'services.web.labels["bad key!"]' }] },
    ],
  },
  {
    id: 'T-META-03',
    title: 'com.docker.* labels are dropped silently',
    compose: `
      image: nginx:1.27
      labels:
        com.docker.compose.project: shop
        team: a
    `,
    expect: [
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/team', equals: 'a' },
      { object: 'Deployment/web', pointer: '/spec/template/metadata/annotations/com.docker.compose.project', absent: true },
    ],
  },
  {
    id: 'T-META-06',
    title: 'dnsConfig.options: declaration order kept, last value wins (K68)',
    compose: `
      image: nginx:1.27
      dns_opt:
        - "ndots:2"
        - "timeout:5"
        - "ndots:3"
    `,
    expect: {
      object: 'Deployment/web',
      pointer: '/spec/template/spec/dnsConfig/options',
      equals: [
        { name: 'ndots', value: '3' },
        { name: 'timeout', value: '5' },
      ],
    },
  },
];

runTranslateRows('translate/misc (T-WORK, T-SEC, T-NET, T-STOR, T-META)', rows);

test('T-WORK-06 a version change leaves every object byte-identical', () => {
  const before = translateRow({ id: 'v1', title: 'v1', compose: 'image: nginx:1.27', normalize: { identity: { version: '1.4.2' } }, expect: [] });
  const after = translateRow({ id: 'v2', title: 'v2', compose: 'image: nginx:1.27', normalize: { identity: { version: '1.5.0' } }, expect: [] });
  expect(before.objects.some((o) => o.kind === 'Deployment')).toBe(true);
  expect(after.objects).toEqual(before.objects);
});

test('T-WORK-08 a Job whose template changes gets a new name; an unchanged template keeps the same name', () => {
  const a = translateRow({
    id: 'job-a',
    title: 'job-a',
    compose: `
      image: nginx:1.27
      deploy:
        mode: replicated-job
    `,
    expect: [],
  });
  const aAgain = translateRow({
    id: 'job-a-again',
    title: 'job-a-again',
    compose: `
      image: nginx:1.27
      deploy:
        mode: replicated-job
    `,
    expect: [],
  });
  const b = translateRow({
    id: 'job-b',
    title: 'job-b',
    compose: `
      image: nginx:1.28
      deploy:
        mode: replicated-job
    `,
    expect: [],
  });
  const nameOf = (objects: typeof a.objects) => objects.find((o) => o.kind === 'Job')?.metadata.name;
  expect(nameOf(aAgain.objects)).toBe(nameOf(a.objects));
  expect(nameOf(b.objects)).not.toBe(nameOf(a.objects));
});

test('T-SEC-03 literals in command survive k8sExpand: echo, $(HOME), $$, cost $5', () => {
  const { objects } = translateRow({
    id: 'command-literals',
    title: 'command literals',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ process: { command: ['echo', '$(HOME)', '$$', 'cost $5'] } })] }),
    expect: [],
  });
  const deployment = objects.find((o) => o.kind === 'Deployment');
  if (deployment === undefined || deployment.kind !== 'Deployment') throw new Error('no Deployment object was produced');
  const args = deployment.spec.template.spec.containers[0].args ?? [];
  expect(k8sExpand(args, { HOME: '/root' })).toEqual(['echo', '$(HOME)', '$$', 'cost $5']);
});

test('T-META-01 every object carries the identity namespace and a registered kind', () => {
  const { objects } = translateRow({
    id: 'namespace-and-kind',
    title: 'namespace and kind',
    compose: `
      services:
        web:
          image: nginx:1.27
          ports: ["8080:80"]
          volumes:
            - data:/var/lib/data
      volumes:
        data: {}
    `,
    expect: [],
  });
  expect(objects.length).toBeGreaterThan(0);
  for (const object of objects) {
    expect(object.metadata.namespace).toBe(NAMESPACE);
    expect(Object.hasOwn(KIND_REGISTRY, object.kind)).toBe(true);
  }
});
