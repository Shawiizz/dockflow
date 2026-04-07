# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dockflow is a CLI-first deployment framework for Docker Swarm. A single TypeScript binary handles building, deploying, and managing Docker Swarm stacks via direct SSH — no runtime dependencies beyond the binary itself. Ansible is only used for one-shot machine provisioning (`dockflow setup`).

**Stack at a glance:**
- `cli-ts/` — TypeScript CLI (Bun runtime) + embedded Angular WebUI — handles all deploy logic via ssh2
- `ansible/` — Ansible roles for machine provisioning only (`configure_host.yml`)
- `docs/` — Next.js 15 + Nextra documentation site
- `packages/` — MCP server, npm CLI wrapper
- `testing/e2e/` — End-to-end tests using Docker-in-Docker Swarm

## Repository Structure

```
cli-ts/          # TypeScript CLI application (Bun)
cli-ts/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
ansible/         # Ansible roles for machine provisioning (setup only)
docs/            # Next.js 15 + Nextra documentation site
packages/        # Additional packages (MCP server, npm CLI wrapper)
scripts/         # Build & version management scripts
testing/e2e/     # End-to-end tests (run from WSL/CI only)
```

## Common Commands

### CLI (`cli-ts/`)

```bash
bun install                    # Install dependencies
bun run typecheck              # TypeScript validation (tsc --noEmit)
bun run dev <command> [args]   # Run CLI locally in dev mode
bun run build                  # Build all platform binaries
bun run build:linux            # Build Linux x64 binary only
bun run build:windows          # Build Windows x64 binary only
bun run ui:build               # Build Angular UI (cd ui && pnpm build)
```

