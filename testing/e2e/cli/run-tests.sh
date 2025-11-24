#!/bin/bash
# E2E test runner for DockFlow CLI
# Tests the CLI setup-machine command in non-interactive mode

set -eo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
export ROOT_PATH="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SSH_KEY_DIR="/tmp/ssh-keys"

# Create SSH key directory in /tmp to avoid Windows permission issues
echo "Creating SSH key directory in /tmp..."
mkdir -p "$SSH_KEY_DIR"
chmod 700 "$SSH_KEY_DIR"

cd "$ROOT_PATH"

echo "=========================================="
echo "   DockFlow CLI E2E Tests"
echo "=========================================="
echo ""

# Check if test VM is running, if not run setup from common
if ! docker ps | grep -q "dockflow-test-vm"; then
    echo "Test VM is not running. Setting up test environment..."
    echo ""
    cd "$ROOT_DIR/common"
    bash setup.sh
    echo ""
    cd "$ROOT_PATH"
fi

# Load environment variables
source "$ROOT_DIR/.env" 2>/dev/null || true

# Verify environment variables
if [ -z "$SSH_HOST" ] || [ -z "$SSH_PORT" ] || [ -z "$SSH_USER" ] || [ -z "$SSH_PASSWORD" ] || [ -z "$DEPLOY_USER" ]; then
    echo "ERROR: Required environment variables are not set."
    echo "Required: SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD, DEPLOY_USER"
    exit 1
fi

echo "Test configuration:"
echo "   Remote Host: $SSH_HOST"
echo "   SSH Port (host): $SSH_PORT"
echo "   SSH Port (docker network): 22"
echo "   Remote User: $SSH_USER"
echo "   Deploy User: $DEPLOY_USER"
echo ""

# Build the CLI Docker image
echo "Building CLI Docker image..."
cd "$ROOT_PATH"
docker build -f cli/Dockerfile.cli -t dockflow-cli:test .
echo "✓ CLI image built"
echo ""

# Clean up old SSH known_hosts to avoid host key conflicts
echo "Cleaning up old SSH known_hosts..."
rm -f "$SSH_KEY_DIR/known_hosts" 2>/dev/null || true
echo "✓ SSH known_hosts cleaned"
echo ""

# Test 1: Setup machine with password authentication and create deploy user
echo "=========================================="
echo "TEST 1: Setup machine (non-interactive)"
echo "=========================================="
echo ""

echo "Running CLI setup-machine command..."
echo "Note: Using port 22 for Docker network communication (not $SSH_PORT which is for host access)"
echo "Note: Skipping Docker and Portainer installation (already present in test environment)"
echo ""

# When running from Docker network, use port 22 (internal container port)
# The SSH_PORT (2222) is only for host -> container access
# Set SKIP_DOCKER_INSTALL=true since Docker is already installed in test-vm
# Don't install Portainer in tests to keep it simple
if ! docker run --rm \
    --network docker_test-network \
    -v "$SSH_KEY_DIR:/root/.ssh" \
    -e SKIP_DOCKER_INSTALL=true \
    -e PORTAINER_INSTALL=false \
    dockflow-cli:test setup-machine \
    --host "$SSH_HOST" \
    --port "22" \
    --remote-user "$SSH_USER" \
    --remote-password "$SSH_PASSWORD" \
    --deploy-user "$DEPLOY_USER" \
    --deploy-password "dockflow123" \
    --generate-key y; then
    echo "ERROR: CLI setup-machine command failed"
    exit 1
fi

# Fix SSH key ownership and permissions (keys created by Docker are owned by root)
echo "Fixing SSH key ownership and permissions..."
# Get current user inside bash (not from parent shell)
CURRENT_USER=$(id -un)
CURRENT_GROUP=$(id -gn)

# Change ownership to current user if owned by root
if [ "$(stat -c '%U' "$SSH_KEY_DIR/deploy_key" 2>/dev/null)" = "root" ]; then
    echo "Changing ownership from root to $CURRENT_USER..."
    sudo chown -R "$CURRENT_USER:$CURRENT_GROUP" "$SSH_KEY_DIR" 2>/dev/null || {
        echo "WARNING: Could not change ownership. SSH key authentication may fail."
        echo "You may need to manually run: sudo chown -R $CURRENT_USER:$CURRENT_GROUP $SSH_KEY_DIR"
    }
fi

# Set proper permissions
chmod 700 "$SSH_KEY_DIR" 2>/dev/null || true
chmod 600 "$SSH_KEY_DIR/deploy_key" 2>/dev/null || true
if [ -f "$SSH_KEY_DIR/deploy_key.pub" ]; then
    chmod 644 "$SSH_KEY_DIR/deploy_key.pub" 2>/dev/null || true
