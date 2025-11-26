#!/bin/bash
# Run E2E tests inside Ansible container (avoids WSL permission issues)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running E2E tests in Ansible container"
echo ""

# Run CLI tests first (which will setup test VM and configure it)
echo "Step 1: Running CLI E2E tests (setup + configuration)..."

# Capture connection string while streaming output
exec 5>&1
TEST_CONNECTION_OUTPUT=$(bash "$SCRIPT_DIR/cli/run-tests.sh" | tee /dev/fd/5 | grep "^::CONNECTION_STRING::" | tail -n 1)
CLI_EXIT_CODE=${PIPESTATUS[0]}

if [ $CLI_EXIT_CODE -ne 0 ]; then
	echo "ERROR: CLI tests failed."
	exit 1
fi

TEST_CONNECTION=${TEST_CONNECTION_OUTPUT#*::CONNECTION_STRING::}

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
docker compose --env-file "$SCRIPT_DIR/.env" run --rm \
	-e TEST_CONNECTION="$TEST_CONNECTION" \
	ansible-runner bash -c "
    
    # Copy source and test app to workspace
    cp -r /mnt-src/dockflow/testing/e2e/test-app/. /workspace/
    cp -r /mnt-src/dockflow /workspace/
    
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
