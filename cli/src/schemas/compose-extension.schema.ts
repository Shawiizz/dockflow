/**
 * Schema of the `x-dockflow` compose extension (DESIGN-CORE 3 and 7.3, design-01 8.1): the
 * Kubernetes-only settings of a service (`services.<name>.x-dockflow`) and of a top-level volume
 * (`volumes.<name>.x-dockflow`). Strict: an unknown key is an error, never ignored (D3).
 * `normalize/extension.ts` is the only consumer; the `.describe()` texts feed the x-dockflow
 * reference of the documentation.
 */

import { z } from 'zod';
import { DOCKFLOW_K8S_PREFIX } from '../services/orchestrator/kubernetes/constants';
import { DNS_SUBDOMAIN_RE, LABEL_KEY_RE, LABEL_VALUE_RE } from '../services/orchestrator/kubernetes/model/units';

const STORAGE_SIZE_RE = /^[1-9][0-9]*(Ki|Mi|Gi|Ti)$/;
const HTTP_PATH_RE = /^\/[\x21-\x7e]*$/;

/** DNS prefix (<= 253) + `/` + name (<= 63) */
const LABEL_KEY_MAX = 317;
const LABEL_PREFIX_MAX = 253;

const labelKey = z
  .string()
  .max(LABEL_KEY_MAX)
  .regex(LABEL_KEY_RE, 'must be a Kubernetes label key: an optional DNS prefix and "/", then at most 63 letters, digits, "-", "_" or "."')
  .refine((k) => !k.includes('/') || k.indexOf('/') <= LABEL_PREFIX_MAX, 'the prefix must be at most 253 characters');

const labelValue = z
  .string()
  .max(63)
  .regex(LABEL_VALUE_RE, 'must be a Kubernetes label value: at most 63 letters, digits, "-", "_" or ".", starting and ending with a letter or digit');

const port = z.number().int().min(1).max(65535);

export const ProbeOverrideSchema = z
  .object({
    use: z
      .enum(['both', 'readiness', 'liveness', 'none'])
      .optional()
      .describe('Which Kubernetes probes the check produces: `both` (the default), `readiness`, `liveness` or `none`.'),
    http: z
      .object({
        path: z.string().regex(HTTP_PATH_RE, 'must start with "/" and contain no spaces').describe('Request path, starting with `/`.'),
        port: port.describe('Container port the request is sent to.'),
        scheme: z.enum(['HTTP', 'HTTPS']).optional().describe('`HTTP` (the default) or `HTTPS`.'),
      })
      .strict()
      .optional()
      .describe('HTTP GET check used instead of the healthcheck command, with the healthcheck timings.'),
    tcp: z
      .object({ port: port.describe('Container port the connection is opened to.') })
      .strict()
      .optional()
      .describe('TCP connection check used instead of the healthcheck command, with the healthcheck timings; exclusive with `http`.'),
  })
  .strict()
  .refine((p) => !(p.http && p.tcp), { message: 'set http or tcp, not both', path: ['tcp'] });

export const TolerationSchema = z
  .object({
    key: labelKey.optional().describe('Taint key the toleration matches; absent matches every key (requires `operator: Exists`).'),
    operator: z.enum(['Equal', 'Exists']).optional().describe('`Equal` (the default) compares `value`; `Exists` matches any value.'),
    value: labelValue.optional().describe('Taint value compared with `operator: Equal`.'),
    effect: z
      .enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute'])
      .optional()
      .describe('Taint effect the toleration matches; absent matches every effect.'),
    toleration_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('How long a pod stays on a node after a `NoExecute` taint appears; requires `effect: NoExecute`.'),
  })
  .strict()
  .superRefine((t, ctx) => {
    const operator = t.operator ?? 'Equal';
    if (operator === 'Exists' && t.value !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'must not be set when operator is Exists' });
    }
    if (t.key === undefined && operator !== 'Exists') {
      ctx.addIssue({ code: 'custom', path: ['operator'], message: 'must be Exists when key is not set' });
    }
    if (t.toleration_seconds !== undefined && t.effect !== 'NoExecute') {
      ctx.addIssue({ code: 'custom', path: ['toleration_seconds'], message: 'requires effect: NoExecute' });
    }
  });

const podLabelKey = labelKey.refine(
  (k) => !k.startsWith(`${DOCKFLOW_K8S_PREFIX}/`) && !k.startsWith('app.kubernetes.io/'),
  `must not use the reserved prefixes ${DOCKFLOW_K8S_PREFIX}/ and app.kubernetes.io/`,
);

export const ServiceExtensionSchema = z
  .object({
    kind: z
      .enum(['deployment', 'statefulset'])
      .optional()
      .describe(
        'Workload of a replicated service: `deployment` (the default) or `statefulset` (stable pod names, and one claim per replica for `per_replica` volumes).',
      ),
    publish: z
      .enum(['loadbalancer', 'hostport', 'none'])
      .optional()
      .describe(
        'Exposure of the published ports: `loadbalancer` (the default: reachable on every node like the Swarm routing mesh), `hostport` (only on the node running the pod) or `none` (inside the cluster only).',
      ),
    lb_source_ranges: z
      .array(z.union([z.cidrv4(), z.cidrv6()]))
      .optional()
      .describe('CIDR ranges allowed to reach the published ports through the load balancer; absent or empty allows every source.'),
    probes: ProbeOverrideSchema.optional().describe(
      'Which probes the healthcheck becomes, or an HTTP or TCP check used instead of its command.',
    ),
    node_selector: z
      .record(labelKey, labelValue)
      .optional()
      .describe('Node labels (servers.yml `node_labels`) a node must carry to run the pods.'),
    tolerations: z.array(TolerationSchema).optional().describe('Node taints the pods tolerate.'),
    fs_group: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .optional()
      .describe('Group that owns the files of mounted volumes; they are re-owned only when the volume root does not match.'),
    pod_labels: z
      .record(podLabelKey, labelValue)
      .optional()
      .describe(`Extra labels on the pods, never part of the selector; the ${DOCKFLOW_K8S_PREFIX}/ and app.kubernetes.io/ prefixes are reserved.`),
  })
  .strict()
  .describe('Kubernetes settings of a service (`services.<name>.x-dockflow`).');

export const VolumeExtensionSchema = z
  .object({
    size: z
      .string()
      .regex(STORAGE_SIZE_RE, 'must be a whole number followed by Ki, Mi, Gi or Ti, for example 10Gi')
      .optional()
      .describe('Requested capacity of the claim, such as `10Gi` (default `1Gi`).'),
    storage_class: z
      .string()
      .max(253)
      .regex(DNS_SUBDOMAIN_RE, 'must be a lowercase DNS name')
      .optional()
      .describe("Storage class of the claim (default: the distribution's class, `dockflow-local` on k3s)."),
    access_mode: z
      .enum(['ReadWriteOnce', 'ReadWriteOncePod', 'ReadWriteMany'])
      .optional()
      .describe(
        'Access mode of the claim: `ReadWriteOnce` (the default), `ReadWriteOncePod` or `ReadWriteMany`; on an external volume, the mode of the existing claim.',
      ),
    per_replica: z
      .boolean()
      .optional()
      .describe('One claim per replica, created from the claim templates of a StatefulSet; every service mounting the volume needs `x-dockflow.kind: statefulset`.'),
  })
  .strict()
  .describe('Kubernetes settings of a top-level volume (`volumes.<name>.x-dockflow`).');

export type ServiceExtensionInput = z.infer<typeof ServiceExtensionSchema>;
export type VolumeExtensionInput = z.infer<typeof VolumeExtensionSchema>;
