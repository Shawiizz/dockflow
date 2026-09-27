# kubectl, helm and metrics fixtures

Output of real `kubectl`, `helm` and metrics-server calls for the scenarios of design-07 3.11. Tests
read them only through `../../support/kubectl-fixtures.ts` (`loadKubectlFixture`, `loadKubectlList`,
`loadKubectlResources`, `fixtureCaptureTime`, `loadHelmFixture`, `readHelmFixture`,
`loadMetricsFixture`), never by path. Every read first checks the whole file set of its scenario
against the scrub rules below and throws when one is broken. `../../fixtures-meta.test.ts` checks
the layout, the versions, the rules and the condition each scenario is named after.

## Status

The kubectl and metrics scenarios are **recorded** (`"recordedOn"` in `meta.json`) on the `duo`
cluster of lane `k3s-core` by `testing/e2e/k3s/tools/record-kubectl-fixtures.ts`:

```
bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane k3s-core --all
```

Each scenario is a compose file rendered by Dockflow's own normalizer and translator and applied the
way a deploy applies it (server-side, field manager `dockflow`), so the objects carry exactly the
labels, annotations, selectors and pod template Dockflow produces. What no compose file can express
(an init container, a quota, a claim a storage class refuses) is changed on top, and the steps of
`meta.json` say so. Recording again after a change of the renderer or of the k3s pin is expected:
generated names and uids are scrubbed to stable values (below), so an unchanged scenario records the
same names.

The helm scenarios are still **synthetic** (`"synthetic": true`): authored in the exact layout
helm v4 prints, already scrubbed, until the recorder records them too.

What the recordings show that hand-written fixtures did not: pods carry `metadata.generation`,
`status.observedGeneration` and `conditions[].observedGeneration`; Deployments and ReplicaSets
report `terminatingReplicas`; a StatefulSet omits `readyReplicas` at 0; and a crash-looping
container, an OOM-killed one or a failing init container is mostly reported `terminated` (reason
`Error` or `OOMKilled`) between its restarts rather than `waiting` in `CrashLoopBackOff`.

Event lists hold what the namespace had at capture time, minus the events of an earlier incarnation
of a recreated object.

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
`endpointslices` (namespace `fixture-<scenario>`) and `nodes`, `persistentvolumes` (cluster), read
in one `kubectl get` per scope. A `FakeKubeExecutor` step answers with `{fixture: '<scenario>/<file>'}`,
for example `crashloop/pods` or `daemonset-rolling/completed/daemonsets.apps` (`splitFixtureRef`).

## Conventions of the scenarios

- Lane `duo`: nodes `server-1` (control plane, `192.0.2.11`, pods `10.42.0.x`) and `agent-1`
  (`192.0.2.12`, pods `10.42.1.x`), standing for the servers.yml keys `server_1` and `agent_1`
  (`FIXTURE_SERVERS`). Services use `10.43.x.x`.
- Project `shop`, release `1.4.2`, environment `production`, rendered into namespace
  `fixture-<scenario>`, which is also the `dockflow.shawiizz.dev/stack` value. Compose names are in
  `dockflow.shawiizz.dev/compose-service` (`crashloop` uses compose service `web_app`, object `web-app`).
- Single-pod scenarios pin their pod with `deploy.placement.constraints: node.hostname == <server>`,
  so a new recording puts it on the same node.
- Time origin: `server-1` registered at `2026-01-01T00:00:00Z`; a scenario starts when it was
  recorded, some minutes later. `fixtureCaptureTime(scenario, capture)` is the newest timestamp of a
  capture, the `now` of a test that reads ages.

