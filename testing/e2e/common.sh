#!/bin/bash
# =============================================================================
# Common functions for E2E tests
# =============================================================================

# Guard against multiple sourcing
if [[ -n "${_COMMON_SH_LOADED:-}" ]]; then
    return 0 2>/dev/null || exit 0
fi
_COMMON_SH_LOADED=1

# Colors
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

# Logging functions
log_step() { echo -e "\n${YELLOW}▶ $1${NC}\n"; }
log_success() { echo -e "${GREEN}✓ $1${NC}"; }
log_error() { echo -e "${RED}✗ $1${NC}"; }
log_info() { echo -e "${BLUE}ℹ $1${NC}"; }

# Get CLI binary name for current platform
get_cli_binary() {
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)  echo "dockflow-linux-x64" ;;
        Linux-aarch64) echo "dockflow-linux-arm64" ;;
        Darwin-x86_64) echo "dockflow-macos-x64" ;;
        Darwin-arm64)  echo "dockflow-macos-arm64" ;;
        *)             echo "dockflow-linux-x64" ;;
    esac
}

# Transform connection string for Docker network access
# Usage: transform_connection_for_docker "$CONNECTION_STRING" "docker-hostname"
transform_connection_for_docker() {
    local conn_string="$1"
    local docker_hostname="$2"
    
    local json
    json=$(echo "$conn_string" | base64 -d)
    json=$(echo "$json" | jq --arg host "$docker_hostname" '.host = $host | .port = 22')
    echo "$json" | base64 -w 0
}

# Check if test VMs are running
check_vms_running() {
    if ! docker ps | grep -q "dockflow-test-manager"; then
        log_error "Test VMs not running"
        log_info "Run run-tests.sh first to start VMs and setup Swarm"
        return 1
    fi
    return 0
}

# Check if Swarm is initialized and return node count
check_swarm_ready() {
    local node_count
    node_count=$(docker exec dockflow-test-manager docker node ls --format '{{.ID}}' 2>/dev/null | wc -l || echo "0")
    
    if (( node_count < 1 )); then
        log_error "Swarm not initialized"
        log_info "Run run-tests.sh first to setup Swarm cluster"
        return 1
    fi
    
    echo "$node_count"
}

# Wait for a Docker service to reach expected replicas
# Usage: wait_for_service "service-name" "1/1" 60
wait_for_service() {
    local service_name="$1"
    local expected_replicas="$2"
    local timeout="${3:-60}"
    
    for ((i=1; i<=timeout; i++)); do
        local replicas
        replicas=$(docker exec dockflow-test-manager docker service ls \
            --filter "name=$service_name" \
            --format '{{.Replicas}}' 2>/dev/null || echo "0/0")
        
        if [[ "$replicas" == "$expected_replicas" ]]; then
            log_success "Service $service_name running with $replicas replicas"
            return 0
        fi
        
        if (( i == timeout )); then
            log_error "Service $service_name did not reach $expected_replicas replicas (current: $replicas)"
            docker exec dockflow-test-manager docker service ps "$service_name" 2>/dev/null || true
            return 1
        fi
        sleep 1
    done
}

# Check if image exists on manager
# Usage: check_image_exists "image-name"
check_image_exists() {
    local image_name="$1"
    
    if docker exec dockflow-test-manager docker images --format '{{.Repository}}' | grep -q "$image_name"; then
        return 0
    fi
    return 1
}
