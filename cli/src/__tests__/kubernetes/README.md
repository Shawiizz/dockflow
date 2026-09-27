# Kubernetes test suite

Unit and component tests of the Kubernetes (k3s) orchestrator. Everything here runs offline: no
cluster, no SSH, no Docker, no network. The e2e suite that talks to real k3s nodes lives in
`testing/e2e/k3s/`.

## Running

```bash
cd cli
bun test src/__tests__/kubernetes                    # the whole Kubernetes suite
bun test src/__tests__/kubernetes/fakes              # one directory
bun test src/__tests__/kubernetes/golden.test.ts     # golden cases only
bun test src/                                        # everything, as CI runs it

# property tests: more runs, or replay one seed from a failure message
DOCKFLOW_PROPERTY_RUNS=5000 DOCKFLOW_PROPERTY_SEED=42 bun test src/__tests__/kubernetes/property

# coverage gate
bun test src/ --coverage --coverage-reporter=lcov && bun run scripts/check-coverage.ts
```

No test uses real time or `mock.module`: every wait goes through `FakeClock`, every remote call
through one of the fakes below. `.skip`, `.only` and `test.todo` are refused by the architecture
test.

## The harness

There is exactly one harness. A test that needs a behaviour it lacks extends the fake here instead
of writing a private one.

| Fake | File | Stands in for | Used by |
|---|---|---|---|
| `FakeClock` | `fakes/fake-clock.ts` | `Clock` | every polling test |
| `FakeSsh` | `fakes/fake-ssh.ts` | the SSH transport under `runtime/*` | `runtime/*.test.ts`, target resolution |
| `FakeKubeExecutor` | `fakes/fake-kube-executor.ts` | `KubeExecutor` | backends, stores, apply, setup |
| `FakeCluster` | `fakes/fake-cluster.ts` | an API server behind `FakeKubeExecutor` (cluster mode) | convergence, stores, day-2 |
| `FakeHelmExecutor` | `fakes/fake-helm-executor.ts` | `HelmExecutor` (the real `HelmBackend` always runs) | Helm and proxy backends, flows |
| `FakeNodeShell` | `fakes/fake-node-shell.ts` | the `nodeShell` factory, one `NodeShell` per node | images, backup relays, host commands |
| `FakeOrchestrator` | `fakes/fake-orchestrator.ts` | a whole `Orchestrator` bundle | `flow/*`, `commands/*`, `api/*` |

`FakeLocalEngine`, `FakeHostRunner`, `FakeSetupTransport` and `FakeHostKeys` join the table with
the packages that need them (images, setup).

### Script mode and cluster mode

`FakeKubeExecutor` matches each call against `KubeStep` rows, in strict order by default:

```ts
const kube = new FakeKubeExecutor({
  redactor,
  script: [
    { id: 'K07', args: ['get', 'deployments.apps,statefulsets.apps', '-l', ANY, '-o', 'json'], respond: { fixture: 'rollout-complete/deployments.apps' } },
    { id: 'K11', args: ['apply', REST], stdin: /kind: Deployment/, respond: { exitCode: 0, stdout: '', stderr: '' } },
    { args: ['delete', 'pod/web-0', REST], respond: { error: 'NotFound' } },
  ],
});
// ... exercise the backend ...
kube.assertDone();
```

`ANY` matches one argument, `REST` the remaining ones; a `RegExp` matches one argument. `respond`
takes a `KubectlResult`, a function, `{json}`, `{fixture: '<scenario>/<file>'}`, `{error: <reason>}`
(a recorded stderr from `fixtures/kubectl-stderr/` that the real classifier maps to that reason),
`{transportError: true}` or `{hang: true}`. An unmatched call throws `Unexpected kubectl call` with
the rendered command and the three closest steps. With `cluster`, calls no row matches are served
by `FakeCluster`; rows still match first, which is how faults are injected.

