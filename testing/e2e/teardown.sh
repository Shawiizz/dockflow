#!/bin/bash
# Teardown script for E2E testing environment
# Stops and removes the test VM and cleans up resources
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Tearing down E2E testing environment..."

cd "$SCRIPT_DIR/docker"

# Stop and remove containers
echo "Stopping and removing containers..."
docker compose --env-file "$SCRIPT_DIR/.env" down -v --remove-orphans

# Clean up test app .env.dockflow if it exists
if [[ -f "$SCRIPT_DIR/test-app/.env.dockflow" ]]; then
	rm -f "$SCRIPT_DIR/test-app/.env.dockflow"
	echo "Cleaned up test-app/.env.dockflow"
fi

# Clean up test-app-remote artifacts
if [[ -f "$SCRIPT_DIR/test-app-remote/.env.dockflow" ]]; then
	rm -f "$SCRIPT_DIR/test-app-remote/.env.dockflow"
	echo "Cleaned up test-app-remote/.env.dockflow"
fi
if [[ -d "$SCRIPT_DIR/test-app-remote/.git" ]]; then
	rm -rf "$SCRIPT_DIR/test-app-remote/.git"
	echo "Cleaned up test-app-remote/.git"
fi

# Optional: Remove .env file
read -p "Remove .env file? (y/N): " -n 1 -r REPLY
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
	rm -f "${SCRIPT_DIR}/.env"
	echo ".env file removed."
fi

echo "Teardown complete."
