# E2E Tests

Three independent suites. Each owns its cluster lifecycle and can run in isolation (CI runs them as
parallel jobs); the k3s suite is itself split into lanes, each with its own topology.

```
e2e/
  swarm/          # 2-node Docker-in-Docker Swarm (compose project: dockflow-swarm)
    bunfig.toml   #   preload: setup.ts (build CLI, reset cluster, pre-deploy test-app)
    tests/        #   01-build … 09-registry
  k3s/            # k3s-in-Docker, one project per lane (dockflow-k3s / dockflow-k3s-setup)
    bunfig.toml   #   preload: setup.ts (prepareLane — binaries, node image, charts, cluster)
    lanes.ts      #   lane -> topology, test directory, time budget, failure mode
    run.ts        #   `bun run run.ts <lane>` — the lane runner (see Lanes, below)
    setup.ts      #   prepareLane() + the bunfig preload that calls it
    images.lock.json, tools/  # pinned image digests; download/image/chart/binary preparation
    tests/
      core/       #   k3s-core      (duo)   30 render-contract … 36 security-nondestructive
      lifecycle/  #   k3s-lifecycle (duo)   34 accessories-volumes
      rollback/   #   k3s-rollback  (duo)   35 rollback-failures
      day2/       #   k3s-day2      (duo)   37 day2 … 39 backup
      multinode/  #   k3s-multinode (trio)  40 distribution … 45 refusals
      proxy-helm/ #   k3s-proxy-helm (duo)  50 proxy … 53 helm-only
      ha/         #   k3s-ha        (ha)    60 ha-topology … 62 concurrency
      setup/      #   k3s-setup (fresh containers per file) 70 setup-single-host … 77 identity-recovery
      nightly/    #   nightly (each file provisions its own infrastructure) 80 arm64-smoke … 85 soak
  setup/          # bare-metal host provisioning on a clean ubuntu container (unrelated to k3s)
    bunfig.toml   #   preload: setup.ts (cross-compile the Linux binary)
    tests/        #   20-setup, 21-init
  helpers/        # shared: CLI runner, cluster/topology lifecycle, fixtures, k8s/helm assertions,
                  # leak watcher, debug dumps
  fixtures/       # READ-ONLY templates — never written to by tests
    acme/         #   Pebble ACME test CA + config (K49: no e2e run ever talks to Let's Encrypt)
    charts/       #   e2e-web, e2e-pvc, e2e-broken, e2e-crd chart sources
    keys/         #   test-only SSH keys: id_ed25519 (deploy user), bootstrap_ed25519 (root, setup only)
    test-app-k3s-cluster/  # config.yml only — used by the lane preload's own `dockflow setup k3s`
  docker/         # node image, compose file and per-node config for the k3s topologies
  teardown.ts     # stops every test cluster (Swarm, both k3s projects, the setup-suite container)
```

## Running

```bash
# Swarm and the bare-metal setup suite: unchanged
cd testing/e2e/swarm && bun test tests/
cd testing/e2e/setup && bun test tests/

# k3s: through its lane runner, never `bun test tests/` directly (lanes need a provisioned cluster
# and a fixed file order; see Lanes below)
cd testing/e2e/k3s && bun run run.ts k3s-core

bun run testing/e2e/teardown.ts   # stop every test cluster
```

### Preparing the k3s suite (Linux / WSL2 with Docker Engine, cgroup v2)

```bash
cd cli && bun install
bun run testing/e2e/k3s/tools/prepare-downloads.ts
bun run testing/e2e/k3s/tools/prepare-images.ts --arch amd64
bun run testing/e2e/k3s/tools/build-node-image.ts
cd testing/e2e/k3s && bun run run.ts k3s-core
DOCKFLOW_E2E_REUSE=1 bun run run.ts k3s-core                 # keep and reuse the provisioned cluster
DOCKFLOW_E2E_LANE=k3s-core bun test tests/core/31-deploy-basic.test.ts  # one file, already-prepared lane
bun run ../teardown.ts
```

