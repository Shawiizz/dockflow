# Developer Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime (CLI)
- [Node.js](https://nodejs.org/) 22+ (WebUI)
- [pnpm](https://pnpm.io/) (WebUI and docs)
- Docker Desktop with WSL integration enabled
- WSL2 (required for E2E tests)

---

## CLI Development

### Running locally

```bash
# From the project root
bun cli/src/index.ts <command> [args]

# Examples
bun cli/src/index.ts deploy staging
bun cli/src/index.ts status production
```

### Dev script

The `dev.ts` script runs the CLI from local source (`DOCKFLOW_DEV_PATH`) instead of an installed
binary. It also auto-appends `--dev` for `deploy`/`build`/`ui` — today this only has an effect on
`setup`/`setup k3s`, where `--dev` uploads the **locally built** CLI binary to the target host instead
of downloading a tagged release; `deploy`, `build` and `ui` do not register that flag, so passing it to
one of them fails with `unknown option '--dev'` rather than doing anything. Run it from your **target
project directory**:

```bash
cd /path/to/my-app

# Run dockflow commands using local source
bun /path/to/dockflow/cli/scripts/dev.ts deploy production --force
```

Recommended: create an alias:

```bash
# ~/.bashrc or ~/.zshrc
alias dockflow-dev='bun /path/to/dockflow/cli/scripts/dev.ts'
```

### Typechecking

```bash
cd cli
bun run typecheck   # must pass with zero errors before committing
```

### WebUI (hot-reload)

The UI proxies to the CLI's API server. You need two terminals:

```bash
# Terminal 1 — Angular dev server
cd cli/ui && pnpm install && pnpm start   # port 4201

# Terminal 2 — CLI API server
cd cli && bun run dev ui                  # port 4200, proxies to 4201
```

Open `http://localhost:4200`. The `--dev` flag (added automatically by `bun run dev`) makes the API proxy non-`/api/` requests to the Angular server.

---

## How Deploy Works (important for contributors)

When you run `dockflow deploy`, the CLI connects directly to servers via SSH (using the `ssh2` library),
on both orchestrators. All deploy operations — template rendering, image building/distribution, the
Swarm stack deploy or the k3s render + server-side apply, health checks — happen in TypeScript over SSH
or the Kubernetes API reached through it. No Docker containers, and no Ansible, are involved anywhere in
the deploy flow, or in `dockflow setup`: host provisioning (Docker/k3s install, the deploy user, the
firewall) is pure TypeScript too (`commands/setup/provision.ts`, `commands/setup/k3s/`), shipped by
copying the cross-compiled Linux binary to the target and re-executing it there. Nothing in this
codebase shells out to Ansible; there is no `ansible/` directory.

This matters most when working on E2E tests, which exercise this exact path against real Docker
containers standing in for real servers. See the E2E section below.

---

## E2E Tests

> **Run from WSL only** — not PowerShell or CMD. The k3s suite additionally needs cgroup v2 (its nodes
> run systemd as PID 1 inside the container).

There are three independent suites under `testing/e2e/` — see `testing/e2e/README.md` for the
authoritative layout, and `CLAUDE.md`'s *E2E Tests* section for what each k3s lane covers.

### Prerequisites

```bash
sudo apt install sshpass jq
```

Docker Desktop must be running with WSL integration enabled. The k3s suite needs a one-time
preparation step before its first run (pinned downloads, the node image, chart sources — see
`testing/e2e/README.md`).

### Running the tests

```bash
# Swarm suite — unchanged
cd testing/e2e/swarm && bun test tests/
cd testing/e2e/swarm && bun test tests/02-deploy.test.ts   # a single file

# k3s suite — always through its lane runner, never `bun test tests/` directly: a shared-cluster
# lane needs a fixed file order (fail-fast at the first broken file), which only run.ts enforces
cd testing/e2e/k3s && bun run run.ts k3s-core
cd testing/e2e/k3s && bun run run.ts k3s-setup

# Bare-metal host provisioning — unrelated to k3s cluster setup
cd testing/e2e/setup && bun test tests/

bun run testing/e2e/teardown.ts   # stop every test cluster afterwards
```

### Test architecture

The Swarm suite is two Docker containers simulating a real cluster; the k3s suite provisions a real
k3s cluster (via the actual `dockflow setup k3s`) inside systemd-in-Docker nodes, sized per lane:

| Container(s) | Role |
|-----------|------|
| `dockflow-test-manager` (SSH `localhost:32222`), `dockflow-test-worker-1` (`localhost:32223`) | Swarm suite: manager + worker |
| `server-1`, `agent-1`, ... (project `dockflow-k3s`, SSH `32230`+) | k3s suite: the lane's topology (`duo` = 1 server + 1 agent, `trio` adds a second agent, `ha` = 3 servers + 1 agent); a `registry`, `registry-auth` and `charts` auxiliary container sit on the same lane network |
| per-file containers (project `dockflow-k3s-setup`, SSH `32240`-`32249`) | `k3s-setup` lane only — fresh nodes for every test file, since some of them break and repair the cluster itself |
| `dockflow-test-setup` | bare-metal provisioning suite: a clean `ubuntu:24.04` host |

The `.env.dockflow` test fixtures use `localhost:<port>` mappings to reach the containers from the host.

### What's tested

**Swarm suite** (`01`-`09`): build, deploy (replicas, distributed), health checks, Traefik routing,
backup/restore, remote build, rollback, uploads, registry distribution.

**k3s suite**: every gated lane of `CLAUDE.md`'s *E2E Tests* table — render contract, deploy, compose
coverage, accessories/volumes, rollback, day-2 commands and the API, multi-node distribution and
placement, proxy/Helm, HA and failover, and the full cluster-setup lifecycle (single host, cluster,
partial failure, validation, upgrade, firewall, re-run, identity recovery) — plus a nightly set that
touches real upstream URLs and runs the ARM64/WireGuard/soak scenarios.

**Bare-metal setup suite** (`20`-`21`): non-interactive `dockflow setup`, Docker install, deploy user +
group, `/var/lib/dockflow` permissions, `dockflow init`, idempotent re-run.

### Debug commands

```bash
# Swarm — access a test node
docker exec -it dockflow-test-manager bash
docker exec dockflow-test-manager docker ps
docker exec dockflow-test-manager docker service logs test-app-test_web
docker exec dockflow-test-manager docker stack ps test-app-test

# k3s — access a node, inspect the cluster with the deploy identity's own (sudo-free) kubeconfig
docker exec -it server-1 bash
docker exec server-1 env KUBECONFIG=/var/lib/dockflow/kube/config kubectl get pods -A
docker exec server-1 env KUBECONFIG=/var/lib/dockflow/kube/config kubectl get events -A --sort-by='.lastTimestamp'

# a failed lane leaves a failure dump under testing/e2e/.artifacts/ (helpers/debug-dump.ts)
```

---

## Services Layer — Naming Convention

`cli/src/services/` uses a three-tier naming system. The suffix (or lack of one) tells you the shape of the export:

### 1. `*Backend` — polymorphic interfaces

Used only under `cli/src/services/orchestrator/` for things that have more than one implementation (Swarm + k3s).

```ts
// Interface
export interface StackBackend {
  deploy(input: StackDeployInput): Promise<Result<void, DeployError>>;
  // ...
}

// Implementations — one file per backend under orchestrator/swarm/, one directory (backends/) under
// orchestrator/kubernetes/, where a k3s "backend" is often several cooperating modules rather than
// one class (stack.ts's deploy/apply/waitConvergence/revert, stack-day2.ts's day-2 verbs, ...)
export class SwarmStackBackend implements StackBackend { /* ... */ }
export const kubernetesStackBackend: StackBackend = { /* built from backends/stack.ts + stack-wait.ts + stack-day2.ts */ };

// Consumed via one factory switch, never constructed directly by a command
const orchestrator = createOrchestrator(target, config); // orchestrator.stack, .containers, .health, .proxy, ...
```

Current backends: `StackBackend` (health checks are one of its methods, `checkHealth` — there is no
separate `HealthBackend`), `ContainerBackend`, `ProxyBackend`, `ImageBackend`, `ClusterBackend`,
`VolumeBackend` (present on both orchestrators — Swarm's implementation is read-only, its `remove`
throws `UnsupportedOperationError`; `capabilities.volumes` is what actually gates the `dockflow volumes`
command group to k3s), `HelmBackend` (`null` on Swarm), `BackupBackend`.

### 2. Plain noun — stateful classes

One class per file, named after the singular noun. Wraps a connection, or an `Orchestrator` bundle, or
holds other state across multiple calls.

```ts
// cli/src/services/backup.ts
export class Backup {
  constructor(private readonly orchestrator: Orchestrator, private readonly ref: StackRef) {}
  async create(service: string, options: CreateOptions): Promise<Result<BackupMetadata, BackupError>> { /* ... */ }
  async list(service?: string): Promise<Result<BackupMetadata[], BackupError>> { /* ... */ }
  async restore(service: string, options: RestoreOptions): Promise<Result<void, BackupError>> { /* ... */ }
}

// Factory for config-resolved defaults
export function createBackup(orchestrator: Orchestrator, ref: StackRef): Backup { /* ... */ }
```

Current stateful classes: `Audit`, `Metrics`, `Backup`, `HealthCheck`. The deploy lock and release
management are **not** classes any more — they went into the orchestrator bundle instead, so the same
call works whether the lock and release records live in files on a manager (Swarm) or a Secret + Lease
in the cluster (k3s): `orchestrator.lock(stackName)` returns a `LockStore` (`acquire`/`release`/
`status`), and `services/release.ts` is a plain module (`rollbackRelease`, `cleanupReleases`, ...) over
`orchestrator.releases`.

Callers:
```ts
import { createBackup } from '../services/backup';
const backup = createBackup(orchestrator, ref);

// the lock, by contrast, comes straight off the bundle — no separate factory
const lock = orchestrator.lock(stackName, config.lock?.stale_threshold_minutes);
```

### 3. Module — stateless free functions

No class. The file is a namespace of top-level `export function` declarations, imported via `import * as`.

```ts
// cli/src/services/compose.ts
export function renderTemplates(...) { /* ... */ }
export function updateImageTags(...) { /* ... */ }
export function injectTraefikLabels(...) { /* ... */ }
// internal helpers stay non-exported
function deepMerge(...) { /* ... */ }
```

Callers:
```ts
import * as Compose from '../services/compose';
Compose.updateImageTags(parsed, { web: 'app:1.2.3' });
```

Current modules: `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts`. (The k3s compose-to-Kubernetes translator is not one of these — it is the `normalize`/`translate`/`render` pipeline under `orchestrator/kubernetes/`, see *Key Architecture Patterns* in `CLAUDE.md`.)

### Why no more `*Service`?

The suffix was ambiguous — it was attached to interfaces, to stateful classes, and to bags of static helpers without distinction. Each of the three forms above answers a different question for the reader:

- `*Backend` → "this has multiple implementations, look for a factory"
- plain noun → "this is a class, you instantiate it, it holds state"
- module → "this is just functions, import the namespace"

**Never introduce a new `*Service` class.** If you're tempted to, the shape you actually want is one of the three above.

### Picking the right shape

| Situation | Shape |
|---|---|
| Multiple implementations behind a common interface | `*Backend` |
| Wraps an SSH connection or other resource, called 2+ times | Stateful class |
| Pure, stateless transformations or side effects | Module of functions |
| "I have some helper functions" | Module of functions — never a class with `static` methods |

---

## Adding a New Feature

Quick checklist:

1. **Command**: add in `cli/src/commands/`, register in `cli/src/index.ts`
2. **Service logic**: put in `cli/src/services/`. Pick the right shape (see *Services Layer — Naming Convention* above)
3. **Config field**: update both `cli/src/schemas/config.schema.ts` (Zod) and `cli/src/utils/config.ts` (interface)
4. **New remote path**: add constants in `cli/src/constants.ts` and ensure the deploy command creates them via the `StackBackend` implementations
5. **k3s constant or wait function**: add it once, in `orchestrator/kubernetes/constants.ts` (Kubernetes-specific) or `cli/src/constants.ts` (shared with Swarm) — never inline a magic number in a backend
6. **Typecheck**: `bun run typecheck` — zero errors
7. **Documentation**: add or update a page in `docs/app/en/`

See `CLAUDE.md` for detailed patterns and rules.

---

## Releasing

### CLI (`@dockflow-tools/cli`)

Push a semver tag. CI builds multi-platform binaries, creates a GitHub Release, and publishes to npm automatically:

```bash
git tag 2.1.0 && git push origin 2.1.0
```

The tag format is `MAJOR.MINOR.PATCH` (no prefix). Pre-release tags (e.g. `2.1.0-beta.1`) are published to the `dev` npm tag.

### MCP Server (`@dockflow-tools/mcp`)

Push a tag prefixed with `mcp-`:

```bash
git tag mcp-1.2.0 && git push origin mcp-1.2.0
```

The `mcp-` prefix is stripped to get the npm version (`mcp-1.2.0` → `1.2.0`). Pre-release tags (e.g. `mcp-1.2.0-beta.1`) are published to the `dev` npm tag.

Publishing uses npm Provenance via OIDC (no `NPM_TOKEN` needed). The npm package must have a Trusted Publisher configured at npmjs.org pointing to:

| Field | Value |
|---|---|
| Repository | `Shawiizz/dockflow` |
| Workflow | `publish-mcp.yml` |
| Environment | _(leave blank)_ |
