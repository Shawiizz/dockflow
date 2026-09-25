# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dockflow is a CLI-first deployment framework supporting **Docker Swarm** and **k3s** (Kubernetes). A single TypeScript binary handles building, deploying, managing stacks AND one-shot machine provisioning (`dockflow setup`) via direct SSH — no runtime dependencies beyond the binary itself.

**Stack at a glance:**
- `cli/` — TypeScript CLI (Bun runtime) + embedded Angular WebUI — handles all deploy logic via ssh2
- `docs/` — Next.js 15 + Nextra documentation site
- `packages/` — MCP server, npm CLI wrapper
- `testing/e2e/` — End-to-end tests for both Swarm (Docker-in-Docker) and k3s (k3s-in-Docker)

## Repository Structure

```
cli/          # TypeScript CLI application (Bun)
cli/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
docs/            # Next.js 15 + Nextra documentation site
packages/        # Additional packages (MCP server, npm CLI wrapper)
scripts/         # Build & version management scripts
testing/e2e/     # End-to-end tests (two suites: swarm/ and k3s/)
```

## Common Commands

### CLI (`cli/`)

```bash
bun install                    # Install dependencies
bun run typecheck              # TypeScript validation (tsc --noEmit)
bun run lint                   # Biome lint (no console.*, no any, no unused imports)
bun run lint:fix               # Biome lint with auto-fix
bun test src/                  # Unit tests
bun run dev <command> [args]   # Run CLI locally in dev mode
bun run build                  # Build all platform binaries
bun run build:linux            # Build Linux x64 binary only
bun run build:windows          # Build Windows x64 binary only
bun run ui:build               # Build Angular UI (cd ui && pnpm build)
```

### WebUI (`cli/ui/`)

```bash
pnpm install                   # Install dependencies
pnpm build                     # Production build
pnpm start                     # Dev server
```

### Docs (`docs/`)

```bash
pnpm install                   # Install dependencies
pnpm dev                       # Next.js dev server
pnpm build                     # Production build + LLM text generation + Pagefind indexing
```

### Shell Linting

```bash
./scripts/lint-shell.sh        # ShellCheck on all .sh files
```

### E2E Tests (Linux/WSL/Windows, requires Docker)

```bash
cd testing/e2e/swarm && bun test tests/   # Swarm suite (DinD, 2 nodes)
cd testing/e2e/k3s && bun test tests/     # k3s suite (k3s-in-Docker)
cd testing/e2e/setup && bun test tests/   # Setup/provisioning suite (clean ubuntu container)
bun run testing/e2e/teardown.ts           # Cleanup all test containers
```

### Releasing

Releases are fully automated via CI. Push a git tag to trigger a build, GitHub Release, and npm publish:

```bash
git tag 2.1.0 && git push origin 2.1.0
```

The CI sets the version in all `package.json` files from the tag before building.

## Architecture: SSH-Only Deployment

All CLI operations (deploy, build, backup, logs, exec, shell, status) connect directly to remote nodes via the `ssh2` library. Connection credentials come from `.env.dockflow` (or CI secrets). There is **one SSH context** — the CLI's machine must be able to reach all target hosts.

`dockflow setup user@host` provisions machines by shipping the Linux binary to the server and re-executing it there (`commands/setup/remote.ts`); provisioning itself is pure TypeScript (`commands/setup/provision.ts`).

## Key Architecture Patterns

### CLI Command Pattern

Commands live in `cli/src/commands/` and follow this structure:
1. Export a `register<Name>Command(program: Command)` function
2. Use Commander.js `.command()`, `.option()`, `.description()`, `.action(withErrorHandler(...))`
3. Commands **throw errors** — never call `process.exit()` directly
4. The `withErrorHandler()` wrapper (from `utils/errors.ts`) catches, formats, and exits

Entry point `cli/src/index.ts` registers all commands and sets up the `--verbose` flag via a global preAction hook.

### Error Handling Hierarchy

