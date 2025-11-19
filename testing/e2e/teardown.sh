#!/bin/bash
# Teardown script for E2E testing environment
# Stops and removes all test containers and volumes

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Tearing down E2E testing environment..."

cd "$SCRIPT_DIR/docker"

# Stop and remove containers
echo "Stopping and removing containers..."
docker-compose --env-file "$SCRIPT_DIR/.env" down -v --remove-orphans

# Optional: Remove SSH keys
read -p "Remove SSH keys? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "${SCRIPT_DIR}/ssh-keys"
    echo "SSH keys removed."
fi

# Optional: Remove .env file
read -p "Remove .env file? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "${SCRIPT_DIR}/.env"
    echo ".env file removed."
fi

echo "Teardown complete."
