#!/bin/bash
# Run E2E tests inside Ansible container (avoids WSL permission issues)

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_KEY_DIR="/tmp/ssh-keys"

# Create SSH key directory in /tmp to avoid Windows permission issues
echo "Creating SSH key directory in /tmp..."
mkdir -p "$SSH_KEY_DIR"
chmod 700 "$SSH_KEY_DIR"

echo "Running E2E tests in Ansible container"
echo ""

# Run CLI tests first (which will setup test VM and configure it)
echo "Step 1: Running CLI E2E tests (setup + configuration)..."
if ! bash "$SCRIPT_DIR/cli/run-tests.sh"; then
    echo "ERROR: CLI tests failed."
    exit 1
fi

echo ""
echo "Step 2: Verifying test VM is ready..."
if ! docker ps | grep -q "dockflow-test-vm"; then
    echo "ERROR: Test VM is not running after CLI setup."
    exit 1
fi

echo ""
echo "Step 3: Building Ansible runner container..."
cd "$SCRIPT_DIR/docker"
docker-compose --env-file "$SCRIPT_DIR/.env" build ansible-runner

echo ""
echo "Step 4: Running deployment tests in Ansible container..."
echo ""

# Run tests inside the container
docker-compose --env-file "$SCRIPT_DIR/.env" run --rm ansible-runner bash -c "
    set -euo pipefail
    # Copy source and test app to workspace
    cp -r /mnt-src/dockflow/testing/e2e/test-app/. /workspace/
    cp -r /mnt-src/dockflow /workspace/
    
    echo 'Configuring SSH key permissions inside container...'
    # Use deploy_key created by CLI tests from /tmp/ssh-keys
    cp -r /ssh-keys /tmp/ssh-keys-copy
    chmod 700 /tmp/ssh-keys-copy
    chmod 600 /tmp/ssh-keys-copy/deploy_key 2>/dev/null || true
    
    # Export SSH_KEY_PATH for the test script
    export SSH_KEY_PATH=/tmp/ssh-keys-copy/deploy_key
    
    # Run the deployment test script
    cd /workspace/dockflow/testing/e2e
    bash common/run-deployment-test.sh
"

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "   ALL E2E TESTS PASSED ✓"
    echo "=========================================="
    echo ""
    echo "Summary:"
    echo "  ✓ CLI tests passed (machine setup)"
    echo "  ✓ Deployment tests passed"
else
    echo ""
    echo "=========================================="
    echo "   DEPLOYMENT TESTS FAILED"
    echo "=========================================="
fi

exit $EXIT_CODE
