# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dockflow is a CLI-first deployment framework built on **Docker Swarm**. A single TypeScript binary handles building, deploying, managing stacks AND one-shot machine provisioning (`dockflow setup`) via direct SSH — no runtime dependencies beyond the binary itself.

**Stack at a glance:**
- `cli/` — TypeScript CLI (Bun runtime) + embedded Angular WebUI — handles all deploy logic via ssh2
- `docs/` — Next.js 16 + Nextra documentation site (English only, under `docs/app/en/`)
- `packages/` — MCP server, npm CLI wrapper
- `testing/e2e/` — End-to-end tests (Swarm in Docker-in-Docker, host provisioning)

## Repository Structure

```
cli/          # TypeScript CLI application (Bun)
cli/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
docs/            # Next.js 16 + Nextra documentation site (pages in docs/app/en/)
packages/        # Additional packages (MCP server, npm CLI wrapper)
scripts/         # Build & version management scripts
testing/e2e/     # End-to-end tests (two suites: swarm/ and setup/)
```

## Common Commands

### CLI (`cli/`)

```bash
bun install                    # Install dependencies
bun run typecheck              # TypeScript validation (tsc --noEmit)
bun run lint                   # Biome lint (no console.*, no any, no unused imports)
bun run lint:fix               # Biome lint with auto-fix
bun test src/                  # Unit tests
bun run dev <command> [args]   # Run the CLI from source, in the current directory (scripts/dev.ts)
bun run build                  # Build all platform binaries
bun run build:linux            # Build Linux x64 binary only
bun run build:windows          # Build Windows x64 binary only
bun run ui:build               # Build Angular UI (cd ui && pnpm build)
```

### WebUI (`cli/ui/`)

```bash
pnpm install                   # Install dependencies
pnpm build                     # Production build
pnpm start                     # Angular dev server on port 4201, proxying /api and /ws to the CLI's API server on 4200
```

To work on the UI, run `bun run dev ui` in `cli/` (API server on 4200) next to `pnpm start`, and open `http://localhost:4201`. Without the Angular server, `dockflow ui` serves the built `cli/ui/dist/` (or the copy embedded in the binary).

### Docs (`docs/`)

```bash
pnpm install                   # Install dependencies
pnpm dev                       # Next.js dev server
pnpm build                     # UI demo build + Next.js build + LLM text generation, then Pagefind indexing
```

### Shell Linting

```bash
./scripts/lint-shell.sh        # ShellCheck on all .sh files
```

### E2E Tests (Linux/WSL/Windows, requires Docker)