Every call is recorded with the command string the real builder of `runtime/kubectl.ts` produces,
so tests assert exact command shapes with `expectCommandShape` (`support/matchers.ts`).

### Invariants

Every `backends/*`, `stores/*`, `apply/{engine,prune,revert}`, `setup/k3s/*` and `runtime/*` file
checks the executor hygiene after each test:

```ts
afterEach(() => assertExecutorInvariants({ kube, helm, nodeShell, redactor }));
```

`support/invariants.ts` implements INV-01..INV-12 of design-07 3.9 with their closed exception
sets (mutating flags, no secret in argv, no namespace deletion, the volume deletion protocol, schema
validation of every stdin manifest, the three field managers, `-o json` reads, Helm values on stdin,
the kubeconfig and Helm environment, no command output in logs, helper pods deleted). It also fails
when a fake was constructed but never `assertDone()`d. Only volume tests pass
`allow: {volumeDeletion: true}`. `assertNoSecretLeak(recorder, secrets)` checks printed output,
errors, plain objects such as a serialized setup report, and what a fake recorded (stdin exempt).

### Flow and command tests

`FakeOrchestrator` logs `stack.render:app`, `releases.create:1.2.0`, `stack.deploy:accessory`,
`lock.release`, ... in call order (`events`), records arguments (`calls`, `callsTo`), and returns
healthy defaults unless a test programs a method:

```ts
const orchestrator = new FakeOrchestrator('k3s');
orchestrator.program('stack.waitConvergence', { status: 'failed', failures: [failure] });
orchestrator.programOnce('releases.remove', new Error('lost'));
orchestrator.forbidRemoteWork(); // any remote call now throws `SSH touched`
```

Releases and locks are in-memory models (`seedRelease`, `storedReleases`, `lockHolder`).

## Golden cases

`golden/<case>/` holds `docker-compose.yml`, optional `accessories.yml`, `files/`, `input.json` and
the expected outputs (`expected-app.yaml`, `expected-accessory.yaml`, `expected-helm.json`,
`expected-diagnostics.json`). The only way to rewrite expectations is the update script, which
refuses to run in CI:

```bash
bun run scripts/update-golden.ts                               # every case
bun run scripts/update-golden.ts ports-long-syntax kitchen-sink  # selected cases
```

Review the diff before committing: a golden change is a change of what Dockflow sends to clusters.

## Adding rows

Normalizer rows live in `normalize/rows/<module>.rows.test.ts` and run through the full pipeline
with `runNormalizeRows` (`support/rows.ts`); translator rows live in
`translate/rows/<module>.rows.test.ts` with `runTranslateRows`. A row names its id (`N-PORT-07`,
`T-STOR-05`), a compose body (the body of service `web` unless it starts with `services:`) and its
expectations: JSON pointers into the canonical model or the rendered objects, and diagnostics as
`{severity, code, path}`. Unless a row says `exact: true`, extra `info` diagnostics are tolerated and
extra warnings or errors fail it. Every rendered object is validated against the vendored schemas
(`support/schema/`) and the semantic rules.

## Recorded fixtures

`fixtures/kubectl/<scenario>/` holds `kubectl get -o json` Lists in the exact layout of the pinned
kubectl, scrubbed (uids, timestamps, resource versions, node names, IPs, container ids); `meta.json`
names the k3s version and the steps that reproduce the condition. `fixtures-meta.test.ts` fails when
a scenario's k3s minor differs from the pin or when a scrub rule is broken. Helm outputs live in
`fixtures/helm/<scenario>/`, metrics bodies in `fixtures/metrics/`, and at least two recorded stderr
samples per `KubeErrorReason` in `fixtures/kubectl-stderr/<reason>/`.

To re-record against a running lane cluster:

```bash
bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane k3s-core --scenario crashloop
bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane k3s-core --all
```

Re-record after each k3s minor bump. Never inline a recorded payload in a test: load it with
`support/kubectl-fixtures.ts` or the `{fixture}` response of `FakeKubeExecutor`.
