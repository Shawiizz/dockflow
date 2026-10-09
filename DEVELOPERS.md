# Developer Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime (CLI)
- [Node.js](https://nodejs.org/) 22+ (WebUI)
- [pnpm](https://pnpm.io/) (WebUI and docs)
- Docker (E2E tests; on Windows, Docker Desktop with WSL integration)
- WSL2 on Windows, to run the tests that need a POSIX shell

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

### Dev script (to run the CLI from source in another project)

`cli/scripts/dev.ts` runs `cli/src/index.ts` with the arguments it is given, in the directory it is started from, so the CLI finds that project's `.dockflow/`. Run it from your **target project directory**:

```bash
cd /path/to/my-app

# Run dockflow commands using local source
bun /path/to/dockflow/cli/scripts/dev.ts deploy production --force
```

It adds nothing to the command line. For `dockflow setup user@host`, `--dev` builds the CLI from your checkout and uploads it to the server instead of downloading the release; pass it yourself.

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

The Angular dev server proxies `/api` and `/ws` to the CLI's API server (`cli/ui/proxy.conf.json`). You need two terminals:

```bash
# Terminal 1 — CLI API server (run from a project directory, it opens that project)
bun /path/to/dockflow/cli/scripts/dev.ts ui   # port 4200

# Terminal 2 — Angular dev server
cd cli/ui && pnpm install && pnpm start   # port 4201
```

Open `http://localhost:4201`. Without the Angular server, `dockflow ui` serves the UI built in `cli/ui/dist/` (`pnpm build`), or the copy embedded in a compiled binary.

---

## How Deploy Works (important for contributors)

When you run `dockflow deploy`, the CLI connects directly to servers via SSH (using the `ssh2` library). All deploy operations — template rendering, image building/distribution, stack deployment, health checks — happen in TypeScript over SSH. The only things that run on the servers are the `docker` commands the CLI sends.

`dockflow setup` provisions machines the same way: the CLI binary runs on the server (shipped over SSH for a remote setup) and configures it directly.

---

## E2E Tests

Two suites live under `testing/e2e/` (see `testing/e2e/README.md`): `swarm`, a two-node
Docker-in-Docker Swarm, and `setup`, host provisioning on a clean Ubuntu container. They run on
Linux, WSL and Windows with Docker.

### Running the tests

```bash
cd testing/e2e/swarm && bun test tests/                    # Swarm suite
cd testing/e2e/swarm && bun test tests/02-deploy.test.ts   # one file
cd testing/e2e/setup && bun test tests/                    # setup suite
bun run testing/e2e/teardown.ts                            # clean up containers afterwards
```

### Test architecture

| Container | Role |
|-----------|------|
| `dockflow-test-manager` | Swarm manager — SSH on `localhost:32222` |
| `dockflow-test-worker-1` | Swarm worker — SSH on `localhost:32223` |
| `dockflow-test-setup` | Clean Ubuntu host for the setup suite |

Each test copies a read-only fixture from `testing/e2e/fixtures/` into a temp directory and
writes its `.env.dockflow` there, with the `localhost` port mappings above.

### What's tested

**Swarm suite** (`swarm/tests/01-13`): build, deploy (2 replicas, distributed), backup/restore,
remote build, remote HTTP health checks, automatic and manual rollback, uploads, exec/logs,
registry distribution, `proxy.routes`, the filter of published ports, the deploy lock, and
Ctrl+C during a deploy.

**Setup suite** (`setup/tests/20-21`): non-interactive `dockflow setup` on a clean host,
`dockflow init`.

`CLAUDE.md` lists the file of each area and `testing/e2e/README.md` the conventions.

### Debug commands

```bash
# Access a test VM
docker exec -it dockflow-test-manager bash

# Check running containers inside the Swarm
docker exec dockflow-test-manager docker ps

# View a service's logs
docker exec dockflow-test-manager docker service logs test-app-test_web

# Check Swarm service status
docker exec dockflow-test-manager docker stack ps test-app-test
```

---

## Services Layer — Naming Convention

`cli/src/services/` uses a three-tier naming system. The suffix (or lack of one) tells you the shape of the export:

### 1. `*Backend` — polymorphic interfaces

Used only under `cli/src/services/orchestrator/`: the contracts the commands use, implemented for Swarm under `./swarm/`.

```ts
// Interface
export interface StackBackend {
  deploy(input: StackDeployInput): Promise<Result<void, DeployError>>;
  // ...
}

// Implementation
export class SwarmStackBackend implements StackBackend { /* ... */ }

// Consumed via factory
const backend = createStackBackend(managerConn);
```

Current backends: `StackBackend` (which also runs the internal health check), `ContainerBackend`, `ProxyBackend`.

### 2. Plain noun — stateful classes

One class per file, named after the singular noun. Wraps a connection or holds state across multiple calls.

```ts
// cli/src/services/lock.ts
export class Lock {
  constructor(private conn: SSHKeyConnection, private stackName: string) {}
  async acquire(opts: AcquireOptions): Promise<Result<void, LockError>> { /* ... */ }
  async release(): Promise<Result<void, LockError>> { /* ... */ }
  async status(): Promise<Result<LockStatus, LockError>> { /* ... */ }
}

// Factory for config-resolved defaults
export function createLock(
  conn: SSHKeyConnection,
  stackName: string,
  staleThresholdMinutes?: number,
): Lock { /* ... */ }
```

Current stateful classes: `Audit`, `Lock`, `Release`, `Metrics`, `Backup`, `HealthCheck`.

Callers:
```ts
import { createLock } from '../services/lock';
const lock = createLock(conn, stackName, config.lock?.stale_threshold_minutes);
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

Current modules: `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts`.

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

1. **Command**: add in `cli/src/commands/`, register in `cli/src/commands/register-all.ts`
2. **Service logic**: put in `cli/src/services/`. Pick the right shape (see *Services Layer — Naming Convention* above)
3. **Config field**: update both `cli/src/schemas/config.schema.ts` (Zod) and `cli/src/utils/config.ts` (interface)
4. **New remote path**: add constants in `cli/src/constants.ts` and ensure the deploy command creates them via the `StackBackend` implementations
5. **Typecheck, lint, tests**: from `cli/`, `bun run typecheck` (zero errors), `bun run lint` and `bun test src/`
6. **Documentation**: add or update a page in `docs/app/en/`. A new command or option goes on `docs/app/en/cli/page.mdx` (the `docs-sync` unit test fails without it), and a new error code in its exit codes table. A new page is added to the `_meta.ts` of its folder and, for a configuration page, to the cards of `docs/app/en/configuration/page.mdx`; the llms.txt files follow the `_meta` files by themselves.

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