Custom error classes in `cli/src/utils/errors.ts`:
```
CLIError (base — has code, suggestion, cause)
  ├─ ConfigError      (codes 10-19)
  ├─ ConnectionError  (codes 30-39)
  ├─ DockerError
  ├─ DeployError
  ├─ ValidationError
  └─ BackupError
```
Always throw these typed errors from commands. The `withErrorHandler` wrapper displays the message + suggestion and exits with the error code. Stack traces only show in DEBUG/CI or for unexpected errors.

### Services Layer

`cli/src/services/` follows a strict three-tier naming convention. The suffix communicates the shape of the export, not just its category:

| Shape | Suffix | Examples | Import style |
|---|---|---|---|
| Polymorphic abstraction (multiple impls) | `*Backend` | `StackBackend`, `ContainerBackend`, `ProxyBackend`, `ImageBackend`, `VolumeBackend`, `HelmBackend`, `BackupBackend`, `ClusterBackend` | `orchestrator.stack`/`.containers`/... via `createOrchestrator()` |
| Stateful class (wraps a connection / holds state) | no suffix | `Audit`, `Metrics`, `Backup`, `HealthCheck` | `new Backup(orchestrator, ref)` |
| Pure module (stateless free functions) | no class | `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts` | `import * as Compose from '../services/compose'` |

**Rules:**
- Never append `Service` to anything new. The word is too vague — if the class wraps state, drop the suffix; if it's just functions, make it a module.
- `*Backend` is reserved for interfaces with more than one implementation, and lives only under `services/orchestrator/`.
- Stateful class files are named after the singular noun (e.g. `lock.ts` exports `class Lock` + `createLock()` factory).
- Module files export top-level `export function` declarations and are imported with `import * as Xxx from '...'`.

**Orchestrator abstraction** (`cli/src/services/orchestrator/`):

The orchestrator layer abstracts Swarm vs k3s behind one `Orchestrator` bundle (`interfaces.ts`):
`stack` (`StackBackend`), `containers` (`ContainerBackend`), `proxy` (`ProxyBackend`), `images`
(`ImageBackend`), `cluster` (`ClusterBackend`), `backups` (`BackupBackend`), `releases` (`ReleaseStore`),
`volumes` (`VolumeBackend`, always present — Swarm's is read-only, `remove` throws
`UnsupportedOperationError`), `helm` (`HelmBackend | null`, null unless `capabilities.helm`), and a
`lock()` method returning a `LockStore`. There is no separate `HealthBackend` — health checks are
`stack.checkHealth`. Config field `orchestrator: 'swarm' | 'k3s'` (default: `swarm`) selects the bundle;
`factory.ts`'s `createOrchestrator` is the one switch every command goes through (via
`openOrchestrator`), so no command ever constructs a backend directly or branches on the orchestrator
kind itself.

- `orchestrator/swarm/` — one file per backend (`swarm-stack.ts`, `swarm-container.ts`, `swarm-proxy.ts`,
  `swarm-images.ts`, `swarm-volumes.ts`, `swarm-backup.ts`, `swarm-cluster.ts`), assembled by
  `swarm-orchestrator.ts`. Uses `docker stack deploy`, `docker service`/`docker ps` commands over SSH.
