# Developer Guide

## CLI Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Node.js](https://nodejs.org/) 22+ (for the UI)
- A package manager for the UI (`npm`, `pnpm`, or `yarn`)

### Running the CLI locally

```bash
# From the project root
bun cli-ts/src/index.ts <command> [args]

# Examples
bun cli-ts/src/index.ts deploy staging
bun cli-ts/src/index.ts list env
```

### Dev script (for deploy/build)

The `dev.ts` script sets `DOCKFLOW_DEV_PATH` and auto-adds `--dev` for deploy/build commands:

```bash
cd cli-ts
bun run dev deploy staging
```

### WebUI Development

The UI is an Angular app in `cli-ts/ui/`. Development requires **two terminals**:

**Terminal 1** — Angular dev server (hot-reload):

```bash
cd cli-ts/ui
npm install   # first time only
npm start     # starts ng serve on port 4201
```

**Terminal 2** — CLI API server (proxies to Angular):

```bash
bun cli-ts/src/index.ts ui --dev
# API server on port 4200, proxies frontend requests to :4201
```

Then open `http://localhost:4200`.

The `--dev` flag makes the API server proxy all non-`/api/` requests to the Angular dev server on port 4201, giving you hot-reload while still having the API available.

Without `--dev`, the CLI serves the pre-built UI from `cli-ts/ui/dist/`.

### Building the CLI binaries

The build script compiles the CLI into standalone executables for all platforms. If the UI has been built beforehand, it embeds the UI assets into the binary.

```bash
cd cli-ts

# Build the UI first (optional, but required to embed it)
cd ui && npm install && npm run build && cd ..

# Build all platform binaries
bun run scripts/build.ts

# Build for a specific target
bun run scripts/build.ts linux-x64
```

Available targets: `linux-x64`, `linux-arm64`, `windows-x64`, `macos-x64`, `macos-arm64`

Binaries are output to `cli-ts/dist/`.

---

## E2E Tests

### Prerequisites

⚠️ **IMPORTANT**: Run tests from **WSL** (not PowerShell)

- Docker Desktop running
- `sshpass` installed: `sudo apt install sshpass`

## Shell Linting

Run shellcheck on all `.sh` files:

```bash
./scripts/lint-shell.sh
```

## Running Tests

```bash
# All tests (CLI + Deployment)
cd testing/e2e
bash run-tests.sh

# Cleanup
bash teardown.sh
```

## What's Tested

### CLI Setup Tests

**Location:** `testing/e2e/cli/run-tests.sh`

- ✅ Non-interactive machine setup (`dockflow setup auto`)
- ✅ Deploy user creation (dockflow)
- ✅ SSH key generation & auth
- ✅ Docker installation & permissions

### Swarm & Deployment Tests

**Location:** `testing/e2e/run-tests.sh`

- ✅ Swarm cluster setup (manager + worker)
- ✅ Application deployment with replicas
- ✅ Replica distribution across nodes
- ✅ Health checks & accessibility

## Test Architecture

| Container | Role |
|-----------|------|
| **dockflow-test-manager** | Simulates production server - Swarm manager (SSH + Docker) |
| **dockflow-test-worker-1** | Simulates production server - Swarm worker (SSH + Docker) |

## Debug Commands

```bash
# View test VM logs
docker-compose -f testing/e2e/docker/docker-compose.yml logs test-vm-manager

# Access test VM shell
docker exec -it dockflow-test-manager bash

# Check deployed containers
docker exec dockflow-test-manager docker ps

# View application logs
docker exec dockflow-test-manager docker logs <container_name>
```
