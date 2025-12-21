# Developer Guide - E2E Tests

Quick guide for running end-to-end tests locally.

## Prerequisites

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