```bash
cd testing/e2e/swarm && bun test tests/   # Swarm suite (DinD, 2 nodes)
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

Entry point `cli/src/index.ts` creates the program, registers every command through `registerAllCommands()` (`cli/src/commands/register-all.ts`, the one list of commands) and sets up the `--verbose` flag via a global preAction hook. Adding a command or an option means documenting it on `docs/app/en/cli/page.mdx`: the unit test `docs-sync.test.ts` fails otherwise.

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
Always throw these typed errors from commands. The `withErrorHandler` wrapper displays the message + suggestion and exits with the error code (the `ErrorCode` enum is the table of exit codes, mirrored on the CLI page of the docs). Stack traces only show in DEBUG/CI or for unexpected errors.

A command run in a container exits with the container's own code through `ExecExitError`, which is not a `CLIError`: error codes are exit codes, and a container's 62 must not read as `INVALID_ARGUMENT`.

**Interrupts:** `utils/interrupt.ts` owns SIGINT and SIGTERM. Work that must clean up before exiting registers with `onInterrupt()`; the first signal runs the handlers, a second one (or a signal with none registered) exits at once, with 130 for SIGINT and 143 for SIGTERM. A command that changes the stack runs inside `withDeployLock()` (`commands/with-lock.ts`), which takes the deploy lock, hands the action an `AbortSignal` and releases the lock in `finally`; `deploy` has its own handler because it must also undo its uploads and release record.

### Services Layer

`cli/src/services/` follows a two-tier naming convention. The shape of the export tells what it is:

| Shape | Suffix | Examples | Import style |
|---|---|---|---|
| Stateful class (wraps a connection / holds state) | no suffix | `SwarmStack`, `SwarmContainers`, `SwarmProxy`, `Audit`, `Lock`, `Release`, `Metrics`, `Backup`, `HealthCheck` | `new SwarmStack(conn)` |
| Pure module (stateless free functions) | no class | `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts`, `plugin.ts` | `import * as Compose from '../services/compose'` |

**Rules:**
- Never append `Service` to anything new. The word is too vague — if the class wraps state, drop the suffix; if it's just functions, make it a module.
- Stateful class files are named after the singular noun (e.g. `lock.ts` exports `class Lock` + `createLock()` factory).
- Module files export top-level `export function` declarations and are imported with `import * as Xxx from '...'`.

**Swarm** (`cli/src/services/swarm/`): commands reach the cluster through these classes, never with Swarm commands of their own:

- `SwarmStack` (`stack.ts`) — stack lifecycle: deploy, remove, getServices, scale, rollback, list stacks, and the internal health check (`checkInternalHealth`: tasks in their desired state, from `docker service ps` + UpdateStatus)
- `SwarmContainers` (`containers.ts`) — exec/shell/copy/logs in containers, found with `docker ps` across all nodes
- `SwarmProxy` (`proxy.ts`) — Traefik management
- `types.ts` holds the data they take and return; `docker.ts` the Docker queries they share; `copy.ts` plans `dockflow cp`

**Stateful classes** (`cli/src/services/*.ts`, no Service suffix):
- `Metrics` (`metrics.ts`) — deployment metrics read/write, connection-bound
- `Lock` (`lock.ts`) — deployment lock management (acquire/release with stale detection)
- `Backup` (`backup.ts`) — backup/restore for accessories, holds manager + worker connections
- `Audit` (`audit.ts`) — deployment audit log entries on remote manager
- `Release` (`release.ts`) — release directory management, rollback, cleanup of old releases
- `HealthCheck` (`health-check.ts`) — HTTP endpoint checks with retry (uses `SwarmStack` for the internal check)

Each stateful class exposes a matching factory (`createLock`, `createBackup`, …) where construction needs defaults from config.

**Pure modules** (`cli/src/services/*.ts`, imported via `import * as`):
- `compose.ts` — template rendering (Nunjucks), YAML load/serialize, Swarm/accessory deploy config injection, Traefik label injection, image tag updates
- `build.ts` — local/remote Docker/Podman image builds (parses compose YAML, assembles tar contexts in memory)
- `distribution.ts` — image distribution (SSH pipe for Docker/Podman), registry login/push
- `hook.ts` — pre/post build/deploy hooks (local via `Bun.spawn`, remote via SSH)
- `notification.ts` — HMAC-signed HTTP webhooks on deploy events
- `history-sync.ts` — replicates audit/metrics to the other nodes
- `plugin.ts` — discovers, validates and expands plugins (built-in and the project's own)

**Container engine support:**

Config field `container_engine: 'docker' | 'podman'` (auto-detected if not set). Affects the `build` module (build command) and `distribution` module (save/load/push).

Services and modules use the `Result<T, E>` type pattern (`ok()` / `err()`) from `cli/src/types/`.

**Multi-node awareness:** Classes that need to find or operate on containers (`Backup`, `SwarmContainers`) accept an `allConnections: SSHKeyConnection[]` parameter alongside the manager connection. This is required because in a multi-node Swarm, a container may run on any worker — not just the manager. Always pass `getAllNodeConnections(env)` when creating these.

### Console Output

All CLI output goes through `cli/src/utils/output.ts` helpers. **Never use `console.log` directly.**

Key helpers: `printSuccess`, `printError`, `printWarning`, `printInfo`, `printDebug` (verbose-only), `printDim`, `printBlank`, `printJSON`, `printRaw`, `printIntro`, `printOutro`, `printNote`, `printSection`, `printTableRow`.

Formatters: `formatDuration(seconds)`, `formatBytes(bytes)`, `formatRelativeTime(iso)`.

Verbose mode controlled by `setVerbose()` / `isVerbose()`.

### Config System

- **Zod schemas**: `cli/src/schemas/` — runtime validation of `.dockflow/config.yml` (`config.schema.ts`), `servers.yml` (`servers.schema.ts`) and the flat `dockflow.yml` (`root-config.schema.ts`)
- **TypeScript interfaces**: `cli/src/utils/config.ts` (`DockflowConfig`) and `cli/src/types/` (`ServersConfig`, connections)
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
5. Build images (local or remote, Docker or Podman), distribute to nodes: streamed over SSH (`docker save | docker load`) or pushed to a registry
6. Create release directory on manager, upload compose file
7. Deploy: `docker stack deploy -c -` (accessories first with hash-based change detection)
8. Health checks: internal (Swarm task states) + HTTP endpoint checks
9. Cleanup old releases, write audit/metrics, sync history to all nodes
10. Release lock (always, even on failure)

All steps are in `cli/src/commands/deploy.ts` using the services layer.

### Host Provisioning (`commands/setup/provision.ts`)

`dockflow setup` provisions hosts in pure TypeScript (the binary does the work on the host; nothing is cloned there). Local setup requires root (no sudo binary needed — commands run directly). Steps, all idempotent:
- Docker install via the official `get.docker.com` script (multi-distro), skippable with `--skip-docker-install`
- `/var/lib/dockflow` creation owned by the deploy user
- The filter of published ports (`commands/setup/public-ports.ts`): installs `services/public-ports.sh` as `/usr/local/sbin/dockflow-public-ports` plus a systemd unit ordered before docker.service, records the ports published at first install so no running service is cut, and a sudo rule for the deploy user; `--no-port-filter` removes it and leaves `/etc/dockflow/public-ports.off`. Each deploy records the project's `firewall.public_ports` (+ Traefik's 80/443) on every node (`applyPublicPorts` in `commands/deploy-phases/networks.ts`)
- Optional nginx install (package-manager aware)

Remote setup (`setup user@host`) ships the version-pinned binary and forwards flags — including `--user`/`--deploy-password` to create the deploy user non-interactively. Forwarded values are shell-quoted (`buildForwardFlags` in `setup/forward.ts`).

### Remote Directory Permissions

All directories under `/var/lib/dockflow/` are created by the deploy command (via `SwarmStack`) with proper ownership so the deploy user can write to them directly via SSH without sudo. The `dockflow setup` command also creates the base `/var/lib/dockflow` directory.

Directory constants are defined in `cli/src/constants.ts` (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, `DOCKFLOW_AUDIT_DIR`, `DOCKFLOW_METRICS_DIR`, `DOCKFLOW_BACKUPS_DIR`, `DOCKFLOW_ACCESSORIES_DIR`, `DOCKFLOW_UPLOAD_BACKUPS_DIR`).

### API Server & WebUI

`cli/src/api/server.ts` — Bun HTTP server with WebSocket support. Serves the Angular UI (embedded in binary via `ui-manifest.generated`, or from `ui/dist/` in dev).

Routes in `cli/src/api/routes/`:
- REST: `/api/servers`, `/api/services`, `/api/config`, `/api/project`, `/api/deploy`, `/api/operations`, `/api/accessories`, `/api/backup`, `/api/resources`, `/api/locks`, `/api/metrics`, `/api/compose`, `/api/topology`, `/api/health`
- WebSocket: `/ws/ssh/:serverName` (interactive SSH), `/ws/exec/:serviceName` (docker exec)

WebSocket sessions include heartbeat (30s), idle timeout (15min), and watchdog cleanup (60s).

Response helpers: `jsonResponse()`, `errorResponse()` — both include CORS headers.

### WebUI Architecture

Angular 21 standalone components with lazy-loaded routes in `cli/ui/src/app/app.routes.ts`:
- 11 feature modules: dashboard, servers, services, logs, deploy, build, accessories, monitoring, resources, topology, settings
- `settings` route has an `unsavedChangesGuard`
- Shared components (sidebar, header) in `cli/ui/src/app/shared/`

### Constants

Key values in `cli/src/constants.ts`: `DOCKFLOW_VERSION` (from package.json), `DEFAULT_SSH_PORT` (22), `LOCK_STALE_THRESHOLD_MINUTES` (30), `CONVERGENCE_TIMEOUT_S` (300), `CONVERGENCE_INTERVAL_S` (5), directory paths (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, etc.).

## E2E Tests

Two independent suites under `testing/e2e/`, each with its own `bunfig.toml` preload (see `testing/e2e/README.md` for conventions). Both build the binary they test, or use the one named by `DOCKFLOW_E2E_BINARY`.

**Swarm suite** (`swarm/tests/01-15`): Docker-in-Docker with a manager (`dockflow-test-manager`, SSH port 32222) and worker (`dockflow-test-worker-1`, port 32223), compose project `dockflow-swarm`. The preload resets the cluster and pre-deploys the shared test-app. One file per area:

| File | Covers |
|---|---|
| `01-build` | `dockflow build` |
| `02-deploy` | deploy over two nodes, replicas distributed |
| `03-backup` | backup, restore and prune, redis with appendonly |
| `04-remote-build` | build on the server |
| `05-http-healthcheck` | HTTP health checks run remotely; a failing endpoint (dedicated stack) |
| `06-rollback` | automatic rollback on a failed health check (`test-app-rb`), manual rollback and release retention |
| `07-uploads` | `uploads:` on every node, rolled back on a failed deploy (`test-app-up`) |
| `08-exec-logs` | `dockflow exec` (exit code, `-e`) and `dockflow logs` (`-n all`, a bad `--tail`) across nodes |
| `09-registry` | registry distribution: anonymous `registry:2` at `localhost:35000` and one that asks for credentials at `:35001` (`test-app-reg`, pinned to the manager) |
| `10-proxy-routes` | `proxy.routes`: an accessory routed by Traefik on two ports of one domain (`test-app-routes`) |
| `11-public-ports` | the filter of published ports, installed on both nodes, the worker standing for the internet (`test-app-ports`, filter removed afterwards) |
| `12-locks` | the deploy lock: held by a running deploy, `dockflow lock`, takeover of a dead holder's lock |
| `13-interrupt` | Ctrl+C during a deploy exits 130 and releases the lock (Linux and macOS only) |
| `14-accessories-remove` | `accessories remove --volumes` finishes a removal interrupted after the stack was gone, and the next deploy recreates the accessories (`test-app-acc`) |
| `15-day2` | the day-2 commands on one stack (`test-app-day2`): `status`, `version`, `ps`, `details`, `list`, `diagnose`, `scale` and its refusals, `restart`, stopping and redeploying the accessories and the app, `history` |

**Setup suite** (`setup/tests/20-21`): host provisioning on a clean `ubuntu:24.04` container (`dockflow-test-setup`). `20-setup` runs the cross-compiled Linux binary inside it: non-interactive `dockflow setup`, Docker install via get.docker.com, deploy user + docker group, `/var/lib/dockflow` permissions, the filter of published ports and its sudo rule (installed, not loaded: the container cannot run iptables), an idempotent re-run, and `--no-port-filter`. `21-init` runs the compiled binary's `dockflow init` scaffolding.

Test helpers (`helpers/`): `cli.ts` (runs the CLI, also in the background), `fixtures.ts` (temp-dir fixture copies — fixture templates in `fixtures/` are read-only, tests never write into the repo tree), `docker.ts` (Swarm assertions), `cluster.ts` (cluster lifecycle), `connection.ts` (ports and credentials), `lock.ts`, `artifacts.ts` and `debug-dump.ts` (failure dump).

E2E tests run on Linux, WSL and Windows (Docker required). CI runs both suites as parallel matrix jobs.

## CI/CD Workflows (`.github/workflows/`)

- **cli-checks.yml** — Runs on push to main/develop and PRs, and is called by publish-cli.yml. Three jobs: `checks` (typecheck, Biome lint, `bun test src/` in `cli/`), `e2e-checks` (typecheck and lint of the `testing/e2e` harness) and `mcp` (build, typecheck and test `packages/mcp-server`).
- **e2e-tests.yml** — Runs on push to main/develop and PRs, and is called by publish-cli.yml. Matrix of parallel jobs (swarm, setup), each running `bun test tests/` in `testing/e2e/<suite>/`, then an `E2E summary` job that fails when a suite failed or did not run. When called with `binary_artifact`, it tests that binary instead of building from source.
- **publish-cli.yml** — Triggered by version tags (`X.Y.Z`, with an optional suffix). Builds the UI and the binaries (linux-x64/arm64, macos-x64/arm64, windows-x64) and `SHA256SUMS`, runs `cli-checks.yml` and the setup e2e suite on the built binary, then creates the GitHub Release, publishes to npm (`@dockflow-tools/cli`) and, for a stable release, calls deploy-docs.yml.
- **publish-mcp.yml** — Triggered by `mcp-X.Y.Z` tags or by hand. Builds, tests and publishes `@dockflow-tools/mcp` to npm with provenance.
- **deploy-docs.yml** — Documentation site deployment. Runs the published CLI (`npx @dockflow-tools/cli deploy production`). Runs on pushes to main touching `docs/**` or `cli/ui/**`, by hand, and, called by publish-cli.yml, after every stable release.
- **shell-lint.yml** — ShellCheck and shfmt through `scripts/lint-shell.sh`, on PRs and pushes to main/develop.

CI/CD integration is handled entirely by the CLI itself — no reusable workflows or external templates needed. The CLI auto-detects environment and version from CI provider env vars (GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket Pipelines) when `dockflow deploy` or `dockflow build` are called without arguments. Users generate a standalone CI workflow via `dockflow init`.

CI secrets format: `{ENV}_{SERVER}_CONNECTION` = base64-encoded JSON `{host, port, user, privateKey, password?}` (`utils/connection-parser.ts`).

## Development Rules

- **Typecheck before committing**: Run `bun run typecheck` in `cli/` — zero errors required.
- **Test and lint before committing**: Run `bun test src/` and `bun run lint` in `cli/`. Biome enforces: no `console.*` outside `utils/output.ts`, no `any`, no unused imports (config in `cli/biome.json`).
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes.
- **Config schema + interface parity**: Update both Zod schema and TypeScript interface when adding config fields.
- **Error handling**: Throw typed `CLIError` subclasses from commands. Never catch-and-exit manually.
- **Services for container ops**: Use the services layer (`cli/src/services/`) for stack/container interactions, not raw SSH commands in command handlers.
- **Swarm access**: New commands that interact with stacks/containers go through `SwarmStack`, `SwarmContainers` or `SwarmProxy` (`cli/src/services/swarm/`), not Swarm commands in command handlers.
- **Service naming**: Follow the two-tier convention (see *Services Layer*): plain nouns for stateful classes, module imports for stateless functions. Never introduce a new `*Service` class.
- **Multi-node services**: When creating `Backup` or `SwarmContainers`, always pass `getAllNodeConnections(env)` so container lookups work on worker nodes too.
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
- Commands that install or run the CLI pin it with `__DOCKFLOW_VERSION__`, never a written version: the docs build writes npm's latest there (`docs/cli-version.mjs`), and every release redeploys the docs.

### Navigation and index

After creating a new page:
1. Add its slug to `docs/app/en/configuration/_meta.ts` (or the relevant `_meta.ts`) so it appears in the sidebar
2. Add a `<Cards.Card>` entry in the parent index page (`docs/app/en/configuration/page.mdx`)

`docs/scripts/generate-llms-txt.ts` reads the `_meta` files, so the LLM context follows the navigation without a further step.

### CLI page

`docs/app/en/cli/page.mdx` documents every command and long option of the CLI, and the unit test `cli/src/__tests__/docs-sync.test.ts` fails when one is missing or when the page names one that no longer exists. Each command has a code block starting with `dockflow <command>`, and its options sit in the table of that section. The exit codes table follows `ErrorCode` in `cli/src/utils/errors.ts`.
