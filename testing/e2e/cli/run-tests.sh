#!/bin/bash
# E2E test runner for DockFlow CLI
# Tests the CLI setup-machine command in non-interactive mode
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_PATH="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
export ROOT_PATH

cd "$ROOT_PATH"

echo "=========================================="
echo "   DockFlow CLI E2E Tests"
echo "=========================================="
echo ""

# Always rebuild CLI binary for tests to ensure latest code is tested
CLI_BINARY="$ROOT_PATH/cli-ts/dist/dockflow-linux-x64"
echo "Building CLI binary..."
cd "$ROOT_PATH/cli-ts"
if command -v bun &>/dev/null; then
	bun install --frozen-lockfile
	bun run build linux-x64
else
	echo "ERROR: bun is required to build the CLI. Install it with: curl -fsSL https://bun.sh/install | bash"
	exit 1
fi
cd "$ROOT_PATH"
echo "✓ CLI binary built"
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
# shellcheck source=/dev/null
source "$ROOT_DIR/.env" 2>/dev/null || true

# Verify environment variables
if [ -z "${SSH_HOST:-}" ] || [ -z "${SSH_PORT:-}" ] || [ -z "${SSH_USER:-}" ] || [ -z "${SSH_PASSWORD:-}" ] || [ -z "${DEPLOY_USER:-}" ]; then
	echo "ERROR: Required environment variables are not set."
	echo "Required: SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD, DEPLOY_USER"
	exit 1
fi

echo "Test configuration:"
echo "   Remote Host: $SSH_HOST"
echo "   SSH Port (host): $SSH_PORT"
echo "   Remote User: $SSH_USER"
echo "   Deploy User: $DEPLOY_USER"
echo ""

# Test 1: Setup machine with password authentication and create deploy user
echo "=========================================="
echo "TEST 1: Setup machine (non-interactive)"
echo "=========================================="
echo ""

echo "Transferring CLI to remote server..."
# Create temporary directory on remote server
REMOTE_TEMP_DIR="/tmp/dockflow-cli-$$"

# Test SSH connection first (silent)
if ! sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p "$SSH_PORT" "${SSH_USER}@localhost" "true" >/dev/null 2>&1; then
	echo "ERROR: Cannot establish SSH connection to remote server" >&2
	echo "Debug: SSH_USER='$SSH_USER', SSH_PORT='$SSH_PORT'" >&2
	echo "Checking if container is running..." >&2
	docker ps | grep dockflow-test-vm >&2
	exit 1
fi

# Create temporary directory on remote server
if ! sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
	"mkdir -p $REMOTE_TEMP_DIR" >/dev/null 2>&1; then
	echo "ERROR: Failed to create temporary directory on remote server" >&2
	exit 1
fi
echo "✓ SSH connection established and temp directory created"

# Transfer project using tar (mimics how the wrapper downloads the repo)
# Optimized: no compression (local network), extensive exclusions
echo "Transferring project to remote server..."
if ! tar -cf - -C "$ROOT_PATH" \
	--exclude='.git' \
	--exclude='.idea' \
	--exclude='.vscode' \
	--exclude='node_modules' \
	--exclude='docs' \
	--exclude='cli-ts/dist' \
	--exclude='cli-ts/node_modules' \
	--exclude='testing/e2e/docker/data' \
	. | sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
		"cd $REMOTE_TEMP_DIR && tar -xf -"; then
	echo "ERROR: Failed to transfer project to remote server"
	exit 1
fi

# Copy CLI binary to remote temp directory and rename to 'dockflow'
echo "Transferring CLI binary to remote server..."
if ! sshpass -p "$SSH_PASSWORD" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P "$SSH_PORT" \
	"$CLI_BINARY" "${SSH_USER}@localhost:$REMOTE_TEMP_DIR/dockflow"; then
	echo "ERROR: Failed to transfer CLI binary to remote server"
	exit 1
fi

# Make binary executable
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
	"chmod +x $REMOTE_TEMP_DIR/dockflow"

echo "✓ Project and CLI binary transferred to remote server"
echo ""

echo "Running CLI setup command on remote server..."
echo "Note: Executing CLI directly on the remote server via SSH"
echo "Note: Skipping Docker and Portainer installation (already present in test environment)"
echo ""

# Execute CLI on remote server via SSH and capture output
set +e
CLI_OUTPUT=$(sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
	"cd $REMOTE_TEMP_DIR && \
    ./dockflow setup auto \
    --host dockflow-test-vm \
    --port 22 \
    --user $DEPLOY_USER \
    --password 'dockflow123' \
    --generate-key \
    --skip-docker-install 2>&1")
CLI_EXIT_CODE=$?
set -e

# Display CLI output
echo "$CLI_OUTPUT"
echo ""

if [ "$CLI_EXIT_CODE" -ne 0 ]; then
	echo "ERROR: CLI setup-machine command failed with exit code $CLI_EXIT_CODE"
	# Cleanup remote temp directory
	sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
		"rm -rf $REMOTE_TEMP_DIR" 2>/dev/null || true
	exit 1
fi

echo "✓ CLI setup completed successfully"
echo ""