- `orchestrator/kubernetes/` (`K/` in the design docs) — the k3s bundle, one directory per concern rather
  than one file per backend:
  - `model/`, `normalize/`, `translate/` — the pure compose → Kubernetes pipeline: `normalize/` turns a
    parsed `docker-compose.yml` into an orchestrator-neutral `CanonicalStack`, `translate/` turns that into
    Kubernetes API objects (`resources/`), `render.ts` composes both into one artifact plus its digest.
  - `apply/` — the pure planners around a server-side apply (snapshot diffing, kind switches, Job
    re-creation, prune/revert planning); `backends/stack.ts`'s `engine.ts` performs the reads and deletes
    they plan.
  - `backends/` — the `StackBackend`/`ContainerBackend`/`ImageBackend`/`VolumeBackend`/`BackupBackend`
    implementations: `stack.ts` (deploy/apply/waitConvergence/revert/finalize — the only specification of
    those verbs, `checkHealth` included), `stack-wait.ts`, `stack-day2.ts` (rollback/scale/restart/stop),
    `containers.ts`, `volumes.ts`, `backup.ts`, `helm.ts`, `proxy.ts`.
  - `helm/`, `runtime/` — Helm release resolution/values and the `kubectl`/`helm` process runners every
    backend calls through (`runtime/kubectl.ts`, `runtime/helm.ts`); no backend shells out directly.
  - `k3s/` — the one Kubernetes distribution Dockflow ships: pinned versions, `dockflow setup k3s`'s own
    flow, the default `DistributionTraits` (`k3sDistribution`) the render pipeline is parameterized on.
  - `status/` — day-2 read paths (pods, services, diagnose, logs) shared by commands and the API routes.
  - `constants.ts`, `naming.ts`, `diagnostics.ts` (shared with Swarm via `orchestrator/diagnostics.ts`) —
    names, labels and the one `DiagnosticSink` a render passes through both `normalize` and `translate`.

  There is no single "compose to manifests" converter file — the pipeline above replaces the old
  single-file `k8s-manifest.ts` translator entirely; that file and the old `k3s-stack.ts`/`k3s-container.ts`/
  `k3s-proxy.ts` backends no longer exist.
- `orchestrator/stores/` — `FileReleaseStore`/`FileLockStore` (Swarm: files on the manager) vs. the k3s
  bundle's own release Secret + Lease store in `kubernetes/backends/`.

**Stateful classes** (`cli/src/services/*.ts`, no Service suffix):
- `Metrics` (`metrics.ts`) — deployment metrics read/write, connection-bound
- `Backup` (`backup.ts`) — backup/restore for accessories, wraps an `Orchestrator` bundle + `StackRef`
- `Audit` (`audit.ts`) — deployment audit log entries on remote manager
- `HealthCheck` (`health-check.ts`) — external HTTP endpoint checks with retry (`stack.checkHealth` covers the internal, orchestrator-specific check)

Each stateful class exposes a matching factory (`createBackup`, …) where construction needs defaults from
config. The deploy lock and release management are **not** stateful classes any more — they moved into
the orchestrator bundle so the same code works on both a manager's files (Swarm) and a cluster Secret +
Lease (k3s): `orchestrator.lock(stackName)` returns a `LockStore` (`acquire`/`release`/`status`), and
`services/release.ts` is a plain module (`rollbackRelease`, `cleanupReleases`, ...) over the bundle's
`releases: ReleaseStore`.

**Pure modules** (`cli/src/services/*.ts`, imported via `import * as`):
- `compose.ts` — template rendering (Nunjucks), YAML load/serialize, Swarm/accessory deploy config injection, Traefik label injection, image tag updates
- `build.ts` — local/remote Docker/Podman image builds (parses compose YAML, assembles tar contexts in memory)
- `distribution.ts` — image distribution (SSH pipe for Docker/Podman, `k3s ctr images import` for containerd), registry login/push
- `hook.ts` — pre/post build/deploy hooks (local via `Bun.spawn`, remote via SSH)
- `notification.ts` — HMAC-signed HTTP webhooks on deploy events
- `history-sync.ts` — replicates audit/metrics to non-manager nodes

The k3s compose-to-Kubernetes translator lives under `orchestrator/kubernetes/` (`normalize/`,
`translate/`, `render.ts`), not as a `services/*.ts` module — see *Orchestrator abstraction* above.

**Container engine support:**

Config field `container_engine: 'docker' | 'podman'` (auto-detected if not set). Affects the `build` module (build command) and `distribution` module (save/load/push). The runtime type is `ContainerRuntime = 'docker' | 'containerd' | 'podman'` — k3s always uses `containerd` for image import regardless of the build engine.

