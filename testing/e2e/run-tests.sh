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

CLI_BINARY=$(get_cli_binary)
CLI_BIN="$CLI_DIR/dist/$CLI_BINARY"

# =============================================================================
# Step 1: Build CLI
# =============================================================================
log_step "Step 1: Building CLI binary..."

if ! command -v bun &>/dev/null; then
    log_error "Bun is required"
    exit 1
fi

cd "$CLI_DIR"
bun install --frozen-lockfile
bun run build "$(echo "$CLI_BINARY" | sed 's/dockflow-//')"
cd "$SCRIPT_DIR"

if [[ ! -f "$CLI_BIN" ]]; then
    log_error "CLI binary not found at $CLI_BIN"
    exit 1
fi
log_success "CLI built: $CLI_BINARY"

# =============================================================================
# Step 2: Start VMs (manager + worker)
# =============================================================================
log_step "Step 2: Starting test VMs..."

cd "$SCRIPT_DIR/docker"
docker compose --env-file "$SCRIPT_DIR/.env" up -d --build

# Wait for both containers to be healthy
MAX_WAIT=90
log_success "Waiting for containers to be healthy..."
for ((i=1; i<=MAX_WAIT; i++)); do
    # Count lines containing "healthy" (not "unhealthy")
    HEALTHY_COUNT=$(docker compose --env-file "$SCRIPT_DIR/.env" ps 2>/dev/null | grep -E '\(healthy\)' | wc -l)
    HEALTHY_COUNT=$((HEALTHY_COUNT + 0))  # Ensure numeric
    if [[ "$HEALTHY_COUNT" -ge 2 ]]; then
        log_success "Both VMs are healthy"
        break
    fi
    if [[ $i -eq $MAX_WAIT ]]; then
        log_error "VMs did not become healthy in ${MAX_WAIT}s"
        docker compose --env-file "$SCRIPT_DIR/.env" ps
        exit 1
    fi
    sleep 1
done

cd "$SCRIPT_DIR"

# =============================================================================
# Step 3: Setup machines (manager + worker)
# =============================================================================
log_step "Step 3: Setting up machines..."

TEMP_OUTPUT=$(mktemp)
trap "rm -f $TEMP_OUTPUT" EXIT

set +e
bash "$SCRIPT_DIR/cli/run-tests.sh" 2>&1 | tee "$TEMP_OUTPUT"
CLI_EXIT_CODE=${PIPESTATUS[0]}
set -e

if [[ $CLI_EXIT_CODE -ne 0 ]]; then
    log_error "CLI tests failed"
    exit 1
fi
log_success "Machines setup complete"

# Extract connection strings
MANAGER_CONNECTION=$(grep "^::MANAGER_CONNECTION::" "$TEMP_OUTPUT" | tail -n 1 | sed 's/^::MANAGER_CONNECTION:://')
WORKER_1_CONNECTION=$(grep "^::WORKER_1_CONNECTION::" "$TEMP_OUTPUT" | tail -n 1 | sed 's/^::WORKER_1_CONNECTION:://')

if [[ -z "$MANAGER_CONNECTION" || -z "$WORKER_1_CONNECTION" ]]; then
    log_error "Could not capture connection strings"
    echo "Manager: ${MANAGER_CONNECTION:-MISSING}"
    echo "Worker: ${WORKER_1_CONNECTION:-MISSING}"
    exit 1
fi
log_success "Connection strings captured"

# Function to transform connection string for Docker network access
# Replaces localhost:PORT with docker_hostname:22
transform_connection_for_docker() {
    local conn_string="$1"
    local docker_hostname="$2"
    
    # Decode, modify host/port, re-encode
    local json
    json=$(echo "$conn_string" | base64 -d)
    json=$(echo "$json" | jq --arg host "$docker_hostname" '.host = $host | .port = 22')
    echo "$json" | base64 -w 0
}

# Connection strings for Swarm setup (localhost with mapped ports - runs on host)
MANAGER_CONNECTION_HOST="$MANAGER_CONNECTION"
WORKER_1_CONNECTION_HOST="$WORKER_1_CONNECTION"