fi

echo "✓ CLI setup-machine completed successfully"
echo ""

# Test 2: Verify Docker is installed on test VM
echo "=========================================="
echo "TEST 2: Verify Docker installation"
echo "=========================================="
echo ""

echo "Checking Docker installation on test VM..."
if docker exec dockflow-test-vm docker --version >/dev/null 2>&1; then
    DOCKER_VERSION=$(docker exec dockflow-test-vm docker --version)
    echo "✓ Docker is installed: $DOCKER_VERSION"
else
    echo "ERROR: Docker is not installed on test VM"
    exit 1
fi
echo ""

# Test 3: Verify deploy user was created
echo "=========================================="
echo "TEST 3: Verify deploy user creation"
echo "=========================================="
echo ""

echo "Checking if deploy user '$DEPLOY_USER' exists..."
if docker exec dockflow-test-vm id "$DEPLOY_USER" >/dev/null 2>&1; then
    USER_INFO=$(docker exec dockflow-test-vm id "$DEPLOY_USER")
    echo "✓ Deploy user exists: $USER_INFO"
else
    echo "ERROR: Deploy user '$DEPLOY_USER' was not created"
    exit 1
fi

# Check if user is in docker group
echo "Checking if deploy user is in docker group..."
if docker exec dockflow-test-vm groups "$DEPLOY_USER" | grep -q docker; then
    echo "✓ Deploy user is in docker group"
else
    echo "ERROR: Deploy user is not in docker group"
    exit 1
fi
echo ""

# Test 4: Verify SSH key authentication for deploy user
echo "=========================================="
echo "TEST 4: Verify SSH key authentication"
echo "=========================================="
echo ""

DEPLOY_KEY_PATH="$SSH_KEY_DIR/deploy_key"

if [ ! -f "$DEPLOY_KEY_PATH" ]; then
    echo "ERROR: Deploy key not found at $DEPLOY_KEY_PATH"
    exit 1
fi

echo "Testing SSH connection with deploy user..."
echo "Note: Using port $SSH_PORT for host -> container access"
# Fix permissions (important for SSH to accept the key)
chmod 600 "$DEPLOY_KEY_PATH" 2>/dev/null || true

# From the host, we use the mapped port (SSH_PORT)
if ssh -i "$DEPLOY_KEY_PATH" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 \
    -p "$SSH_PORT" \
    "${DEPLOY_USER}@localhost" \
    "echo 'SSH authentication successful'" >/dev/null 2>&1; then
    echo "✓ SSH key authentication works for deploy user"
else
    echo "ERROR: SSH key authentication failed for deploy user"
    echo "Trying to debug..."
    docker exec dockflow-test-vm cat "/home/${DEPLOY_USER}/.ssh/authorized_keys" 2>/dev/null || echo "Could not read authorized_keys"
    exit 1
fi
echo ""

# Test 5: Verify deploy user can run Docker commands
echo "=========================================="
echo "TEST 5: Verify Docker access for deploy user"
echo "=========================================="
echo ""

echo "Testing Docker access for deploy user..."
if ssh -i "$DEPLOY_KEY_PATH" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 \
    -p "$SSH_PORT" \
    "${DEPLOY_USER}@localhost" \
    "docker ps" >/dev/null 2>&1; then
    echo "✓ Deploy user can run Docker commands"
else
    echo "ERROR: Deploy user cannot run Docker commands"
    exit 1
fi
echo ""

# Test 6: Test with Portainer installation (optional, cleanup first)
echo "=========================================="
echo "TEST 6: Setup with Portainer (optional)"
echo "=========================================="
echo ""

echo "Note: This test installs Portainer on the test VM"
echo "Skipping Portainer test to keep test environment clean."
echo "To test Portainer, add --install-portainer y to the CLI command."
echo ""

# Summary
echo "=========================================="
echo "   ALL TESTS PASSED ✓"
echo "=========================================="
echo ""
echo "Summary:"
echo "   ✓ CLI setup-machine command executed successfully"
echo "   ✓ Docker installed and running on test VM"
echo "   ✓ Deploy user '$DEPLOY_USER' created"
echo "   ✓ Deploy user added to docker group"
echo "   ✓ SSH key authentication configured"
echo "   ✓ Deploy user can run Docker commands"
echo ""
echo "Deploy Key Location: $DEPLOY_KEY_PATH"
echo ""
echo "To cleanup: cd ${ROOT_DIR} && bash teardown.sh"
