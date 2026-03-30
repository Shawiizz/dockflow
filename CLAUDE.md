# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dockflow is a deployment framework for Docker applications using Docker Swarm orchestration. It consists of a TypeScript CLI (Bun runtime), an Angular WebUI, Ansible playbooks, and a Next.js documentation site.

## Repository Structure

```
cli-ts/          # TypeScript CLI application (Bun)
cli-ts/ui/       # Angular 21 WebUI (PrimeNG + Tailwind)
ansible/         # Ansible roles and playbooks for deployment
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
cd testing/e2e && bash run-tests.sh       # Full test suite (spins up Docker Swarm in containers)
cd testing/e2e && bash teardown.sh         # Cleanup test VMs
```

### Version Management

```bash
node scripts/version-manager.js dev       # Bump dev version (e.g., 2.0.23 → 2.0.23-dev1)
node scripts/version-manager.js release   # Release version (e.g., 2.0.23-dev1 → 2.0.24)
node scripts/version-manager.js patch     # Bump patch version
```

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
- `StackService` — stack lifecycle (getServices, exists, scale, etc.)
- `ExecService` — remote command execution in containers
- `LogsService` — log streaming
- `MetricsService` — container stats
- `LockService` — deployment lock management
- `BackupService` — backup/restore for accessories

Services use the `Result<T, E>` type pattern (`ok()` / `err()`) from `cli-ts/src/types/`.

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

### CLI → Ansible Flow

1. CLI builds an `AnsibleContext` JSON object (`cli-ts/src/utils/context-generator.ts`)
2. Written to temp file via `writeContextFile()`
3. A Docker container (`shawiizz/dockflow-ci:latest`) runs with project + context mounted
4. Ansible receives all config via `--extra-vars @/tmp/dockflow_context.json`
5. Container paths: project at `/project`, framework at `/tmp/dockflow`, context at `/tmp/dockflow_context.json`

The Docker runner logic lives in `cli-ts/src/utils/docker-runner.ts`.

### Ansible Defaults

Centralized in `ansible/group_vars/all.yml` under `dockflow_defaults` and `dockflow_paths`:
- `dockflow_defaults` — timeouts (convergence: 300s, healthcheck: 120s, lock: 1800s, hooks: 300s), retries, release management
- `dockflow_paths` — all under `/var/lib/dockflow/` (stacks, accessories, locks, audit, metrics, backups)

Roles **always** reference `dockflow_defaults.*` — never hardcode values. Shared utility roles live in `ansible/roles/_shared/` (create-resources, inject-deploy, registry-login, wait-convergence).

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

Key values in `cli-ts/src/constants.ts`: `DOCKFLOW_VERSION` (from package.json), `ANSIBLE_DOCKER_IMAGE`, `CONTAINER_PATHS`, `DEFAULT_SSH_PORT` (22), `LOCK_STALE_THRESHOLD_MINUTES` (30).

## CI/CD Workflows (`.github/workflows/`)

- **build-cli.yml** — Triggered by version tags. Builds multi-platform binaries (linux-x64/arm64, macos-x64/arm64, windows-x64), creates GitHub Release, publishes to npm (`@dockflow-tools/cli`).
- **deploy.yml** — Reusable workflow. Determines env from tag suffix (-staging → staging, else production). Installs CLI binary and runs `dockflow deploy`.
- **deploy-docs.yml** — Documentation site deployment.
- **e2e-tests.yml** — Runs on push to main/develop and PRs. Executes `testing/e2e/run-tests.sh`.
- **shell-lint.yml** — ShellCheck validation.

CI secrets format: `{ENV}_{SERVER}_{CONNECTION}` = base64-encoded `user@host:port|privateKey|password`.

## Development Rules

- **Typecheck before committing**: Run `bun run typecheck` in `cli-ts/` — zero errors required.
- **Use centralized output helpers**: Never add raw `console.log`/`console.error` in CLI commands or API routes.
- **Config schema + interface parity**: Update both Zod schema and TypeScript interface when adding config fields.
- **Ansible variable centralization**: Defaults in `ansible/group_vars/all.yml`. Roles reference `dockflow_defaults.*`.
- **Error handling**: Throw typed `CLIError` subclasses from commands. Never catch-and-exit manually.
- **Services for Docker ops**: Use the services layer (`cli-ts/src/services/`) for Docker Swarm interactions, not raw SSH commands in command handlers.

## Self-Review Before Finishing

After implementing any feature or fix, always ask:

- **Is the logic correct?** Re-read the code with fresh eyes. Check edge cases: empty inputs, missing fields, format variations (e.g. port formats `host:container` vs `ip:host:container`).
- **Is it consistent with the rest of the codebase?** Patterns, naming, error handling, output style.
- **Did I break anything?** Run `bun run typecheck`. Think about what else calls the code I changed.
- **Is this the simplest approach?** If the implementation feels complex, step back — there's often a simpler path.
- **Are there silent failure modes?** Especially in Ansible Jinja2 (type coercions, undefined variables, filter behavior differences).

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
