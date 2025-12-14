#!/bin/bash
# Run E2E tests inside Ansible container (avoids WSL permission issues)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running E2E tests in Ansible container"
echo ""

# Run CLI tests first (which will setup test VM and configure it)
echo "Step 1: Running CLI E2E tests (setup + configuration)..."

# Use a temp file to capture output while streaming to stdout
# This avoids non-blocking I/O issues with pipes that break Ansible
TEMP_OUTPUT=$(mktemp)
trap "rm -f $TEMP_OUTPUT" EXIT

set +e
bash "$SCRIPT_DIR/cli/run-tests.sh" 2>&1 | tee "$TEMP_OUTPUT"
CLI_EXIT_CODE=${PIPESTATUS[0]}
set -e

if [ "$CLI_EXIT_CODE" -ne 0 ]; then
	echo "ERROR: CLI tests failed."
	exit 1
fi

TEST_CONNECTION=$(grep "^::CONNECTION_STRING::" "$TEMP_OUTPUT" | tail -n 1 | sed 's/^::CONNECTION_STRING:://')

if [ -z "$TEST_CONNECTION" ]; then
	echo "ERROR: Could not capture connection string from CLI tests."
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
docker compose --env-file "$SCRIPT_DIR/.env" build ansible-runner

echo ""
echo "Step 4: Running deployment tests in Ansible container..."
echo ""

# Run tests inside the container
set +e
docker compose --env-file "$SCRIPT_DIR/.env" run --rm -T \
	-e TEST_CONNECTION="$TEST_CONNECTION" \
	ansible-runner bash -c '
    # Copy source and test app to workspace
    cp -r /mnt-src/dockflow/testing/e2e/test-app/. /workspace/
    
    # Copy dockflow framework to /tmp (excluding heavy directories)
    mkdir -p /tmp/dockflow
    rsync -a --exclude="node_modules" --exclude=".git" --exclude="docs" \
          --exclude="cli-ts/node_modules" --exclude="cli-ts/dist" \
          --exclude="testing/e2e/docker/data" \
          /mnt-src/dockflow/ /tmp/dockflow/
    
    # Set ROOT_PATH to workspace (where the test app is)
    export ROOT_PATH=/workspace
    
    # Run the deployment test script
    cd /tmp/dockflow/testing/e2e
    bash common/run-deployment-test.sh
'
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
	echo ""
	echo "=========================================="
	echo "   ALL E2E TESTS PASSED"
	echo "=========================================="
	echo ""
	echo "Summary:"
	echo "  - CLI tests passed (machine setup)"
	echo "  - Deployment tests passed"
else
	echo ""
	echo "=========================================="
	echo "   DEPLOYMENT TESTS FAILED"
	echo "=========================================="
fi

exit "$EXIT_CODE"