| Scenario | Condition | Used by |
|---|---|---|
| `rollout-progressing` | Deployment `web` (3 replicas) mid-rollout of revision 2, the new pod not Ready yet | convergence, pods |
| `rollout-complete` | same after completion and an unchanged re-apply; ClusterIP `web` and LoadBalancer `web-lb` | convergence, services, health |
| `crashloop` | container restarted 3 times, last exit 1 | convergence, pods, diagnose |
| `image-pull-backoff` | `ImagePullBackOff` for `localhost:35010/e2e/missing:1` | convergence, diagnose |
| `err-image-never-pull` | `ErrImageNeverPull` for the built image `dockflow.invalid/shop-web:1.4.2` with `pull_policy: never` | convergence, diagnose |
| `invalid-image-name` | `InvalidImageName` for `UPPER/Case:bad tag` | convergence |
| `create-container-config-error` | `CreateContainerConfigError`, the env Secret of `web` missing | convergence, diagnose |
| `oom-killed` | container OOM-killed twice (16Mi limit) | convergence, pods |
| `unschedulable-resources` | `PodScheduled=False`, `Insufficient memory` | convergence, diagnose |
| `unschedulable-node-selector` | `PodScheduled=False`, node selector matches nothing | convergence |
| `pvc-pending-rwx` | RWX claim on `dockflow-local` Pending with `ProvisioningFailed`, consumer Pending | convergence, diagnose |
| `progress-deadline-exceeded` | `Progressing=False`, `ProgressDeadlineExceeded` | convergence |
| `replica-failure-quota` | `ReplicaFailure=True` from a pod quota | convergence |
| `statefulset-stuck` | accessory StatefulSet `db`: `db-1` on the update revision crash looping, `db-0` current | convergence, revert plan |
| `daemonset-rolling` | DaemonSet `agent` mid-rollout; `completed/` after it | convergence |
| `job-complete` / `job-failed` | Job `Complete` / `Failed` (`BackoffLimitExceeded`) | convergence, services |
| `init-container-crash` | init container restarted 3 times | pods |
| `multi-container` | two containers, `kubectl.kubernetes.io/default-container: api` | pods, containers |
| `terminating-pods` | one pod Terminating (grace 300 s) next to its replacement | pods, instances |
| `evicted-pod` | pod `Failed` with reason `Evicted`, replacement Running (it fills its storage too: its own eviction is already in the events) | pods, diagnose |
| `node-not-ready` | `agent-1` `Ready=Unknown` and tainted, captured while it is down | cluster nodes, diagnose |
| `headless-no-ports` | headless `worker` without ports (trait off), headless `cache` with the placeholder port | services |
| `metrics-top` | app Deployment, accessory StatefulSet and a backup helper pod, plus `metrics/metrics-top.json` | containers stats |

| Helm scenario | Content |
|---|---|
| `helm-list` | `list` with and without `-a` (without it Helm hides pending and uninstalled releases), per role, `--filter`, empty; `get values` (map and `null`); `get manifest`; `-o name` release Secrets |
| `helm-status-failed` | a failed upgrade without `--rollback-on-failure`: list, history (revision 1 stays `deployed`), stderr |
| `helm-history-rollback` | a failed upgrade rolled back by `--rollback-on-failure`: history `superseded`, `failed`, `deployed`, stderr |

## meta.json

```json
{ "recordedOn": "2026-09-27", "k3sVersion": "v1.36.4+k3s1", "steps": ["how the recorder reproduces the condition"] }
```

Exactly one of `synthetic: true` and `recordedOn`; helm scenarios add `helmVersion` and one step
`<file>: <command>` per captured file. `fixtures-meta.test.ts` fails when the k3s minor differs from
`K3S_PIN.version` (or the helm minor from `HELM_PIN.version`): bumping a pin to a new minor forces a
re-recording.

## Scrub rules (design-07 3.11)

Applied by the recorder before writing, with one set of maps for every capture of a scenario and
its metrics read, checked on every read:

- `metadata.uid` -> `00000000-0000-4000-8000-<12 digits>`, handed out in resource order and by
  name, applied to every occurrence (owner references, `involvedObject`, labels, messages); no other
  UUID remains;
- generated names (a `generateName` followed by the 5 random characters the API server adds) ->
  the same prefix with 5 characters derived from the scenario and the creation order, in every text;
- timestamps -> `2026-01-01T00:00:00Z` plus the original offset from the earliest one, in UTC;
- `resourceVersion` -> sequential numbers; `managedFields` removed;
- node names -> `server-1`, `agent-1`, ...; pod IPs -> `10.42.<n>.<m>`, host IPs -> `192.0.2.<n>`;
  no other IPv4 address remains outside `10.43.0.0/16` and loopback;
- container and image IDs -> `containerd://<first 12 hex of the sha256 of the original>`; the
  machine ID and kernel version of a node are replaced;
- any string containing `E2E_SECRET_` fails the recording.

## Serialization

- `kubectl get -o json`: keys sorted at every level, 4-space indentation, `<`, `>` and `&` written as
  Go's JSON unicode escapes, trailing newline (`formatKubectlJson`); items in name order.
- `helm ... -o json` and `kubectl get --raw`: compact JSON in the tool's field order, trailing newline
  (`formatCompactJson`).
- `helm get manifest`: the stored manifest followed by one extra newline.
