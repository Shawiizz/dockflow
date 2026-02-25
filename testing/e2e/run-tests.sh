#!/bin/bash
# =============================================================================
# Dockflow E2E Test Runner - Multi-Node Swarm
# =============================================================================
# Architecture:
#   1. Build CLI binary
#   2. Start VMs (manager + worker)
#   3. Setup machines (dockflow setup auto on both nodes)
#   4. Setup Swarm cluster (dockflow setup swarm)
#   5. Deploy with 2 replicas
#   6. Verify replicas distributed across nodes
#   7. Remote build test
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR="$DOCKFLOW_ROOT/cli-ts"
TEST_APP_DIR="$SCRIPT_DIR/test-app"

TEST_ENV="test"
TEST_VERSION="1.0.0-e2e"

# Load common functions
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/common/assertions.sh"
source "$SCRIPT_DIR/common/verify-deployment.sh"
source "$SCRIPT_DIR/common/setup-vms.sh"

# =============================================================================
# Steps 1-4: Setup Environment (Build CLI + VMs + Machines + Swarm)
# =============================================================================
log_step "Steps 1-4: Setting up E2E environment..."

setup_e2e_environment "$TEST_APP_DIR" "$TEST_ENV" || exit 1
CLI_BIN="$CLI_BIN_PATH"

NODE_COUNT=$(check_swarm_ready) || exit 1
log_success "Environment ready (Swarm with $NODE_COUNT nodes)"

# =============================================================================
# Step 5: Deploy with replicas (uses DOCKER connection strings - hostname:22)
# =============================================================================
log_step "Step 5: Deploying application..."

cd "$TEST_APP_DIR"

# Get Docker connection strings (container to container communication)
get_docker_connection_strings "$TEST_APP_DIR" || exit 1

# Update .env.dockflow with DOCKER connection strings (for deploy running in container)
cat >.env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION_DOCKER
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION_DOCKER
EOF

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	DOCKFLOW_DOCKER_NETWORK="docker_test-network" \
	"$CLI_BIN" deploy "$TEST_ENV" "$TEST_VERSION" --dev --force --skip-docker-install
DEPLOY_EXIT_CODE=$?
set -e

cd "$SCRIPT_DIR"

# Keep .env.dockflow for debugging - it will be cleaned up by teardown.sh

if [[ $DEPLOY_EXIT_CODE -ne 0 ]]; then
	log_error "Deployment failed with exit code $DEPLOY_EXIT_CODE"
	exit 1
fi
log_success "Deployment completed"

# =============================================================================
# Step 6: Comprehensive Deployment Verification
# =============================================================================
log_step "Step 6: Running comprehensive deployment verification..."

STACK_NAME="test-app-${TEST_ENV}"
SERVICE_NAME="${STACK_NAME}_web"
MANAGER_NODE="dockflow-test-manager"
WORKER_NODE="dockflow-test-worker-1"

# Wait for service to reach desired state first
for ((i = 1; i <= 60; i++)); do
	REPLICAS=$(docker exec $MANAGER_NODE docker service ls \
		--filter "name=$SERVICE_NAME" \
		--format '{{.Replicas}}' 2>/dev/null || echo "0/0")

	if [[ "$REPLICAS" == "2/2" ]]; then
		break
	fi

	if [[ $i -eq 60 ]]; then
		log_error "Service did not reach 2/2 replicas (current: $REPLICAS)"
		docker exec $MANAGER_NODE docker service ps "$SERVICE_NAME"
		exit 1
	fi
	sleep 1
done

# Run comprehensive verification
if ! verify_deployment "$STACK_NAME" "$SERVICE_NAME" "2/2" "$MANAGER_NODE" "$WORKER_NODE"; then
	log_error "Deployment verification failed!"
	exit 1
fi

log_success "All deployment verifications passed"

# =============================================================================
# Step 7: Remote Build Test (runs by default, skip with --skip-remote-build)
# =============================================================================
REMOTE_BUILD_PASSED=""
if [[ "${1:-}" != "--skip-remote-build" ]]; then
	log_step "Step 7: Running remote build test..."

	# Pass --skip-setup flag since environment is already ready
	if bash "$SCRIPT_DIR/run-remote-build-test.sh" --skip-setup; then
		REMOTE_BUILD_PASSED="yes"
	else
		log_error "Remote build test failed"
		exit 1
	fi
fi

# =============================================================================
# Success
# =============================================================================
echo ""
echo -e "${GREEN}=========================================="
echo "   ALL E2E TESTS PASSED"
echo "==========================================${NC}"
echo ""
echo "Summary:"
echo "  ✓ CLI built"
echo "  ✓ Manager + Worker VMs started"
echo "  ✓ Machines configured"
echo "  ✓ Swarm cluster initialized (2 nodes)"
echo "  ✓ Application deployed (2 replicas)"
echo "  ✓ Replicas distributed across nodes"
if [[ -n "$REMOTE_BUILD_PASSED" ]]; then
	echo "  ✓ Remote build test passed"
fi
echo ""
echo "Options:"
echo "  --skip-remote-build  Skip remote build test"
echo ""
echo "To cleanup: $SCRIPT_DIR/teardown.sh"
