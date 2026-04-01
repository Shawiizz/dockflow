#!/bin/bash
# =============================================================================
# Dockflow E2E Test Runner - Multi-Node Swarm
# =============================================================================
# Architecture:
#   1. Build CLI binary
#   2. Start VMs (manager + worker)
#   3. Setup machines (dockflow setup on both nodes)
#   4. Setup Swarm cluster (dockflow setup swarm)
#   5. Deploy with 2 replicas
#   6. Verify replicas distributed across nodes
#   7. Traefik proxy verification
#   8. Standalone build test (in-memory tar)
#   9. Backup & restore test
#  10. Remote build test
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
# Step 5: Deploy with replicas (uses host-accessible connection strings - localhost:port)
# =============================================================================
log_step "Step 5: Deploying application..."

cd "$TEST_APP_DIR"

# Load connection strings: either from setup_machines() or from existing .env.dockflow
if [[ -z "${MANAGER_CONNECTION:-}" && -f .env.dockflow ]]; then
	source .env.dockflow
	MANAGER_CONNECTION="${TEST_MAIN_SERVER_CONNECTION:-}"
	WORKER_1_CONNECTION="${TEST_WORKER_1_CONNECTION:-}"
fi

# Write WSL-accessible connection strings (localhost:2222/2223)
cat >.env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION
EOF

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	"$CLI_BIN" deploy "$TEST_ENV" "$TEST_VERSION" --force
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
# Step 7: Traefik Proxy Verification
# =============================================================================
log_step "Step 7: Verifying Traefik proxy routing..."

# 1. Traefik stack is running
TRAEFIK_REPLICAS=$(docker exec $MANAGER_NODE docker service ls \
	--filter "name=traefik_traefik" \
	--format '{{.Replicas}}' 2>/dev/null || echo "0/0")

if [[ "$TRAEFIK_REPLICAS" != "1/1" ]]; then
	log_error "Traefik service not running (replicas: $TRAEFIK_REPLICAS)"
	docker exec $MANAGER_NODE docker service ps traefik_traefik 2>/dev/null || true
	exit 1
fi
log_success "Traefik stack running (1/1)"

# 2. Traefik labels injected on web service
TRAEFIK_LABEL=$(docker exec $MANAGER_NODE docker service inspect "${SERVICE_NAME}" \
	--format '{{json .Spec.Labels}}' 2>/dev/null | grep -o '"traefik\.enable":"true"' || true)

if [[ -z "$TRAEFIK_LABEL" ]]; then
	log_error "Traefik labels not found on service ${SERVICE_NAME}"
	docker exec $MANAGER_NODE docker service inspect "${SERVICE_NAME}" \
		--format '{{json .Spec.Labels}}' 2>/dev/null || true
	exit 1
fi
log_success "Traefik labels injected on ${SERVICE_NAME}"

# 3. HTTP routing via Host header
# Retry up to 30s for Traefik to finish routing configuration
TRAEFIK_HTTP_OK=""
for ((i = 1; i <= 30; i++)); do
	HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
		-H "Host: test.local" \
		--connect-timeout 2 \
		--max-time 5 \
		http://localhost:80/ 2>/dev/null || echo "000")
	if [[ "$HTTP_STATUS" =~ ^[23] ]]; then
		TRAEFIK_HTTP_OK="yes"
		break
	fi
	sleep 1
done

if [[ -z "$TRAEFIK_HTTP_OK" ]]; then
	log_error "Traefik HTTP routing failed (last status: $HTTP_STATUS)"
	log_info "Traefik logs:"
	docker exec $MANAGER_NODE docker service logs traefik_traefik --tail 20 2>/dev/null || true
	exit 1
fi
log_success "HTTP routing works (Host: test.local → HTTP $HTTP_STATUS)"

# =============================================================================
# Step 8: Standalone Build Test
# =============================================================================
log_step "Step 8: Running standalone build test..."

if bash "$SCRIPT_DIR/run-build-test.sh" --skip-setup; then
	log_success "Standalone build test passed"
else
	log_error "Standalone build test failed"
	exit 1
fi

# =============================================================================
# Step 9: Backup & Restore Test
# =============================================================================
log_step "Step 9: Running backup & restore test..."

if bash "$SCRIPT_DIR/run-backup-test.sh"; then
	log_success "Backup & restore test passed"
else
	log_error "Backup & restore test failed"
	exit 1
fi

# =============================================================================
# Step 10: Remote Build Test (runs by default, skip with --skip-remote-build)
# =============================================================================
REMOTE_BUILD_PASSED=""
if [[ "${1:-}" != "--skip-remote-build" ]]; then
	log_step "Step 10: Running remote build test..."

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
echo "  ✓ Traefik proxy routing verified"
echo "  ✓ Standalone build verified (in-memory tar)"
echo "  ✓ Backup & restore verified (Redis)"
if [[ -n "$REMOTE_BUILD_PASSED" ]]; then
	echo "  ✓ Remote build test passed"
fi
echo ""
echo "Options:"
echo "  --skip-remote-build  Skip remote build test"
echo ""
echo "To cleanup: $SCRIPT_DIR/teardown.sh"
