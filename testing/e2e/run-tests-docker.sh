#!/bin/bash
# Run E2E tests inside Ansible container (avoids WSL permission issues)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running E2E tests in Ansible container"
echo ""

# Check if test VM is running, setup if not
if ! docker ps | grep -q "dockflow-test-vm"; then
    echo "Test VM is not running. Executing setup.sh..."
    bash "$SCRIPT_DIR/common/setup.sh"
    if ! docker ps | grep -q "dockflow-test-vm"; then
        echo "ERROR: Test VM failed to start after setup."
        exit 1
    fi
fi

# Build and run Ansible container
echo "Building Ansible runner container..."
cd "$SCRIPT_DIR/docker"
docker-compose --env-file "$SCRIPT_DIR/.env" build ansible-runner

echo ""
echo "Starting Ansible runner and executing tests..."
echo ""

# Run tests inside the container
docker-compose --env-file "$SCRIPT_DIR/.env" run --rm ansible-runner bash -c "
    set -e
    # Copy source and test app to workspace
    cp -r /mnt-src/dockflow/testing/e2e/test-app/. /workspace/
    cp -r /mnt-src/dockflow /workspace/
    
    echo 'Configuring SSH key permissions inside container...'
    cp -r /ssh-keys /tmp/ssh-keys-copy
    chmod 700 /tmp/ssh-keys-copy
    chmod 600 /tmp/ssh-keys-copy/id_ed25519
    
    # Export SSH_KEY_PATH for the test script
    export SSH_KEY_PATH=/tmp/ssh-keys-copy/id_ed25519
    
    # Run the main test script
    cd /workspace/dockflow/testing/e2e
    bash common/run-tests.sh
"

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "Tests completed successfully."
else
    echo ""
    echo "Tests failed with exit code $EXIT_CODE."
fi

exit $EXIT_CODE