### WebUI (`cli-ts/ui/`)

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
cd testing/e2e && bun test tests/          # Full test suite (spins up Docker Swarm in containers)
cd testing/e2e && bun run teardown.ts      # Cleanup test VMs
```

### Version Management

```bash
node scripts/version-manager.js dev       # Bump dev version (e.g., 2.0.23 → 2.0.23-dev1)
node scripts/version-manager.js release   # Release version (e.g., 2.0.23-dev1 → 2.0.24)
node scripts/version-manager.js downgrade # Downgrade version
```

## Architecture: SSH-Only Deployment

All CLI operations (deploy, build, backup, logs, exec, shell, status) connect directly to remote nodes via the `ssh2` library. Connection credentials come from `.env.dockflow` (or CI secrets). There is **one SSH context** — the CLI's machine must be able to reach all target hosts.

Ansible is only used for `dockflow setup` (one-shot machine provisioning via `configure_host.yml`). It runs inside a Docker container for that command only.

## Key Architecture Patterns

### CLI Command Pattern

Commands live in `cli-ts/src/commands/` and follow this structure:
1. Export a `register<Name>Command(program: Command)` function
2. Use Commander.js `.command()`, `.option()`, `.description()`, `.action(withErrorHandler(...))`
3. Commands **throw errors** — never call `process.exit()` directly
4. The `withErrorHandler()` wrapper (from `utils/errors.ts`) catches, formats, and exits

Entry point `cli-ts/src/index.ts` registers all commands and sets up the `--verbose` flag via a global preAction hook.

### Error Handling Hierarchy

Custom error classes in `cli-ts/src/utils/errors.ts`:
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

`cli-ts/src/services/` contains type-safe service classes for Docker Swarm operations:

**Read/monitoring services:**
- `StackService` — stack lifecycle (getServices, exists, scale, etc.). Also holds `findContainerForService()` which searches all Swarm nodes in parallel via `Promise.any()`.
- `ExecService` — remote command execution in containers
- `LogsService` — log streaming
- `MetricsService` — container stats (read) + `MetricsWriteService` (write deployment metrics)
- `BackupService` — backup/restore for accessories

**Deploy services (replace former Ansible roles):**
- `ComposeService` — template rendering (Nunjucks), YAML load/serialize, Swarm deploy config injection, Traefik label injection, image tag updates
- `SwarmDeployService` — creates external networks/volumes, deploys stacks via `docker stack deploy -c -`, waits for convergence, deploys accessories with hash-based change detection
- `BuildService` — local/remote Docker image builds. Parses compose YAML to extract build targets, assembles tar contexts in memory
- `DistributionService` — image distribution to Swarm nodes (base64 chunked transfer over SSH), registry login/push
- `HealthCheckService` — Swarm internal health checks (auto-rollback detection) + HTTP endpoint checks with retry
- `ReleaseService` — release directory management, rollback, cleanup of old releases
- `HookService` — pre/post build/deploy hooks (local via Bun.spawn, remote via SSH)
- `LockService` — deployment lock management (acquire/release with stale detection)
- `AuditService` — deployment audit log entries on remote manager
- `HistorySyncService` — replicates audit/metrics to non-manager nodes

Services use the `Result<T, E>` type pattern (`ok()` / `err()`) from `cli-ts/src/types/`.

**Multi-node awareness:** Services that need to find or operate on containers (BackupService, ExecService) accept an `allConnections: SSHKeyConnection[]` parameter alongside the manager connection. This is required because in a multi-node Swarm, a container may run on any worker — not just the manager. Always pass `getAllNodeConnections(env)` when creating these services.

### Console Output

All CLI output goes through `cli-ts/src/utils/output.ts` helpers. **Never use `console.log` directly.**

Key helpers: `printSuccess`, `printError`, `printWarning`, `printInfo`, `printDebug` (verbose-only), `printDim`, `printBlank`, `printJSON`, `printRaw`, `printHeader`, `printSection`, `printTableRow`.

Formatters: `formatDuration(seconds)`, `formatBytes(bytes)`, `formatRelativeTime(iso)`.

Verbose mode controlled by `setVerbose()` / `isVerbose()`.

### Config System

- **Zod schemas**: `cli-ts/src/schemas/config.schema.ts` — runtime validation of `.dockflow/config.yml`
- **TypeScript interfaces**: `cli-ts/src/utils/config.ts` — `DockflowConfig`, `ServersConfig`, etc.
- **Both must stay in sync** when adding/changing config fields.
- Config loading: `loadConfig()` finds the `.dockflow/` directory by walking up from CWD via `getProjectRoot()`.

### SSH Connections

Typed with ssh2 `ConnectConfig` in `cli-ts/src/utils/ssh.ts`. Connection types in `cli-ts/src/types/connection.ts`:
- `SSHKeyConnection` — host, port, user, privateKey
- `SSHPasswordConnection` — host, port, user, password

Keys are passed in-memory (never written to temp files). Core functions: `sshExec()` (collect output), `sshExecStream()` (stream with callbacks), `sshShell()` (interactive).

### Deploy Flow (TypeScript, direct SSH)

The `dockflow deploy` command executes entirely in TypeScript via ssh2:

1. Load config, resolve server connections, acquire deployment lock
2. Render Nunjucks templates (docker-compose, env files)
3. Prepare compose: load YAML, update image tags, inject Swarm defaults, inject Traefik labels
4. Build images (local or remote), distribute to Swarm nodes (base64 transfer or registry push)
5. Create release directory on manager, upload compose file
6. Deploy accessories (hash-based change detection) then app stack via `docker stack deploy -c -`
7. Wait for Swarm convergence, run health checks (internal + HTTP endpoints)
8. Cleanup old releases, write audit/metrics, sync history to all nodes
9. Release lock (always, even on failure)

All steps are in `cli-ts/src/commands/deploy.ts` using the services layer.

### Ansible (Setup Only)

Ansible is only used for `dockflow setup` via `ansible/configure_host.yml`. Remaining roles:
- `geerlingguy.docker` — multi-distro Docker install
- `nginx` — reverse proxy setup
- `portainer` — Portainer stack deployment

### Remote Directory Permissions

All directories under `/var/lib/dockflow/` are created by the deploy command (via `SwarmDeployService`) with proper ownership so the deploy user can write to them directly via SSH without sudo. The `dockflow setup` command also creates the base `/var/lib/dockflow` directory.

Directory constants are defined in `cli-ts/src/constants.ts` (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, `DOCKFLOW_AUDIT_DIR`, `DOCKFLOW_METRICS_DIR`, `DOCKFLOW_BACKUPS_DIR`, `DOCKFLOW_ACCESSORIES_DIR`).

### API Server & WebUI

`cli-ts/src/api/server.ts` — Bun HTTP server with WebSocket support. Serves the Angular UI (embedded in binary via `ui-manifest.generated`, or from `ui/dist/` in dev).

Routes in `cli-ts/src/api/routes/`:
- REST: `/api/servers`, `/api/services`, `/api/config`, `/api/deploy`, `/api/operations`, `/api/accessories`, `/api/backup`, etc.
- WebSocket: `/ws/ssh/:serverName` (interactive SSH), `/ws/exec/:serviceName` (docker exec)

WebSocket sessions include heartbeat (30s), idle timeout (15min), and watchdog cleanup (60s).

Response helpers: `jsonResponse()`, `errorResponse()` — both include CORS headers.

### WebUI Architecture

Angular 21 standalone components with lazy-loaded routes in `cli-ts/ui/src/app/app.routes.ts`:
- 12 feature modules: dashboard, servers, services, logs, deploy, build, accessories, monitoring, resources, topology, settings
- `settings` route has an `unsavedChangesGuard`
- Shared components (sidebar, header) in `cli-ts/ui/src/app/shared/`

### Constants

Key values in `cli-ts/src/constants.ts`: `DOCKFLOW_VERSION` (from package.json), `DEFAULT_SSH_PORT` (22), `LOCK_STALE_THRESHOLD_MINUTES` (30), `CONVERGENCE_TIMEOUT_S` (300), `CONVERGENCE_INTERVAL_S` (5), directory paths (`DOCKFLOW_STACKS_DIR`, `DOCKFLOW_LOCKS_DIR`, etc.).

## E2E Tests

Tests run in Docker-in-Docker: a manager container (`dockflow-test-manager`) and a worker (`dockflow-test-worker-1`) form a real Swarm cluster. Tests are run via `bun test` (test files are in `testing/e2e/tests/`) and cover deployment, Traefik routing, backup/restore, and remote builds.

E2E tests run from WSL. The `.env.dockflow` file uses `localhost:222x` port mappings to reach the Docker-in-Docker containers from the host.

## CI/CD Workflows (`.github/workflows/`)

- **build-cli.yml** — Triggered by version tags. Builds multi-platform binaries (linux-x64/arm64, macos-x64/arm64, windows-x64), creates GitHub Release, publishes to npm (`@dockflow-tools/cli`).
- **deploy-docs.yml** — Documentation site deployment. Installs CLI and runs `dockflow deploy` directly.
- **e2e-tests.yml** — Runs on push to main/develop and PRs. Executes `bun test tests/` in `testing/e2e/`.
- **shell-lint.yml** — ShellCheck validation.

CI/CD integration is handled entirely by the CLI itself — no reusable workflows or external templates needed. The CLI auto-detects environment and version from CI provider env vars (GitHub Actions, GitLab CI, Jenkins, Buildkite) when `dockflow deploy` or `dockflow build` are called without arguments. Users generate a standalone CI workflow via `dockflow init`.

CI secrets format: `{ENV}_{SERVER}_{CONNECTION}` = base64-encoded `user@host:port|privateKey|password`.

## Development Rules

- **Typecheck before committing**: Run `bun run typecheck` in `cli-ts/` — zero errors required.
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes.
- **Config schema + interface parity**: Update both Zod schema and TypeScript interface when adding config fields.
- **Error handling**: Throw typed `CLIError` subclasses from commands. Never catch-and-exit manually.
- **Services for Docker ops**: Use the services layer (`cli-ts/src/services/`) for Docker Swarm interactions, not raw SSH commands in command handlers.
- **Multi-node services**: When creating `BackupService` or `ExecService`, always pass `getAllNodeConnections(env)` as the third argument so container lookups work on worker nodes too.
- **New directory paths**: Add constants in `cli-ts/src/constants.ts` and ensure the deploy command creates them on the remote host.
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