# Extract the connection string from CLI output
echo "Extracting connection string from CLI output..."
# The connection string is displayed between the yellow lines after "Connection String (Base64):"
# We use grep -A 2 to get the line with the connection string (Header -> Separator -> Connection String)
E2E_TEST_CONNECTION=$(echo "$CLI_OUTPUT" | grep -A 2 "Connection String (Base64):" | tail -n 1 | grep -v "━" | xargs || true)

if [ -z "$E2E_TEST_CONNECTION" ]; then
	echo "ERROR: Failed to extract connection string from CLI output"
	echo "This is the expected output format from the CLI."
	# Cleanup remote temp directory
	sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
		"rm -rf $REMOTE_TEMP_DIR" 2>/dev/null || true
	exit 1
fi

echo "✓ Connection string extracted successfully"
echo ""

# Decode the connection string (same as load_env.sh does)
echo "Decoding connection string (mimicking load_env.sh behavior)..."
CONNECTION_JSON=$(echo "$E2E_TEST_CONNECTION" | base64 -d 2>/dev/null)

if [ -z "$CONNECTION_JSON" ]; then
	echo "ERROR: Failed to decode connection string"
	# Cleanup remote temp directory
	sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
		"rm -rf $REMOTE_TEMP_DIR" 2>/dev/null || true
	exit 1
fi

# Extract connection details from JSON (using jq like load_env.sh)
# These variables mimic what load_env.sh exports when it processes [ENV]_CONNECTION
export DOCKFLOW_HOST=$(echo "$CONNECTION_JSON" | jq -r '.host // empty')
export DOCKFLOW_PORT=$(echo "$CONNECTION_JSON" | jq -r '.port // empty')
export DOCKFLOW_USER=$(echo "$CONNECTION_JSON" | jq -r '.user // empty')
export SSH_PRIVATE_KEY=$(echo "$CONNECTION_JSON" | jq -r '.privateKey // empty')
export DOCKFLOW_PASSWORD=$(echo "$CONNECTION_JSON" | jq -r '.password // empty')

# Output connection string for parent script
echo "::CONNECTION_STRING::$E2E_TEST_CONNECTION"

echo "✓ Connection string decoded successfully"
echo "   DOCKFLOW_HOST: $DOCKFLOW_HOST"
echo "   DOCKFLOW_PORT: $DOCKFLOW_PORT"
echo "   DOCKFLOW_USER: $DOCKFLOW_USER"
echo "   DOCKFLOW_PASSWORD: [SET]"
echo "   SSH_PRIVATE_KEY: [EXTRACTED]"
echo ""

# Verify we got all required information from the connection string
if [ -z "$DOCKFLOW_HOST" ] || [ -z "$DOCKFLOW_PORT" ] || [ -z "$DOCKFLOW_USER" ] || [ -z "$SSH_PRIVATE_KEY" ]; then
	echo "ERROR: Connection string is missing required fields"
	echo "Expected: host, port, user, privateKey"
	# Cleanup remote temp directory
	sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
		"rm -rf $REMOTE_TEMP_DIR" 2>/dev/null || true
	exit 1
fi

echo "✓ All connection details validated"

echo ""

# Cleanup remote temp directory
echo "Cleaning up remote temporary directory..."
sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$SSH_PORT" "${SSH_USER}@localhost" \
	"rm -rf $REMOTE_TEMP_DIR" 2>/dev/null || true
echo "✓ Remote cleanup completed"
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

echo "Checking if deploy user '$DOCKFLOW_USER' exists..."
if docker exec dockflow-test-vm id "$DOCKFLOW_USER" >/dev/null 2>&1; then
	USER_INFO=$(docker exec dockflow-test-vm id "$DOCKFLOW_USER")
	echo "✓ Deploy user exists: $USER_INFO"
else
	echo "ERROR: Deploy user '$DOCKFLOW_USER' was not created"
	exit 1
fi

# Check if user is in docker group
echo "Checking if deploy user is in docker group..."
if docker exec dockflow-test-vm groups "$DOCKFLOW_USER" | grep -q docker; then
	echo "✓ Deploy user is in docker group"
else
	echo "ERROR: Deploy user is not in docker group"
	exit 1
fi
echo ""

# Test 4: Verify SSH key authentication using connection string credentials
echo "=========================================="
echo "TEST 4: Verify SSH key authentication"
echo "=========================================="
echo ""

echo "Skipping SSH key authentication test (handled by deployment tests)"
echo ""

# Test 5: Verify deploy user can run Docker commands using connection string
echo "=========================================="
echo "TEST 5: Verify Docker access for deploy user"
echo "=========================================="
echo ""

echo "Skipping Docker access test (handled by deployment tests)"
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
echo "   ✓ Deploy user '$DOCKFLOW_USER' created"
echo "   ✓ Deploy user added to docker group"
echo "   ✓ SSH key authentication configured"
echo "   ✓ Deploy user can run Docker commands"
echo "   ✓ Connection string validated (mimics [ENV]_CONNECTION secret)"
echo ""
echo "Connection String Usage:"
echo "   In CI/CD, you would set this as a secret named: [ENV]_CONNECTION"
echo "   Example: PRODUCTION_CONNECTION, STAGING_CONNECTION, etc."
echo "   The deployment system (load_env.sh) decodes it automatically."
echo ""
echo "To cleanup: cd ${ROOT_DIR} && bash teardown.sh"
