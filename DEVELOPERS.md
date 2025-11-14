# Developer Guide - E2E Tests

Quick guide for running end-to-end tests locally.

## Prerequisites

⚠️ **IMPORTANT**: Run tests from **WSL** (not PowerShell)

- Docker Desktop running
- `sshpass` installed: `sudo apt install sshpass`

## Running Tests

```bash
# All tests (CLI + Deployment)
cd testing/e2e
bash run-tests.sh

# Cleanup
bash teardown.sh
```

## What's Tested

### CLI Tests (~2 min)

**Location:** `testing/e2e/cli/run-tests.sh`

- ✅ Non-interactive machine setup
- ✅ Deploy user creation (dockflow)
- ✅ SSH key generation & auth
- ✅ Docker installation & permissions

### Deployment Tests (~3 min)

**Location:** `testing/e2e/common/run-deployment-test.sh`

- ✅ Ansible workflow
- ✅ Docker Compose deployment
- ✅ Health checks & accessibility
- ✅ Environment variable injection

## Test Architecture

| Container | Role |
|-----------|------|
| **dockflow-test-vm** | Simulates production server (SSH + Docker) |
| **ansible-runner** | Executes Ansible playbooks |
| **dockflow-cli** | CLI tool for machine setup |

## Debug Commands

```bash
# View test VM logs
docker-compose -f testing/e2e/docker/docker-compose.yml logs test-vm

# Access test VM shell
docker exec -it dockflow-test-vm bash

# Check deployed containers
docker exec dockflow-test-vm docker ps

# View application logs
docker exec dockflow-test-vm docker logs <container_name>
```
