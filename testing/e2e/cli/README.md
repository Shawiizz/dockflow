# CLI E2E Tests

This directory contains end-to-end tests for the DockFlow CLI, specifically testing the `setup-machine` command in non-interactive mode.

## Overview

These tests verify that the CLI can:
- Configure a remote machine for Docker deployment
- Create a deployment user with proper permissions
- Set up SSH key authentication
- Install Docker and configure it properly
- Optionally install and configure Portainer

## Test Environment

The tests use the same Docker-based test environment as the deployment E2E tests:
- **test-vm**: A containerized VM simulating a production server
- **CLI Docker image**: Built from `cli/Dockerfile.cli`

## Test Scenarios

### 1. Machine Setup (Non-Interactive)
- Runs the CLI `setup-machine` command with all parameters
- Uses password authentication for initial connection
- Creates a new deployment user (`dockflow`)
- Generates SSH key pair for the deployment user

### 2. Docker Installation Verification
- Verifies Docker is installed on the test VM
- Checks Docker version

### 3. Deploy User Creation
- Verifies the deployment user was created
- Checks the user is added to the docker group

### 4. SSH Key Authentication
- Tests SSH connection with the generated key
- Verifies key-based authentication works

### 5. Docker Access for Deploy User
- Verifies the deploy user can run Docker commands
- Tests Docker permissions

### 6. Portainer Installation (Optional)
- Can be enabled to test Portainer installation
- Currently skipped to keep test environment clean

## Running the Tests

### Prerequisites

- Docker Desktop installed and running
- Bash shell (Git Bash, WSL, or native Linux/macOS)
- `sshpass` installed (optional, for password-based SSH)

### Setup Test Environment

```bash
cd testing/e2e/cli
bash setup.sh
```

This will:
1. Generate SSH keys for testing
2. Start the Docker Compose services (test-vm)
3. Wait for the test VM to be healthy
4. Test the initial SSH connection

### Run Tests

```bash
cd testing/e2e/cli
bash run-tests.sh
```

This will:
1. Build the CLI Docker image
2. Run the `setup-machine` command against the test VM
3. Verify all configurations
4. Report test results

### Cleanup

```bash
cd testing/e2e
bash teardown.sh
```

This will stop and remove all Docker containers and networks created during testing.

## Environment Variables

The tests use environment variables from `testing/e2e/.env`:

```env
# Test VM SSH Configuration
SSH_HOST=dockflow-test-vm
SSH_PORT=2222
SSH_USER=root
SSH_PASSWORD=testpassword

# Docker API Configuration
DOCKER_PORT=2375

# Optional: Portainer Configuration
PORTAINER_PORT=9443
PORTAINER_HTTP_PORT=9000
```

## Test Output

A successful test run will show:

```
==========================================
   DockFlow CLI E2E Tests
==========================================

Test configuration:
   Remote Host: dockflow-test-vm
   SSH Port: 2222
   Remote User: root
   Deploy User: dockflow

✓ CLI image built

==========================================
TEST 1: Setup machine (non-interactive)
==========================================

✓ CLI setup-machine completed successfully

==========================================
TEST 2: Verify Docker installation
==========================================

✓ Docker is installed: Docker version 24.x.x

==========================================
TEST 3: Verify deploy user creation
==========================================

✓ Deploy user exists: uid=1001(dockflow) gid=1001(dockflow)...
✓ Deploy user is in docker group

==========================================
TEST 4: Verify SSH key authentication
==========================================

✓ SSH key authentication works for deploy user

==========================================
TEST 5: Verify Docker access for deploy user
==========================================

✓ Deploy user can run Docker commands

==========================================
   ALL TESTS PASSED ✓
==========================================
```

## Troubleshooting

### Test VM not starting

Check Docker logs:
```bash
cd testing/e2e/docker
docker-compose logs test-vm
```

### SSH connection fails

Verify the test VM is running and healthy:
```bash
docker ps | grep dockflow-test-vm
```

Check SSH service inside the container:
```bash
docker exec dockflow-test-vm service ssh status
```

### CLI command fails

Check the CLI output for error messages. Common issues:
- Missing required parameters
- Invalid credentials
- Network connectivity between containers
- SSH configuration issues

### Permission issues on Windows/WSL

The SSH keys need proper permissions. If you get permission errors:
```bash
chmod 600 testing/e2e/ssh-keys/id_ed25519
chmod 600 testing/e2e/ssh-keys/deploy_key
```

## Architecture

```
testing/e2e/cli/
├── setup.sh          # Initialize test environment
├── run-tests.sh      # Run E2E tests for CLI
└── README.md         # This file

testing/e2e/
├── .env              # Environment variables for tests
├── teardown.sh       # Cleanup script
├── docker/
│   ├── docker-compose.yml    # Test environment definition
│   ├── Dockerfile.test-vm    # Test VM image
│   └── ...
└── ssh-keys/         # Generated SSH keys (gitignored)
```

## Integration with CI/CD

These tests can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
name: CLI E2E Tests

on: [push, pull_request]

jobs:
  cli-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup test environment
        run: cd testing/e2e/cli && bash setup.sh
      - name: Run CLI E2E tests
        run: cd testing/e2e/cli && bash run-tests.sh
      - name: Cleanup
        if: always()
        run: cd testing/e2e && bash teardown.sh
```

## Contributing

When adding new CLI features, please add corresponding E2E tests:

1. Add test scenario to `run-tests.sh`
2. Document the test in this README
3. Ensure tests are idempotent and clean up after themselves
4. Test on multiple platforms (Linux, macOS, Windows/WSL)
