# kubectl, helm and metrics fixtures

Output of real `kubectl`, `helm` and metrics-server calls for the scenarios of design-07 3.11. Tests
read them only through `../../support/kubectl-fixtures.ts` (`loadKubectlFixture`, `loadKubectlList`,
`loadKubectlResources`, `loadHelmFixture`, `readHelmFixture`, `loadMetricsFixture`), never by path.
Every read first checks the whole file set of its scenario against the scrub rules below and throws
when one is broken. `../../fixtures-meta.test.ts` checks the layout, the versions and the rules.

## Status: synthetic until the test machine re-records them

The current files are **synthetic** (`"synthetic": true` in `meta.json`): authored in the exact layout
kubectl v1.36 prints, for k3s `v1.36.4+k3s1`, already scrubbed. The test machine replaces each scenario
with a recording made by `testing/e2e/k3s/tools/record-kubectl-fixtures.ts` against the `k3s-core`
lane; a recorded `meta.json` carries `"recordedOn": "YYYY-MM-DD"` instead of `synthetic`.

A first recording of all 24 scenarios (2026-09-27, k3s `v1.36.4+k3s1`) passed the scrub rules and
confirmed: pods carry `metadata.generation`, `status.observedGeneration` and
`conditions[].observedGeneration`; Deployments and ReplicaSets report `terminatingReplicas`; a
StatefulSet omits `readyReplicas` at 0; a crash-looping container, an OOM-killed one and a failing init
container are mostly reported `terminated` (reason `Error` or `OOMKilled`) between restarts rather than
`waiting` in `CrashLoopBackOff`, which the fail-fast classifier already treats as the same crash loop.
It did not replace the synthetic files yet, because the tests read the synthetic pod names and
placement, and the recipes still differ from them: Dockflow labels on some objects, the node each pod
lands on, the Job name of `job-*`, the mid-rollout capture of `daemonset-rolling`, `node-not-ready`
captured while the node is still down, and the scrub of `metrics/metrics-top.json`.

Event lists are representative subsets, not every event the cluster would emit.

## Layout

```
kubectl/<scenario>/meta.json
kubectl/<scenario>/<resource>.json            one kubectl List per captured resource
kubectl/<scenario>/<capture>/<resource>.json  later captures of the same scenario (daemonset-rolling/completed)
helm/<scenario>/meta.json
helm/<scenario>/<file>.{json,yaml,txt}        each file named by the meta.json step that captured it
metrics/<scenario>.json                       kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods
```

Every capture directory holds the same 13 files, empty Lists included:
`deployments.apps`, `statefulsets.apps`, `daemonsets.apps`, `replicasets.apps`,
`controllerrevisions.apps`, `jobs.batch`, `pods`, `events`, `persistentvolumeclaims`, `services`,
`endpointslices` (namespace `fixture-<scenario>`) and `nodes`, `persistentvolumes` (cluster).
A `FakeKubeExecutor` step answers with `{fixture: '<scenario>/<file>'}`, for example
`crashloop/pods` or `daemonset-rolling/completed/daemonsets.apps` (`splitFixtureRef`).

## Conventions of the scenarios

- Lane `duo`: nodes `server-1` (control plane, `192.0.2.11`, pods `10.42.0.x`) and `agent-1`
  (`192.0.2.12`, pods `10.42.1.x`), standing for the servers.yml keys `server_1` and `agent_1`
  (`FIXTURE_SERVERS`). Services use `10.43.x.x`.
- Objects carry the labels and annotations Dockflow renders (DESIGN-CORE 5.2, 5.3): project `shop`,
  release `1.4.2`, `dockflow.shawiizz.dev/stack` = the namespace, compose names in
  `dockflow.shawiizz.dev/compose-service` (`crashloop` uses compose service `web_app`, object `web-app`).
- Time origin: `server-1` registered at `2026-01-01T00:00:00Z`; scenarios start at `00:15:00`.

