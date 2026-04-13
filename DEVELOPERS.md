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

## Adding a New Feature

Quick checklist:

1. **Command**: add in `cli/src/commands/`, register in `cli/src/index.ts`
2. **Service logic**: put in `cli/src/services/` if it involves Docker Swarm ops
3. **Config field**: update both `cli/src/schemas/config.schema.ts` (Zod) and `cli/src/utils/config.ts` (interface)
4. **New remote path**: add constants in `cli/src/constants.ts` and ensure the deploy command creates them via `SwarmDeployService`
5. **Ansible defaults**: centralize in `ansible/group_vars/all.yml`, never hardcode in roles
6. **Typecheck**: `bun run typecheck` — zero errors
7. **Documentation**: add or update a page in `docs/app/`

See `CLAUDE.md` for detailed patterns and rules.
