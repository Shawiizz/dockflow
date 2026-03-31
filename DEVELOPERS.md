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

When you run `dockflow deploy`, the CLI does **not** SSH directly to servers. Instead it:

1. Builds an `AnsibleContext` JSON from your config + servers
2. Launches a Docker container (`shawiizz/dockflow-ci:latest`) with the project and context mounted
3. Ansible runs **inside that container** and SSHes to your servers from there

This means Ansible connects from inside Docker — it resolves hostnames on the Docker network, not from your local machine.

**Direct SSH** (backup, logs, exec, shell) works differently — the CLI SSHes straight from your machine using the `ssh2` library. The same `.env.dockflow` credentials are used, but the network context is different.

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
bash run-tests.sh    # full suite (~5-10 min)
bash teardown.sh     # clean up containers afterwards
```

### Test architecture

Two Docker containers simulate a real Swarm cluster:

| Container | Role |
|-----------|------|
| `dockflow-test-manager` | Swarm manager — SSH on `localhost:2222` |
| `dockflow-test-worker-1` | Swarm worker — SSH on `localhost:2223` |

### The network context problem

The `.env.dockflow` in `testing/e2e/test-app/` contains **Docker-internal hostnames** (`dockflow-test-mgr`, `dockflow-test-w1`). These work for the deploy step (Ansible runs inside Docker on the same network), but not for direct CLI SSH from WSL.

`run-backup-test.sh` handles this by temporarily rewriting `.env.dockflow` with `localhost:2222`/`localhost:2223` before invoking CLI commands, then restoring it on exit via `trap`. This is intentional — in production, real servers have hostnames reachable from both Docker and the user's machine.

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
4. **New remote path**: add to directory creation loop in `ansible/deploy.yml` with `owner: "{{ ansible_user }}"`
5. **Ansible defaults**: centralize in `ansible/group_vars/all.yml`, never hardcode in roles
6. **Typecheck**: `bun run typecheck` — zero errors
7. **Documentation**: add or update a page in `docs/app/`

See `CLAUDE.md` for detailed patterns and rules.