Windows and macOS with Docker Desktop: the `duo`-topology lanes work (privileged containers + cgroup
v2 inside the Docker Desktop VM); the preload cross-builds `dockflow-linux-x64` for the hidden
`--binary` flag when the host is not already linux-x64. The `ha` and `k3s-setup` lanes are Linux-only
(kernel modules, tmpfs etcd, ufw) and are documented, not enforced, as such.

`DOCKFLOW_E2E_BINARY=<path>` overrides the locally built CLI everywhere (Swarm, k3s and setup) with a
specific binary — CI points it at the release artifact under test, so the gate tests exactly what gets
published; `dockflow setup k3s`'s hidden `--binary` ships that same Linux binary to the nodes.

## Lanes (k3s)

`k3s/lanes.ts` maps each lane to a topology, its test directory and a time budget. `run.ts <lane>`:

1. prepares the lane once — binaries, the node image, the e2e charts and, for a lane with a shared
   topology, a freshly provisioned cluster (`dockflow setup k3s e2e`, exactly as an operator runs it;
   `DOCKFLOW_E2E_REUSE=1` reuses an already-healthy one instead);
2. runs `<dir>/*.test.ts` in file-name order (never bun's inode order), each in its own `bun test`
   process, with a leak watcher for `E2E_SECRET_` around it;
3. on a shared-cluster lane (`k3s-core`, `k3s-lifecycle`, `k3s-rollback`, `k3s-day2`, `k3s-multinode`,
   `k3s-proxy-helm`, `k3s-ha`), stops at the **first failing file**: a broken shared cluster produces
   one honest failure and one debug dump instead of a cascade of unrelated failures in the files after
   it. The `k3s-setup` lane gives every file fresh containers of its own, so it always runs every file.

| Lane | Topology | Nodes | Directory | Budget |
|---|---|---|---|---|
| `k3s-core` | duo | server-1, agent-1 | `tests/core` | 25 min |
| `k3s-lifecycle` | duo | server-1, agent-1 | `tests/lifecycle` | 12 min |
| `k3s-rollback` | duo | server-1, agent-1 | `tests/rollback` | 35 min |
| `k3s-day2` | duo | server-1, agent-1 | `tests/day2` | 25 min |
| `k3s-multinode` | trio | server-1, agent-1, agent-2 | `tests/multinode` | 25 min |
| `k3s-proxy-helm` | duo | server-1, agent-1 | `tests/proxy-helm` | 28 min |
| `k3s-ha` | ha | server-1..3, agent-1 | `tests/ha` | 25 min |
| `k3s-setup` | fresh per file | one-off | `tests/setup` | 45 min |
| `nightly` | fresh per file | one-off | `tests/nightly` | 60 min |

## Conventions

**Fixtures are immutable templates.** Tests never write inside `fixtures/`. Use `makeFixture(name,
opts)` from `helpers/fixtures.ts` to get a throwaway temp copy — for k3s, pass `{cluster: 'k3s'}` (and
optionally `topology`) to have `servers.yml`/`.env.dockflow` generated for the running lane — and call
`fixture.cleanup()` in `afterAll`.

**No file in a shared-cluster lane damages cluster-level state.** The kubeconfig, the k3s service, the
deploy identity, `dockflow-system`, the StorageClass, the sudoers file and the node set stay untouched
by every k3s-core/lifecycle/rollback/day2/multinode/proxy-helm test — the lane preload installs a guard
(`helpers/cluster.ts`) that fails a test calling `nodeExec`/harness `kubectl delete` in a way that
would break them. A scenario that needs one of those broken belongs in `k3s-setup`, whose files get
their own containers. The `ha` lane's one exception is node availability (its whole subject): use
`withNodeDown(node, how, fn)` from `helpers/k8s.ts`, never a raw `systemctl stop k3s` — it restores the
node and waits for `/readyz` and every node Ready before returning.

**Harness kubectl/helm are cluster-admin, never Dockflow's own identity.** `helpers/k8s.ts`'s
`kubectl`/`helm`/`getJson` run through k3s's own bundled admin kubeconfig via `docker exec`, so
assertions can see and clean up anything regardless of what RBAC Dockflow's `dockflow-deployer`
service account has. `deleteStackCompletely(ns)` is how a file cleans up after itself (Dockflow itself
never deletes namespaces): it deletes the namespace and every `Retain` PV (and its host directory) the
namespace's claims left behind, keeping e2e disk usage flat.

**Debug dumps on failure.** A failing test's own `afterEach` calls `dumpDebug('<file>:<test name>')`
(`helpers/debug-dump.ts`) once per file; `run.ts` also dumps under `<file>` as a fallback for what that
cannot cover (a crashed process, a timeout, a leak the lane-level watcher found). Everything lands
under `.artifacts/<lane>/<label>/`, scrubbed of `E2E_SECRET_*` values.

**Fixture secrets are named `E2E_SECRET_<PURPOSE>_7f3a9c`** so the leak watcher (`/proc` cmdlines on
every node, `helpers/leak-watch.ts`) and debug dumps can find them if a real command line, a Secret
data field printed unmasked, or a log line ever carries one.

**Ports are statically allocated** (`helpers/topology.ts`, `helpers/connection.ts`):

| | Address from the runner | Address from a node |
|---|---|---|
| Swarm manager / worker | `localhost:32222` / `:32223` | — |
| k3s shared-lane nodes (duo: server-1, agent-1; trio adds agent-2; ha adds server-2/3) | `localhost:32230`-`32234` | `10.197.30.11`-`.22` |
| k3s setup-lane nodes (fresh per file) | `localhost:32240`-`32249` | `10.197.31.11`-`.49` |
| e2e registry (anonymous / authenticated) | `localhost:35010` / `:35011` | same `localhost:*` (socat forwarder baked into the node image) |
| e2e chart repository (`/public`, `/private`) | `localhost:35012` | `http://10.197.30.7:8080/{public,private}` |
| Swarm registry, Traefik HTTP | `localhost:35000`, `:38080` | — |

The Swarm and k3s suites use separate compose projects and networks and can run simultaneously.

The k3s lane subnets (`10.197.30.0/24` shared, `10.197.31.0/24` setup) sit outside Docker's default
address pools, so they do not collide with the networks of other compose projects on the machine.
When a VPN or LAN already routes them, set `DOCKFLOW_E2E_NET` / `DOCKFLOW_E2E_SETUP_NET` to the first
three octets of another /24 (fixtures write `@E2E_NET@` wherever they need a lane address).

**The e2e registries** (`registry:3`, anonymous and htpasswd-authenticated) run as auxiliary
containers on the lane network; a socat forwarder unit baked into every node image republishes them on
`127.0.0.1:35010`/`:35011` inside each node, so the single image name `localhost:35010/...` (or
`:35011`) resolves from the runner (push) and from every node (pull) with no `registries.yaml` —
containerd's CRI treats `localhost` hosts as plain HTTP, and the host Docker treats `localhost` as
insecure. Registry-mode fixtures use `registry: {type: custom, url: localhost:35010}` (or `:35011`
with credentials for the authenticated one).

**Chart repositories** (`fixtures/charts/`, `k3s/tools/package-charts.ts`): `e2e-web` (0.1.0/0.2.0),
`e2e-pvc`, `e2e-broken` and `e2e-crd` are packaged with the harness helm baked into the node image
and indexed into `.cache/charts/{public,private}`, served by the `charts` auxiliary container.
`/public` is plain HTTP on purpose (an `http://` repository is accepted with a warning). `/private`
needs basic auth and is HTTPS only, since Dockflow never sends a repository password over `http://`.

**A throwaway test CA** (`.cache/tls/ca.pem`), generated by the harness on first use, issues the
certificates of Pebble's ACME API and of the private chart repository, each valid for its address on
every lane network; every node trusts it, as a company's hosts trust an internal CA.

**ACME never talks to Let's Encrypt in CI** (K49): the `acme` auxiliary container runs Pebble
(`fixtures/acme/pebble-config.json`); projects point `proxy.acme_ca_server` at it and
`proxy.acme_ca_bundle` at the test CA. Only the manual real-machine checklist (design-07 21) uses
Let's Encrypt production, with a staging rehearsal first.
