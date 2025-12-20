#!/bin/bash
# Setup script for E2E testing environment
# This script initializes the test VM and generates SSH keys
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Setting up E2E testing environment..."

# Start the test environment
echo "Starting Docker Compose services..."
cd "$ROOT_DIR/docker"
docker compose --env-file "$ROOT_DIR/.env" up -d --build

# Wait for the test VM to be healthy
echo "Waiting for test VM to be ready..."
MAX_WAIT=60
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
	if docker compose --env-file "$ROOT_DIR/.env" ps | grep -q "healthy"; then
		echo "Test VM is healthy."
		break
	fi
	if [ "$ELAPSED" -eq $((MAX_WAIT - 1)) ]; then
		echo "ERROR: Test VM did not become healthy in time."
		docker compose logs test-vm
		exit 1
	fi
	sleep 1
	ELAPSED=$((ELAPSED + 1))
done

# Load environment variables
if [ -f "$ROOT_DIR/.env" ]; then
	# shellcheck source=/dev/null
	source "$ROOT_DIR/.env" 2>/dev/null || true
fi

# Test SSH connection
echo "Testing SSH connection..."
sleep 2
SSH_TEST_CMD="echo 'SSH connection successful!'"
if [ -n "${SSH_PASSWORD:-}" ] && command -v sshpass >/dev/null 2>&1; then
	if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -p "${SSH_PORT:-22}" "${SSH_USER:-root}@localhost" "$SSH_TEST_CMD" >/dev/null 2>&1; then
		echo "SSH connection test passed (with password)."
	else
		echo "WARNING: SSH connection test failed. Checking container status..."
		docker compose logs test-vm | tail -n 20
	fi
else
	echo "WARNING: sshpass not found or SSH_PASSWORD not set. Skipping SSH connection test."
fi

echo ""
echo "E2E testing environment is ready."
echo ""
echo "Connection details:"
echo "   SSH: ssh -p ${SSH_PORT:-22} ${SSH_USER:-root}@localhost"
echo "   Docker API: http://localhost:${DOCKER_PORT:-2375}"
echo ""
echo "To run tests: cd ${ROOT_DIR} && bash run-tests.sh"
echo "To cleanup:   cd ${SCRIPT_DIR} && bash teardown.sh"
echo ""
