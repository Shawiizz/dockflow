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
bun cli-ts/src/index.ts <command> [args]

# Examples
bun cli-ts/src/index.ts deploy staging
bun cli-ts/src/index.ts status production
```

### Dev script (for deploy/build commands)

The `dev.ts` script sets `DOCKFLOW_DEV_PATH` so the CLI uses your local Ansible roles instead of the published Docker image. Run it from your **target project directory**:

```bash
cd /path/to/my-app

# Run dockflow commands using local source
bun /path/to/dockflow/cli-ts/scripts/dev.ts deploy production --force
```

Recommended: create an alias:

```bash
# ~/.bashrc or ~/.zshrc
alias dockflow-dev='bun /path/to/dockflow/cli-ts/scripts/dev.ts'
```

### Typechecking

```bash
cd cli-ts
bun run typecheck   # must pass with zero errors before committing
```

### WebUI (hot-reload)

The UI proxies to the CLI's API server. You need two terminals:

```bash
# Terminal 1 — Angular dev server
cd cli-ts/ui && pnpm install && pnpm start   # port 4201

# Terminal 2 — CLI API server
cd cli-ts && bun run dev ui                  # port 4200, proxies to 4201
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
bun test tests/      # full suite (~5-10 min)
bun run teardown.ts  # clean up containers afterwards
```

### Test architecture

Two Docker containers simulate a real Swarm cluster:

| Container | Role |
|-----------|------|
| `dockflow-test-manager` | Swarm manager — SSH on `localhost:2222` |
| `dockflow-test-worker-1` | Swarm worker — SSH on `localhost:2223` |

The `.env.dockflow` in test fixtures uses `localhost:222x` port mappings to reach the containers from the host.

### What's tested

- Machine setup (Docker install, deploy user, SSH keys)
- Swarm cluster init (manager + worker)
- Application deployment (2 replicas, distributed across nodes)
- Health checks and HTTP accessibility
- Traefik reverse proxy routing (HTTP-only mode, no ACME)
- Backup and restore cycle (Redis accessory)
- Remote build

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

1. **Command**: add in `cli-ts/src/commands/`, register in `cli-ts/src/index.ts`
2. **Service logic**: put in `cli-ts/src/services/` if it involves Docker Swarm ops
3. **Config field**: update both `cli-ts/src/schemas/config.schema.ts` (Zod) and `cli-ts/src/utils/config.ts` (interface)
4. **New remote path**: add constants in `cli-ts/src/constants.ts` and ensure the deploy command creates them via `SwarmDeployService`
5. **Ansible defaults**: centralize in `ansible/group_vars/all.yml`, never hardcode in roles
6. **Typecheck**: `bun run typecheck` — zero errors
7. **Documentation**: add or update a page in `docs/app/`

See `CLAUDE.md` for detailed patterns and rules.