# Connection strings for Deploy (Docker hostnames - runs in container on same network)
MANAGER_CONNECTION_DOCKER=$(transform_connection_for_docker "$MANAGER_CONNECTION" "dockflow-test-mgr")
WORKER_1_CONNECTION_DOCKER=$(transform_connection_for_docker "$WORKER_1_CONNECTION" "dockflow-test-w1")

# =============================================================================
# Step 4: Setup Swarm cluster (uses HOST connection strings - localhost:port)
# =============================================================================
log_step "Step 4: Setting up Swarm cluster..."

cd "$TEST_APP_DIR"

# Create .env.dockflow with HOST connection strings (for setup swarm running on host)
cat > .env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION_HOST
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION_HOST
EOF

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
"$CLI_BIN" setup swarm "$TEST_ENV"
SWARM_EXIT_CODE=$?
set -e

if [[ $SWARM_EXIT_CODE -ne 0 ]]; then
    log_error "Swarm setup failed with exit code $SWARM_EXIT_CODE"
    rm -f .env.dockflow
    exit 1
fi
log_success "Swarm cluster initialized"

# Verify swarm nodes
NODE_COUNT=$(docker exec dockflow-test-manager docker node ls --format '{{.ID}}' 2>/dev/null | wc -l)
if [[ "$NODE_COUNT" -ge 2 ]]; then
    log_success "Swarm has $NODE_COUNT nodes"
    docker exec dockflow-test-manager docker node ls
else
    log_error "Expected 2 nodes, got $NODE_COUNT"
    exit 1
fi

# =============================================================================
# Step 5: Deploy with replicas (uses DOCKER connection strings - hostname:22)
# =============================================================================
log_step "Step 5: Deploying application..."

# Update .env.dockflow with DOCKER connection strings (for deploy running in container)
cat > .env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION_DOCKER
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION_DOCKER
EOF

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
DOCKFLOW_DOCKER_NETWORK="docker_test-network" \
"$CLI_BIN" deploy "$TEST_ENV" "$TEST_VERSION" --dev --force --skip-docker-install
DEPLOY_EXIT_CODE=$?
set -e

# Keep .env.dockflow for debugging - it will be cleaned up by teardown.sh

if [[ $DEPLOY_EXIT_CODE -ne 0 ]]; then
    log_error "Deployment failed with exit code $DEPLOY_EXIT_CODE"
    exit 1
fi
log_success "Deployment completed"

# =============================================================================
# Step 6: Verify replicas distributed across nodes
# =============================================================================
log_step "Step 6: Verifying replica distribution..."

SERVICE_NAME="test-app-${TEST_ENV}_web"

# Wait for service to be ready
for ((i=1; i<=60; i++)); do
    REPLICAS=$(docker exec dockflow-test-manager docker service ls \
        --filter "name=$SERVICE_NAME" \
        --format '{{.Replicas}}' 2>/dev/null || echo "0/0")
    
    if [[ "$REPLICAS" == "2/2" ]]; then
        log_success "Service running with $REPLICAS replicas"
        break
    fi
    
    if [[ $i -eq 60 ]]; then
        log_error "Service did not reach 2/2 replicas (current: $REPLICAS)"
        docker exec dockflow-test-manager docker service ps "$SERVICE_NAME"
        exit 1
    fi
    sleep 1
done

# Check distribution across nodes
echo ""
echo "Replica distribution:"
docker exec dockflow-test-manager docker service ps "$SERVICE_NAME" \
    --format 'table {{.Name}}\t{{.Node}}\t{{.CurrentState}}'

# Count unique nodes
NODES_WITH_REPLICAS=$(docker exec dockflow-test-manager docker service ps "$SERVICE_NAME" \
    --filter "desired-state=running" \
    --format '{{.Node}}' | sort -u | wc -l)

if [[ "$NODES_WITH_REPLICAS" -ge 2 ]]; then
    log_success "Replicas distributed across $NODES_WITH_REPLICAS nodes"
else
    log_error "Replicas not distributed (only on $NODES_WITH_REPLICAS node)"
    exit 1
fi

# =============================================================================
# Step 7: Remote Build Test (runs by default, skip with --skip-remote-build)
# =============================================================================
REMOTE_BUILD_PASSED=""
if [[ "${1:-}" != "--skip-remote-build" ]]; then
    log_step "Step 7: Running remote build test..."
    
    if bash "$SCRIPT_DIR/run-remote-build-test.sh"; then
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