| Scenario | Condition | Used by |
|---|---|---|
| `rollout-progressing` | Deployment `web` (3 replicas) mid-rollout of revision 2, new pod not Ready yet | convergence |
| `rollout-complete` | same after completion and an unchanged re-apply; ClusterIP `web` and LoadBalancer `web-lb` | convergence, services |
| `crashloop` | `CrashLoopBackOff`, restartCount 3, last exit 1 | convergence, pods, diagnose |
| `image-pull-backoff` | `ImagePullBackOff` for `localhost:35010/e2e/missing:1` | convergence, diagnose |
| `err-image-never-pull` | `ErrImageNeverPull` for `dockflow.invalid/shop-web:1.4.2` | convergence |
| `invalid-image-name` | `InvalidImageName` for `UPPER/Case:bad tag` | convergence |
| `create-container-config-error` | `CreateContainerConfigError`, Secret `web-env` missing | convergence, diagnose |
| `oom-killed` | `CrashLoopBackOff` with `lastState.terminated.reason: OOMKilled` | convergence, pods |
| `unschedulable-resources` | `PodScheduled=False`, `Insufficient memory` | convergence, diagnose |
| `unschedulable-node-selector` | `PodScheduled=False`, node selector matches nothing | convergence |
| `pvc-pending-rwx` | RWX claim on `dockflow-local` Pending with `ProvisioningFailed`, consumer Pending | convergence |
| `progress-deadline-exceeded` | `Progressing=False`, `ProgressDeadlineExceeded` | convergence |
| `replica-failure-quota` | `ReplicaFailure=True` from a pod quota | convergence |
| `statefulset-stuck` | accessory StatefulSet `db`: `db-1` on the update revision crash looping, `db-0` current | convergence, revert plan |
| `daemonset-rolling` | DaemonSet `agent` mid-rollout; `completed/` after it | convergence |
| `job-complete` / `job-failed` | Job `Complete` / `Failed` (`BackoffLimitExceeded`) | convergence, services |
| `init-container-crash` | `Init:CrashLoopBackOff` | pods |
| `multi-container` | two containers, `kubectl.kubernetes.io/default-container: api` | pods, containers |
| `terminating-pods` | one pod Terminating (grace 300 s) next to its replacement | pods, instances |
| `evicted-pod` | pod `Failed` with reason `Evicted`, replacement Running | pods |
| `node-not-ready` | `agent-1` `Ready=Unknown` and tainted, its pod not Ready | cluster nodes, diagnose |
| `headless-no-ports` | headless `worker-hl` without ports (`"ports": null` slice), `cache-hl` with the placeholder port | services |
| `metrics-top` | app Deployment, accessory StatefulSet and a helper pod, plus `metrics/metrics-top.json` | containers stats |

| Helm scenario | Content |
|---|---|
| `helm-list` | `list` with and without `-a` (without it Helm hides pending and uninstalled releases), per role, `--filter`, empty; `get values` (map and `null`); `get manifest`; `-o name` release Secrets |
| `helm-status-failed` | a failed upgrade without `--rollback-on-failure`: list, history (revision 1 stays `deployed`), stderr |
| `helm-history-rollback` | a failed upgrade rolled back by `--rollback-on-failure`: history `superseded`, `failed`, `deployed`, stderr |

## meta.json

```json
{ "synthetic": true, "k3sVersion": "v1.36.4+k3s1", "steps": ["how the recorder reproduces the condition"] }
```

Exactly one of `synthetic: true` and `recordedOn`; helm scenarios add `helmVersion` and one step
`<file>: <command>` per captured file. `fixtures-meta.test.ts` fails when the k3s minor differs from
`K3S_PIN.version` (or the helm minor from `HELM_PIN.version`): bumping a pin to a new minor forces a
re-recording.

## Scrub rules (design-07 3.11)

Applied by the recorder before writing, checked on every read:

- `metadata.uid` -> `00000000-0000-4000-8000-<12 digits>`, one stable map per scenario, applied to
  every occurrence (owner references, `involvedObject`, labels, messages); no other UUID remains;
- timestamps -> `2026-01-01T00:00:00Z` plus the original offset from the earliest one, in UTC;
- `resourceVersion` -> sequential numbers; `managedFields` removed;
- node names -> `server-1`, `agent-1`, ...; pod IPs -> `10.42.<n>.<m>`, host IPs -> `192.0.2.<n>`;
  no other IPv4 address remains outside `10.43.0.0/16` and loopback;
- container and image IDs -> `containerd://<first 12 hex of the sha256 of the original>`;
- any string containing `E2E_SECRET_` fails the recording.

## Serialization

- `kubectl get -o json`: keys sorted at every level, 4-space indentation, `<`, `>` and `&` written as
  Go's JSON unicode escapes, trailing newline (`formatKubectlJson`).
- `helm ... -o json` and `kubectl get --raw`: compact JSON in the tool's field order, trailing newline
  (`formatCompactJson`).
- `helm get manifest`: the stored manifest followed by one extra newline.
