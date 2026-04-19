# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dockflow is a CLI-first deployment framework supporting **Docker Swarm** and **k3s** (Kubernetes). A single TypeScript binary handles building, deploying, and managing stacks via direct SSH — no runtime dependencies beyond the binary itself. Ansible is only used for one-shot machine provisioning (`dockflow setup`).

**Stack at a glance:**
- `cli/` — TypeScript CLI (Bun runtime) + embedded Angular WebUI — handles all deploy logic via ssh2
- `ansible/` — Ansible roles for machine provisioning only (`configure_host.yml`)
- `docs/` — Next.js 15 + Nextra documentation site
- `packages/` — MCP server, npm CLI wrapper
- `testing/e2e/` — End-to-end tests for both Swarm (Docker-in-Docker) and k3s (k3s-in-Docker)

## Repository Structure

```
cli/          # TypeScript CLI application (Bun)
cli/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
ansible/         # Ansible roles for machine provisioning (setup only)
docs/            # Next.js 15 + Nextra documentation site
packages/        # Additional packages (MCP server, npm CLI wrapper)
scripts/         # Build & version management scripts
testing/e2e/     # End-to-end tests (run from WSL/CI only)
```

## Common Commands

### CLI (`cli/`)

```bash
bun install                    # Install dependencies
bun run typecheck              # TypeScript validation (tsc --noEmit)
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

### E2E Tests (WSL/CI only)

```bash
cd testing/e2e && bun test tests/                       # Full suite: Swarm + k3s
cd testing/e2e && bun test tests/10-k3s-deploy.test.ts  # k3s tests only
cd testing/e2e && bun run teardown.ts                   # Cleanup all test containers
```

### Releasing

Releases are fully automated via CI. Push a git tag to trigger a build, GitHub Release, and npm publish:

```bash
git tag 2.1.0 && git push origin 2.1.0
```

The CI sets the version in all `package.json` files from the tag before building.

## Architecture: SSH-Only Deployment

All CLI operations (deploy, build, backup, logs, exec, shell, status) connect directly to remote nodes via the `ssh2` library. Connection credentials come from `.env.dockflow` (or CI secrets). There is **one SSH context** — the CLI's machine must be able to reach all target hosts.

Ansible is only used for `dockflow setup` (one-shot machine provisioning via `configure_host.yml`). It runs inside a Docker container for that command only.

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
| Polymorphic abstraction (multiple impls) | `*Backend` | `StackBackend`, `ExecBackend`, `LogsBackend`, `HealthBackend`, `ProxyBackend`, `ContainerBackend` | `new SwarmStackBackend(conn)` via factory |
| Stateful class (wraps a connection / holds state) | no suffix | `Audit`, `Lock`, `Release`, `Metrics`, `Backup`, `HealthCheck` | `new Lock(conn, stackName)` |
| Pure module (stateless free functions) | no class | `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts`, `k8s-manifest.ts` | `import * as Compose from '../services/compose'` |

**Rules:**
- Never append `Service` to anything new. The word is too vague — if the class wraps state, drop the suffix; if it's just functions, make it a module.
- `*Backend` is reserved for interfaces with more than one implementation, and lives only under `services/orchestrator/`.
- Stateful class files are named after the singular noun (e.g. `lock.ts` exports `class Lock` + `createLock()` factory).
- Module files export top-level `export function` declarations and are imported with `import * as Xxx from '...'`.

**Orchestrator abstraction** (`cli/src/services/orchestrator/`):

The orchestrator layer abstracts Swarm vs k3s behind common interfaces. Config field `orchestrator: 'swarm' | 'k3s'` (default: `swarm`) selects the backend. Factory functions in `cli/src/services/orchestrator/factory.ts` create the right implementation:

- `StackBackend` — stack lifecycle: deploy, remove, getServices, scale, rollback, list stacks
  - `SwarmStackBackend` — uses `docker stack deploy`, `docker service` commands
  - `K3sStackBackend` — uses `kubectl apply`, manages namespaces (`dockflow-{stackName}`)
- `ContainerBackend` — exec/shell/copy/logs in containers
  - `SwarmContainerBackend` — finds containers via `docker ps` across all nodes with `Promise.any()`
  - `K3sContainerBackend` — finds pods via `kubectl get pods`, uses `kubectl exec`/`kubectl cp`
- `HealthBackend` — internal health checks
  - `SwarmHealthBackend` — inspects tasks via `docker service ps` + UpdateStatus
  - `K3sHealthBackend` — checks pod status, detects CrashLoopBackOff
- `ProxyBackend` — Traefik / ingress management

**Stateful classes** (`cli/src/services/*.ts`, no Service suffix):
- `Metrics` (`metrics.ts`) — deployment metrics read/write, connection-bound
- `Lock` (`lock.ts`) — deployment lock management (acquire/release with stale detection)
- `Backup` (`backup.ts`) — backup/restore for accessories, holds manager + worker connections
- `Audit` (`audit.ts`) — deployment audit log entries on remote manager
- `Release` (`release.ts`) — release directory management, rollback, cleanup of old releases
- `HealthCheck` (`health-check.ts`) — HTTP endpoint checks with retry (uses HealthBackend internally)

Each stateful class exposes a matching factory (`createLock`, `createBackup`, …) where construction needs defaults from config.

**Pure modules** (`cli/src/services/*.ts`, imported via `import * as`):
- `compose.ts` — template rendering (Nunjucks), YAML load/serialize, Swarm/accessory deploy config injection, Traefik label injection, image tag updates
- `build.ts` — local/remote Docker/Podman image builds (parses compose YAML, assembles tar contexts in memory)
- `distribution.ts` — image distribution (SSH pipe for Docker/Podman, `k3s ctr images import` for containerd), registry login/push
- `hook.ts` — pre/post build/deploy hooks (local via `Bun.spawn`, remote via SSH)
- `notification.ts` — HMAC-signed HTTP webhooks on deploy events
- `history-sync.ts` — replicates audit/metrics to non-manager nodes
- `k8s-manifest.ts` — Docker Compose → native Kubernetes manifests (Deployment + Service + PVC + IngressRoute, nodeSelector, probes)

**Container engine support:**

Config field `container_engine: 'docker' | 'podman'` (auto-detected if not set). Affects the `build` module (build command) and `distribution` module (save/load/push). The runtime type is `ContainerRuntime = 'docker' | 'containerd' | 'podman'` — k3s always uses `containerd` for image import regardless of the build engine.

Services and modules use the `Result<T, E>` type pattern (`ok()` / `err()`) from `cli/src/types/`.

**Multi-node awareness:** Classes that need to find or operate on containers (`Backup`, `SwarmContainerBackend`) accept an `allConnections: SSHKeyConnection[]` parameter alongside the manager connection. This is required because in a multi-node Swarm, a container may run on any worker — not just the manager. Always pass `getAllNodeConnections(env)` when creating these.

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
4. Prepare compose: load YAML, update image tags, inject deploy defaults, inject Traefik labels
5. Build images (local or remote, Docker or Podman), distribute to nodes:
   - **Swarm**: base64 chunked transfer or registry push (`docker load`/`docker push`)
   - **k3s**: `k3s ctr images import` (containerd)
6. Create release directory on manager, upload compose file
7. Deploy:
   - **Swarm**: `docker stack deploy -c -` (accessories first with hash-based change detection)
   - **k3s**: `K8sManifest.composeToManifests()` → `kubectl apply -f -`
8. Health checks: internal (orchestrator-specific backend) + HTTP endpoint checks
9. Cleanup old releases, write audit/metrics, sync history to all nodes
10. Release lock (always, even on failure)

All steps are in `cli/src/commands/deploy.ts` using the services layer.

### Ansible (Setup Only)

Ansible is only used for `dockflow setup` via `ansible/configure_host.yml`. Remaining roles:
- `geerlingguy.docker` — multi-distro Docker install
- `nginx` — reverse proxy setup
- `portainer` — Portainer stack deployment

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

Tests use isolated Docker Compose projects (`-p dockflow-swarm` / `-p dockflow-k3s`):

**Swarm tests** (`01-05`): Docker-in-Docker with a manager (`dockflow-test-manager`, port 2222) and worker (`dockflow-test-worker-1`, port 2223). Cover build, deploy, Traefik routing, backup/restore, remote build, HTTP health checks.

**k3s tests** (`10`): k3s-in-Docker single node (`dockflow-test-k3s`, port 2224). Cover deploy, namespace creation, replicas, logs, exec, scale.

Test helpers: `testing/e2e/helpers/docker.ts` (Swarm assertions), `testing/e2e/helpers/k8s.ts` (kubectl assertions), `testing/e2e/helpers/cluster.ts` (cluster lifecycle for both).

E2E tests run from WSL/CI. The `.env.dockflow` in test fixtures uses `localhost:222x` port mappings.

## CI/CD Workflows (`.github/workflows/`)

- **build-cli.yml** — Triggered by version tags. Builds multi-platform binaries (linux-x64/arm64, macos-x64/arm64, windows-x64), creates GitHub Release, publishes to npm (`@dockflow-tools/cli`).
- **deploy-docs.yml** — Documentation site deployment. Installs CLI and runs `dockflow deploy` directly.
- **e2e-tests.yml** — Runs on push to main/develop and PRs. Executes `bun test tests/` in `testing/e2e/`.
- **shell-lint.yml** — ShellCheck validation.

CI/CD integration is handled entirely by the CLI itself — no reusable workflows or external templates needed. The CLI auto-detects environment and version from CI provider env vars (GitHub Actions, GitLab CI, Jenkins, Buildkite) when `dockflow deploy` or `dockflow build` are called without arguments. Users generate a standalone CI workflow via `dockflow init`.

CI secrets format: `{ENV}_{SERVER}_{CONNECTION}` = base64-encoded `user@host:port|privateKey|password`.

## Development Rules

- **Typecheck before committing**: Run `bun run typecheck` in `cli/` — zero errors required.
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes.
- **Config schema + interface parity**: Update both Zod schema and TypeScript interface when adding config fields.
- **Error handling**: Throw typed `CLIError` subclasses from commands. Never catch-and-exit manually.
- **Services for container ops**: Use the services layer (`cli/src/services/`) for orchestrator/container interactions, not raw SSH commands in command handlers.
- **Orchestrator abstraction**: New commands that interact with stacks/containers must use the backend interfaces (`StackBackend`, `ContainerBackend`, `HealthBackend`, `ProxyBackend`) via the factory functions in `cli/src/services/orchestrator/factory.ts`. Never hardcode Swarm-specific or k3s-specific logic in command handlers.
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

New pages in `docs/app/configuration/` or `docs/app/` should follow this order:
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
1. Add its slug to `docs/app/configuration/_meta.ts` (or the relevant `_meta.ts`) so it appears in the sidebar
2. Add a `<Cards.Card>` entry in the parent index page (`docs/app/configuration/page.mdx`)
3. Add the entry to `docs/scripts/generate-llms-txt.ts` so LLM context stays up to date