Services and modules use the `Result<T, E>` type pattern (`ok()` / `err()`) from `cli/src/types/`.

**Multi-node awareness:** A backend that needs to find or operate on a container (`SwarmContainerBackend`, `SwarmBackupBackend`) reads the node list off the `OrchestratorTarget` it is constructed with (`target.managers`/`.workers`/`.controlPlane`) rather than taking a separate connections parameter — a container may run on any worker in a multi-node Swarm, not just the manager, and the target already carries every node's connection. `Backup` and the other stateful classes wrap the `Orchestrator` bundle itself, so this is already handled underneath them. The one place that still reads every node directly, orchestrator-neutral, is `getAllNodeConnections(env)` (`utils/validation.ts`/`utils/servers.ts`) — used by `history`/`metrics`/the matching API routes for the "try the first manager, fall back to the next" pattern (see [Multi-host](/en/configuration/multi-host) and the [CLI reference](/en/cli#history-audit)'s per-manager caveat).

### Console Output

All CLI output goes through `cli/src/utils/output.ts` helpers. **Never use `console.log` directly.**

Key helpers: `printSuccess`, `printError`, `printWarning`, `printInfo`, `printDebug` (verbose-only), `printDim`, `printBlank`, `printJSON`, `printRaw`, `printHeader`, `printSection`, `printTableRow`.

Formatters: `formatDuration(seconds)`, `formatBytes(bytes)`, `formatRelativeTime(iso)`.

Verbose mode controlled by `setVerbose()` / `isVerbose()`.

### Config System

- **Zod schemas**: `cli/src/schemas/config.schema.ts` — runtime validation of `.dockflow/config.yml`
- **TypeScript interfaces**: `cli/src/utils/config.ts` — `DockflowConfig`, `ServersConfig`, etc.
- **Both must stay in sync** when adding/changing config fields.
- Config loading: `loadConfig()` finds the `.dockflow/` directory by walking up from CWD via `getProjectRoot()`.

### SSH Connections

Typed with ssh2 `ConnectConfig` in `cli/src/utils/ssh.ts`. Connection types in `cli/src/types/connection.ts`:
- `SSHKeyConnection` — host, port, user, privateKey
- `SSHPasswordConnection` — host, port, user, password

Keys are passed in-memory (never written to temp files). Core functions: `sshExec()` (collect output), `sshExecStream()` (stream with callbacks), `sshShell()` (interactive).

### Deploy Flow (TypeScript, direct SSH)

The `dockflow deploy` command executes entirely in TypeScript via ssh2:

1. Load config, resolve server connections, acquire deployment lock
2. Detect container engine (Docker or Podman, auto-detected or from config)
3. Render Nunjucks templates (docker-compose, env files)
4. Prepare compose: load YAML, update image tags, inject deploy defaults; on k3s, render (normalize +
   translate, `orchestrator/kubernetes/render.ts`) both roles into one Kubernetes manifest artifact,
   entirely in memory, before any remote call
5. Build images (local or remote, Docker or Podman), distribute to nodes:
   - **Swarm**: base64 chunked transfer or registry push (`docker load`/`docker push`)
   - **k3s**: `k3s ctr images import` (containerd)
6. Create the release record — a directory on the manager (Swarm) or a Secret in the cluster (k3s) —
   and upload the compose file or rendered manifests
7. Apply:
   - **Swarm**: `docker stack deploy -c -` (accessories first with hash-based change detection)
   - **k3s**: `kubectl apply --server-side -f -` (a pure planner decides kind switches and Job
     re-creation first, `orchestrator/kubernetes/apply/`), then a fail-fast convergence wait
8. Health checks: internal (orchestrator-specific backend) + HTTP endpoint checks
9. Cleanup old releases, write audit/metrics, sync history to all nodes
10. Release lock (always, even on failure)

All steps are in `cli/src/commands/deploy.ts` using the services layer.

### Host Provisioning (`commands/setup/provision.ts`)

