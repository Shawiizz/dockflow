#!/bin/bash
# E2E test runner for DockFlow framework
# Simulates a CI/CD deployment process

cd "$ROOT_PATH"

echo "Running DockFlow E2E Tests"
echo ""

# Check if test VM is running
if ! docker ps | grep -q "dockflow-test-vm"; then
	echo "ERROR: Test VM is not running. Run setup.sh first."
	exit 1
fi

echo "Setting up CI/CD environment simulation..."

# Load commit info
set -a
source /tmp/dockflow/testing/e2e/test-app/.deployment/e2e-test/.commit_info
set +a

echo "Loading test environment variables..."

# Use TEST_CONNECTION env var
if [ -n "$TEST_CONNECTION" ]; then
	CONNECTION_STRING="$TEST_CONNECTION"
	echo "Using connection string from environment variable."
else
	echo "ERROR: Connection string not found (env var TEST_CONNECTION)"
	exit 1
fi

# Generate secrets.json with TEST_CONNECTION (in /tmp to avoid modifying project directory)
# We use TEST_CONNECTION because ENV=test in .commit_info
echo "{\"TEST_CONNECTION\":\"$CONNECTION_STRING\"}" >/tmp/secrets.json

source /tmp/dockflow/.common/scripts/load_env.sh "$ENV" "$HOSTNAME"
bash /tmp/dockflow/.common/scripts/deploy_with_ansible.sh

echo "Verifying deployment..."

# Wait a bit for services to start
sleep 5

# Check if Swarm service is running
echo "Checking Swarm service status..."
if docker exec dockflow-test-vm docker service ls --filter name=test-app-test_web --format '{{.Name}}' | grep -q "test-app-test_web"; then
	REPLICAS=$(docker exec dockflow-test-vm docker service ls --filter name=test-app-test_web --format '{{.Replicas}}')
	echo "Service test-app-test_web is running with replicas: $REPLICAS"
else
	echo "ERROR: Swarm service is not running."
	docker exec dockflow-test-vm docker service ls
	exit 1
fi

# Check if web app is accessible using docker exec (verbose output)
echo "Checking web application accessibility..."
RESPONSE=$(docker exec dockflow-test-vm curl -sf http://localhost:8080/ 2>&1)
if echo "$RESPONSE" | grep -q "DOCKFLOW_E2E_TEST_APP_DEPLOYED"; then
	echo "✓ Web application is accessible and serving the correct content."
else
	echo "ERROR: Web application is not serving the expected content."
	echo "Response received:"
	echo "$RESPONSE"
	echo ""
	echo "Verbose curl output:"
	docker exec dockflow-test-vm curl -v http://localhost:8080/
	exit 1
fi

# Test hooks execution
echo ""
echo "Checking hooks execution..."

# Check pre-build hook (runs locally in CI)
if [ -f "/tmp/dockflow-hook-pre-build.txt" ]; then
	echo "✓ pre-build hook executed"
else
	echo "ERROR: pre-build hook was not executed"
	exit 1
fi

# Check post-build hook (runs locally in CI)
if [ -f "/tmp/dockflow-hook-post-build.txt" ]; then
	echo "✓ post-build hook executed"
else
	echo "ERROR: post-build hook was not executed"
	exit 1
fi

# Check pre-deploy hook (runs on remote server)
if docker exec dockflow-test-vm cat /tmp/dockflow-hook-pre-deploy.txt 2>/dev/null | grep -q "pre-deploy"; then
	echo "✓ pre-deploy hook executed on remote server"
else
	echo "ERROR: pre-deploy hook was not executed on remote server"
	exit 1
fi

# Check post-deploy hook (runs on remote server)
if docker exec dockflow-test-vm cat /tmp/dockflow-hook-post-deploy.txt 2>/dev/null | grep -q "post-deploy"; then
	echo "✓ post-deploy hook executed on remote server"
else
	echo "ERROR: post-deploy hook was not executed on remote server"
	exit 1
fi

# Check deploy lock was released
echo ""
echo "Checking deploy lock..."
if docker exec dockflow-test-vm test -f /var/lib/dockflow/locks/test-app-test.lock 2>/dev/null; then
	echo "ERROR: Deploy lock was not released"
	exit 1
else
	echo "✓ Deploy lock released correctly"
fi

# Check audit log was written
echo ""
echo "Checking audit log..."
if docker exec dockflow-test-vm cat /var/lib/dockflow/audit/test-app-test.log 2>/dev/null | grep -q "DEPLOYED"; then
	echo "✓ Audit log entry written"
	docker exec dockflow-test-vm cat /var/lib/dockflow/audit/test-app-test.log
else
	echo "ERROR: Audit log entry was not written"
	exit 1
fi

echo ""
echo "All E2E tests passed."
echo ""
echo "Deployment Summary:"
echo "   Environment: ${ENV}"
echo "   Version: ${VERSION}"
echo "   Application: test-web-app"
echo ""
echo "To cleanup: cd ${SCRIPT_DIR} && bash teardown.sh"
