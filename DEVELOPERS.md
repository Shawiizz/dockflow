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

### Dev script (for deploy/build commands)

The `dev.ts` script sets `DOCKFLOW_DEV_PATH` so the CLI uses your local Ansible roles instead of the published Docker image. Run it from your **target project directory**:

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

When you run `dockflow deploy`, the CLI connects directly to servers via SSH (using the `ssh2` library). All deploy operations — template rendering, image building/distribution, stack deployment, health checks — happen in TypeScript over SSH. No Docker containers or Ansible are involved in the deploy flow.

Ansible is only used for `dockflow setup` (one-shot machine provisioning), where it runs inside a Docker container to configure hosts.

This distinction matters when working on E2E tests. See the E2E section below.

---

## E2E Tests

> **Run from WSL only** — not PowerShell or CMD.

### Prerequisites

```bash
sudo apt install sshpass jq
```

Docker Desktop must be running with WSL integration enabled.

### Running the tests

```bash
cd testing/e2e
bun test tests/                       # full suite: Swarm + k3s (~5-10 min)
bun test tests/02-deploy.test.ts      # single Swarm test
bun test tests/10-k3s-deploy.test.ts  # k3s tests only
bun run teardown.ts                   # clean up containers afterwards
```

### Test architecture

Two Docker containers simulate a real Swarm cluster, and a separate container runs a single-node k3s cluster:

| Container | Role |
|-----------|------|
| `dockflow-test-manager` | Swarm manager — SSH on `localhost:2222` |
| `dockflow-test-worker-1` | Swarm worker — SSH on `localhost:2223` |
| `dockflow-test-k3s` | k3s single-node — SSH on `localhost:2224` |

The `.env.dockflow` in test fixtures uses `localhost:222x` port mappings to reach the containers from the host.

### What's tested

**Swarm tests** (`01-05`): build, deploy (2 replicas, distributed), health checks, Traefik routing, backup/restore (Redis), remote build.

**k3s tests** (`10`): deploy to k3s, namespace creation, deployment replicas, logs, exec, scale up/down.

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

Used only under `cli/src/services/orchestrator/` for things that have more than one implementation (Swarm + k3s).

```ts
// Interface
export interface StackBackend {
  deploy(input: StackDeployInput): Promise<Result<void, DeployError>>;
  // ...
}

// Implementations
export class SwarmStackBackend implements StackBackend { /* ... */ }
export class K3sStackBackend implements StackBackend { /* ... */ }

// Consumed via factory
const backend = createStackBackend('swarm', managerConn);
```

Current backends: `StackBackend`, `ContainerBackend`, `HealthBackend`, `ProxyBackend`.

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

Current modules: `compose.ts`, `build.ts`, `distribution.ts`, `hook.ts`, `notification.ts`, `history-sync.ts`, `k8s-manifest.ts`.

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
5. **Ansible defaults**: centralize in `ansible/group_vars/all.yml`, never hardcode in roles
6. **Typecheck**: `bun run typecheck` — zero errors
7. **Documentation**: add or update a page in `docs/app/`

See `CLAUDE.md` for detailed patterns and rules.