`dockflow setup` provisions hosts in pure TypeScript (no Ansible, no repo clone on the server). Local setup requires root (no sudo binary needed — commands run directly). Steps, all idempotent:
- Docker install via the official `get.docker.com` script (multi-distro), skippable with `--skip-docker-install` (and skipped with `--orchestrator k3s` — k3s uses containerd)
- `/var/lib/dockflow` creation owned by the deploy user
- Optional nginx install (package-manager aware) + Portainer vhost
- Optional Portainer container (bcrypt admin password hashed via a throwaway `httpd` container, password passed on stdin — never in argv; the password only applies on first initialization)

Remote setup (`setup user@host`) ships the version-pinned binary and forwards flags — including `--user`/`--deploy-password` to create the deploy user non-interactively. Forwarded values are shell-quoted (`buildForwardFlags` in `setup/forward.ts`).

### Remote Directory Permissions

All directories under `/var/lib/dockflow/` are created by the deploy command (via the `StackBackend` implementations) with proper ownership so the deploy user can write to them directly via SSH without sudo. The `dockflow setup` command also creates the base `/var/lib/dockflow` directory.

Directory constants are defined in `cli/src/constants.ts` (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, `DOCKFLOW_AUDIT_DIR`, `DOCKFLOW_METRICS_DIR`, `DOCKFLOW_BACKUPS_DIR`, `DOCKFLOW_ACCESSORIES_DIR`).

### API Server & WebUI

`cli/src/api/server.ts` — Bun HTTP server with WebSocket support. Serves the Angular UI (embedded in binary via `ui-manifest.generated`, or from `ui/dist/` in dev).

Routes in `cli/src/api/routes/`:
- REST: `/api/servers`, `/api/services`, `/api/config`, `/api/deploy`, `/api/operations`, `/api/accessories`, `/api/backup`, etc.
- WebSocket: `/ws/ssh/:serverName` (interactive SSH), `/ws/exec/:serviceName` (docker exec)

WebSocket sessions include heartbeat (30s), idle timeout (15min), and watchdog cleanup (60s).

Response helpers: `jsonResponse()`, `errorResponse()` — both include CORS headers.

### WebUI Architecture

Angular 21 standalone components with lazy-loaded routes in `cli/ui/src/app/app.routes.ts`:
- 12 feature modules: dashboard, servers, services, logs, deploy, build, accessories, monitoring, resources, topology, settings
- `settings` route has an `unsavedChangesGuard`
- Shared components (sidebar, header) in `cli/ui/src/app/shared/`

### Constants

Key values in `cli/src/constants.ts`: `DOCKFLOW_VERSION` (from package.json), `DEFAULT_SSH_PORT` (22), `LOCK_STALE_THRESHOLD_MINUTES` (30), `CONVERGENCE_TIMEOUT_S` (300), `CONVERGENCE_INTERVAL_S` (5), directory paths (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, etc.).

## E2E Tests

Three independent suites under `testing/e2e/` (see `testing/e2e/README.md` for the full layout and
conventions), each owning its own cluster lifecycle:

**Swarm suite** (`swarm/tests/01-09`): Docker-in-Docker with a manager (`dockflow-test-manager`, SSH port 32222) and worker (`dockflow-test-worker-1`, port 32223), compose project `dockflow-swarm`. Covers build, deploy, Traefik routing, backup/restore, remote build, HTTP health checks, automatic rollback on failed health checks (dedicated `test-app-rb` stack), uploads with rollback on failed deploys (dedicated `test-app-up` stack), exec/logs, and registry distribution (anonymous `registry:2` inside the manager at `localhost:35000`, dedicated `test-app-reg` stack pinned to the manager). The preload resets the cluster and pre-deploys the shared test-app.

**k3s suite** (`k3s/`): systemd-in-Docker nodes running the real `dockflow setup k3s` in the preload, driven through a lane runner rather than plain `bun test` — a shared-cluster lane needs a fixed file order and stops at the first failing file (`bun run testing/e2e/k3s/run.ts <lane>`). `lanes.ts` maps each lane to its topology (`duo`, `trio`, `ha`, or none for a fresh-containers-per-file lane), test directory and time budget:

