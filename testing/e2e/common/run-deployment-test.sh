#!/bin/bash
# E2E test runner for DockFlow framework
# Simulates a CI/CD deployment process
set -e

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
# shellcheck source=/dev/null
source /tmp/dockflow/testing/e2e/test-app/.deployment/e2e-test/.commit_info
set +a

echo "Loading test environment variables..."

# Use TEST_CONNECTION env var
if [ -n "${TEST_CONNECTION:-}" ]; then
	CONNECTION_STRING="$TEST_CONNECTION"
	echo "Using connection string from environment variable."
else
	echo "ERROR: Connection string not found (env var TEST_CONNECTION)"
	exit 1
fi

# Generate secrets.json with TEST_CONNECTION (in /tmp to avoid modifying project directory)
echo "{\"TEST_CONNECTION\":\"$CONNECTION_STRING\"}" >/tmp/secrets.json

# shellcheck source=/dev/null
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

# Check if web app is accessible using docker exec
echo "Checking web application accessibility..."
set +e
RESPONSE=$(docker exec dockflow-test-vm curl -sf http://localhost:8080/ 2>&1)
set -e
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

# ===========================================
# ACCESSORIES TESTS
# ===========================================
echo ""
echo "=========================================="
echo "Testing Accessories Deployment"
echo "=========================================="

# Check if accessories.yml exists
if [ -f "$ROOT_PATH/.deployment/docker/accessories.yml" ]; then
	echo "✓ accessories.yml found"
	
	# Check if accessories stack is deployed (should be auto-deployed on first run)
	echo "Checking accessories stack..."
	if docker exec dockflow-test-vm docker stack ls --format '{{.Name}}' | grep -q "test-app-test-accessories"; then
		echo "✓ Accessories stack is deployed"
		
		# Check accessories services
		echo "Checking accessories services..."
		ACCESSORIES_SERVICES=$(docker exec dockflow-test-vm docker stack services test-app-test-accessories --format '{{.Name}}: {{.Replicas}}')
		echo "Accessories services:"
		echo "$ACCESSORIES_SERVICES"
		
		# Check Redis is running
		if echo "$ACCESSORIES_SERVICES" | grep -q "redis"; then
			echo "✓ Redis accessory is running"
			
			# Test Redis connectivity
			echo "Testing Redis connectivity..."
			set +e
			REDIS_PING=$(docker exec dockflow-test-vm docker exec $(docker exec dockflow-test-vm docker ps -q -f name=test-app-test-accessories_redis) redis-cli ping 2>&1)
			set -e
			if echo "$REDIS_PING" | grep -q "PONG"; then
				echo "✓ Redis is responding to PING"
			else
				echo "WARNING: Could not ping Redis (may still be starting): $REDIS_PING"
			fi
		else
			echo "ERROR: Redis accessory not found in stack"
			exit 1
		fi
		
		# Check accessories hash file was created
		echo "Checking accessories hash file..."
		if docker exec dockflow-test-vm test -f /var/lib/dockflow/accessories/test-app-test/.hash 2>/dev/null; then
			echo "✓ Accessories hash file created"
			HASH=$(docker exec dockflow-test-vm cat /var/lib/dockflow/accessories/test-app-test/.hash)
			echo "  Hash: $HASH"
		else
			echo "ERROR: Accessories hash file was not created"
			exit 1
		fi
	else
		echo "ERROR: Accessories stack is not deployed"
		echo "Available stacks:"
		docker exec dockflow-test-vm docker stack ls
		exit 1
	fi
else
	echo "SKIP: No accessories.yml found (accessories tests skipped)"
fi

echo ""
echo "All E2E tests passed."
echo ""
echo "Deployment Summary:"
echo "   Environment: ${ENV}"
echo "   Version: ${VERSION}"
echo "   Application: test-web-app"
echo ""
echo "To cleanup: bash teardown.sh"
