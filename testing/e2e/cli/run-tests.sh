#!/bin/bash
# =============================================================================
# CLI E2E Tests - Setup manager and worker nodes
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKFLOW_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

echo "=========================================="
echo "   DockFlow CLI E2E Tests"
echo "=========================================="
echo ""

# Build CLI if needed
CLI_BINARY="$DOCKFLOW_ROOT/cli-ts/dist/dockflow-linux-x64"
if [[ ! -f "$CLI_BINARY" ]]; then
    echo "Building CLI binary..."
    cd "$DOCKFLOW_ROOT/cli-ts"
    bun install --frozen-lockfile
    bun run build linux-x64
    cd "$DOCKFLOW_ROOT"
    echo "✓ CLI binary built"
else
    echo "✓ Using existing CLI binary"
fi
echo ""

# Start test VMs if not running
if ! docker ps | grep -q "dockflow-test-manager"; then
    echo "Starting test environment..."
    cd "$ROOT_DIR/common"
    bash setup.sh
    cd "$DOCKFLOW_ROOT"
    echo ""
fi

# Load test environment config
source "$ROOT_DIR/.env" 2>/dev/null || true

if [[ -z "${SSH_USER:-}" || -z "${SSH_PASSWORD:-}" || -z "${DEPLOY_USER:-}" ]]; then
    echo "ERROR: Missing required env vars"
    exit 1
fi

# =============================================================================
# Setup function - runs dockflow setup auto on a node
# =============================================================================
setup_node() {
    local node_name="$1"
    local external_port="$2"  # Port accessible from outside (2222, 2223)
    local container_name="$3"
    
    echo "----------------------------------------"
    echo "Setting up: $node_name"
    echo "  External: localhost:$external_port"
    echo "----------------------------------------"
    
    local remote_temp="/tmp/dockflow-cli-$$"
    
    # SSH helper for this node
    ssh_node() {
        sshpass -p "$SSH_PASSWORD" ssh $SSH_OPTS -p "$external_port" "${SSH_USER}@localhost" "$@"
    }
    
    # Test connection
    if ! ssh_node "true" >/dev/null 2>&1; then
        echo "ERROR: Cannot connect to $node_name"
        return 1
    fi
    
    # Transfer CLI
    ssh_node "mkdir -p $remote_temp"
    sshpass -p "$SSH_PASSWORD" scp $SSH_OPTS -P "$external_port" \
        "$CLI_BINARY" "${SSH_USER}@localhost:$remote_temp/dockflow"
    ssh_node "chmod +x $remote_temp/dockflow"
    
    # Run setup - use localhost and the EXTERNAL port for the connection string
    # This is what the CLI will use to connect from outside Docker
    set +e
    local cli_output
    cli_output=$(ssh_node "cd $remote_temp && ./dockflow setup auto \
        --host localhost \
        --port $external_port \
        --user $DEPLOY_USER \
        --password 'dockflow123' \
        --generate-key \
        --skip-docker-install 2>&1")
    local exit_code=$?
    set -e
    
    echo "$cli_output"
    
    # Cleanup
    ssh_node "rm -rf $remote_temp" 2>/dev/null || true
    
    if [[ $exit_code -ne 0 ]]; then
        echo "ERROR: Setup failed for $node_name"
        return 1
    fi
    
    # Extract connection string
    local conn_string
    conn_string=$(echo "$cli_output" | grep -A 2 "Connection String (Base64):" | tail -n 1 | grep -v "━" | xargs || true)
    
    if [[ -z "$conn_string" ]]; then
        echo "ERROR: No connection string for $node_name"
        return 1
    fi
    
    # Validate
    local conn_json conn_host conn_user
    conn_json=$(echo "$conn_string" | base64 -d 2>/dev/null)
    conn_host=$(echo "$conn_json" | jq -r '.host // empty')
    conn_user=$(echo "$conn_json" | jq -r '.user // empty')
    
    if [[ -z "$conn_host" || -z "$conn_user" ]]; then
        echo "ERROR: Invalid connection string for $node_name"
        return 1
    fi
    
    echo "✓ $node_name setup complete (host: $conn_host, user: $conn_user)"
    
    # Verify user was created
    if ! docker exec "$container_name" id "$conn_user" >/dev/null 2>&1; then
        echo "ERROR: Deploy user not created on $node_name"
        return 1
    fi
    echo "✓ Deploy user exists on $node_name"
    
    # Output connection string for parent script
    echo "::${node_name}_CONNECTION::$conn_string"
    echo ""
}

# =============================================================================
# Setup Manager
# =============================================================================
echo ""
echo "=========================================="
echo "TEST 1: Setup Manager Node"
echo "=========================================="
echo ""

setup_node "MANAGER" "$SSH_PORT_MANAGER" "dockflow-test-manager"

# =============================================================================
# Setup Worker
# =============================================================================
echo ""
echo "=========================================="
echo "TEST 2: Setup Worker Node"
echo "=========================================="
echo ""

setup_node "WORKER_1" "$SSH_PORT_WORKER_1" "dockflow-test-worker-1"

# =============================================================================
# Verify both nodes
# =============================================================================
echo ""
echo "=========================================="
echo "TEST 3: Verify Docker on all nodes"
echo "=========================================="
echo ""

for container in dockflow-test-manager dockflow-test-worker-1; do
    if docker exec "$container" docker --version >/dev/null 2>&1; then
        echo "✓ Docker running on $container"
    else
        echo "ERROR: Docker not running on $container"
        exit 1
    fi
done

echo ""
echo "=========================================="
echo "   CLI TESTS PASSED ✓"
echo "=========================================="