| Lane | Topology | Covers |
|---|---|---|
| `k3s-core` | duo | render contract, basic deploy, compose coverage, headless DNS, non-destructive security checks |
| `k3s-lifecycle` | duo | accessories volumes/protocol, rollback and post-apply failures |
| `k3s-day2` | duo | logs/exec/cp/scale/restart/stop, API routes, backup |
| `k3s-multinode` | trio | distribution to every node, placement, ServiceLB, registry, volumes pinned to a node, refusals |
| `k3s-proxy-helm` | duo | Traefik, Helm app/accessory releases, Helm-only projects |
| `k3s-ha` | ha (3 managers + 1 worker) | topology, failover, concurrent-deploy Lease contention |
| `k3s-setup` | none (fresh containers per file) | single-host/cluster/partial-failure/validation/upgrade/firewall/rerun setup, identity recovery |

`nightly/` (not part of the gated matrix) runs the arm64 smoke test, the one file allowed to hit real
upstream URLs, an offline-canary re-run, extended backup, WireGuard, and a soak test, each via
`run.ts nightly --file <name>`.

**Setup suite** (`setup/tests/20-21`): **bare-metal host provisioning**, unrelated to k3s cluster setup — a clean `ubuntu:24.04` container (`dockflow-test-setup`) running the cross-compiled Linux binary: non-interactive `dockflow setup`, Docker install via get.docker.com, deploy user + docker group, `/var/lib/dockflow` permissions, `dockflow init`, and an idempotent re-run. (`k3s/tests/setup/` above is the *cluster* setup lane — installing and upgrading k3s itself — a different thing this suite's name collides with only in English, not in the tree.)

Test helpers: `helpers/fixtures.ts` (temp-dir fixture copies — fixture templates in `fixtures/` are read-only, tests never write into the repo tree), `helpers/cluster.ts` (topology start/stop for both orchestrators), `k3s/helpers/k8s.ts` (kubectl/helm assertions, the label contract), `k3s/helpers/leak-watch.ts` and `k3s/helpers/debug-dump.ts`.

E2E tests run on Linux, WSL and Windows (Docker required) for Swarm and the bare-metal setup suite; the k3s suite additionally needs cgroup v2 and is prepared with the tools under `k3s/tools/` (pinned downloads, node image, charts) before its first run — see `testing/e2e/README.md`. CI runs the suites as parallel matrix jobs.

## CI/CD Workflows (`.github/workflows/`)

- **publish-cli.yml** — Triggered by version tags. Runs typecheck + lint + unit tests, then builds multi-platform binaries (linux-x64/arm64, macos-x64/arm64, windows-x64), creates GitHub Release, publishes to npm (`@dockflow-tools/cli`).
- **publish-mcp.yml** — Triggered by `mcp-*` tags. Tests and publishes `@dockflow-tools/mcp` (`packages/mcp-server/`) to npm via OIDC Provenance.
- **cli-checks.yml** — Runs on push to main/develop and PRs. Typecheck (`tsc --noEmit`), Biome lint, and unit tests (`bun test src/`) in `cli/`.
- **deploy-docs.yml** — Documentation site deployment. Installs CLI and runs `dockflow deploy` directly.
- **e2e-tests.yml** — Runs on push to main/develop and PRs. Matrix of parallel jobs, one per e2e suite (`swarm`, `k3s`, `setup` today; the k3s job fans out across the lanes of the *E2E Tests* section above as that matrix is wired up).
- **shell-lint.yml** — ShellCheck validation.

CI/CD integration is handled entirely by the CLI itself — no reusable workflows or external templates needed. The CLI auto-detects environment and version from CI provider env vars (GitHub Actions, GitLab CI, Jenkins, Buildkite) when `dockflow deploy` or `dockflow build` are called without arguments. Users generate a standalone CI workflow via `dockflow init`.

CI secrets format: `{ENV}_{SERVER}_{CONNECTION}` = base64-encoded `user@host:port|privateKey|password`.

## Development Rules

- **Typecheck before committing**: Run `bun run typecheck` in `cli/` — zero errors required.
- **Lint before committing**: Run `bun run lint` in `cli/`. Biome enforces: no `console.*` outside `utils/output.ts`, no `any`, no unused imports (config in `cli/biome.json`).
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes.
- **Config schema + interface parity**: Update both Zod schema and TypeScript interface when adding config fields.
- **Error handling**: Throw typed `CLIError` subclasses from commands. Never catch-and-exit manually.
- **Services for container ops**: Use the services layer (`cli/src/services/`) for orchestrator/container interactions, not raw SSH commands in command handlers.
- **Orchestrator abstraction**: New commands that interact with stacks/containers must go through the `Orchestrator` bundle (`stack`, `containers`, `proxy`, `images`, `volumes`, `helm`, ...) returned by `openOrchestrator()`/`createOrchestrator()` in `cli/src/services/orchestrator/factory.ts`. Never hardcode Swarm-specific or k3s-specific logic in command handlers.
- **Service naming**: Follow the three-tier convention (see *Services Layer*). `*Backend` for polymorphic interfaces, plain nouns for stateful classes, module imports for stateless functions. Never introduce a new `*Service` class.
- **Multi-node services**: When creating `Backup` or `SwarmContainerBackend`, always pass `getAllNodeConnections(env)` so container lookups work on worker nodes too.
- **New directory paths**: Add constants in `cli/src/constants.ts` and ensure the deploy command creates them on the remote host.
## Self-Review Before Finishing

After implementing any feature or fix, always ask:

- **Is the logic correct?** Re-read the code with fresh eyes. Check edge cases: empty inputs, missing fields, format variations (e.g. port formats `host:container` vs `ip:host:container`).
- **Is it consistent with the rest of the codebase?** Patterns, naming, error handling, output style.
- **Did I break anything?** Run `bun run typecheck`. Think about what else calls the code I changed.
- **Is this the simplest approach?** If the implementation feels complex, step back — there's often a simpler path.
- **Are there silent failure modes?** Check for unhandled Promise rejections, empty SSH outputs, missing config fields.

## Documentation Rules

Every new user-facing feature **must** be documented before the task is considered done.

### When to create a new page vs update an existing one

- **New page**: The feature is a standalone concept with its own config block, workflow, or set of options (e.g. `proxy`, `registry`, `hooks`).
- **Update existing page**: The change adds a field to an existing concept (e.g. adding a flag to `health_checks`).

### Doc page structure

New pages in `docs/app/en/configuration/` or `docs/app/en/` should follow this order:
1. **One-line intro** — what this feature does and why it matters
2. **Minimal working example** — the simplest config that makes it work
3. **All options** — table with field, type, description, default
4. **How it works** — brief explanation of the mechanism (use `<Steps>` for multi-step flows)
5. **Edge cases / caveats** — things that can go wrong, `<Callout type="warning">` for important ones
6. **Full example** — realistic config using `<Tabs>` when it spans multiple files

### Doc style

- Use `<Callout type="info">` for tips, `<Callout type="warning">` for gotchas
- Code blocks always have a language tag and a comment showing the file path (`# .dockflow/config.yml`)
- Tables for option references: `| Field | Type | Description | Default |`
- Link to related pages at the end with "See also" or inline contextual links
- No marketing language. Direct, technical, factual.

### Navigation and index

After creating a new page:
1. Add its slug to `docs/app/en/configuration/_meta.ts` (or the relevant `_meta.ts`) so it appears in the sidebar
2. Add a `<Cards.Card>` entry in the parent index page (`docs/app/en/configuration/page.mdx`)
3. Add the entry to `docs/scripts/generate-llms-txt.ts` so LLM context stays up to date
