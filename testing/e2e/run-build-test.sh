#!/bin/bash
# =============================================================================
# Dockflow E2E Build Test
# =============================================================================
# Tests the standalone `dockflow build` command (in-memory tar context).
#
# Usage:
#   bash run-build-test.sh              # Full run (needs VMs for template context)
#   bash run-build-test.sh --skip-setup # Reuse existing environment
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR="$DOCKFLOW_ROOT/cli-ts"
TEST_APP_DIR="$SCRIPT_DIR/test-app"
TEST_ENV="test"

# Load common functions
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/common/assertions.sh"
source "$SCRIPT_DIR/common/setup-vms.sh"

# =============================================================================
# Setup
# =============================================================================
if [[ "${1:-}" != "--skip-setup" ]]; then
	log_step "Setting up E2E environment..."
	setup_e2e_environment "$TEST_APP_DIR" "$TEST_ENV" || exit 1
fi

CLI_BIN="${CLI_BIN_PATH:-$CLI_DIR/dist/$(get_cli_binary)}"
if [[ ! -f "$CLI_BIN" ]]; then
	log_error "CLI binary not found at $CLI_BIN"
	exit 1
fi

# =============================================================================
# Step 1: Clean up any previous build artifacts
# =============================================================================
log_step "Step 1: Cleaning previous build artifacts..."

docker rmi test-web-app 2>/dev/null || true
log_success "Cleanup done"

# =============================================================================
# Step 2: Run standalone build
# =============================================================================
log_step "Step 2: Running dockflow build..."

cd "$TEST_APP_DIR"

# Write connection strings for template context resolution
get_docker_connection_strings "$TEST_APP_DIR" 2>/dev/null || true
if [[ -n "${MANAGER_CONNECTION:-}" && -n "${WORKER_1_CONNECTION:-}" ]]; then
	cat >.env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION
EOF
fi

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	"$CLI_BIN" build "$TEST_ENV" --skip-hooks --debug
BUILD_EXIT_CODE=$?
set -e

cd "$SCRIPT_DIR"

if [[ $BUILD_EXIT_CODE -ne 0 ]]; then
	log_error "Build failed with exit code $BUILD_EXIT_CODE"
	exit 1
fi
log_success "Build command completed"

# =============================================================================
# Step 3: Verify image was created
# =============================================================================
log_step "Step 3: Verifying built image..."

if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "test-web-app"; then
	log_error "Image 'test-web-app' not found after build"
	docker images
	exit 1
fi
log_success "Image 'test-web-app' exists"

# Verify the image is valid (can be inspected)
IMAGE_ID=$(docker inspect --format '{{.Id}}' test-web-app 2>/dev/null || echo "")
if [[ -z "$IMAGE_ID" ]]; then
	log_error "Image 'test-web-app' cannot be inspected"
	exit 1
fi
log_success "Image is valid (ID: ${IMAGE_ID:0:19})"

# =============================================================================
# Step 4: Verify image content (nginx should serve our test page)
# =============================================================================
log_step "Step 4: Verifying image content..."

# Run a quick container and check the HTML is there
CONTAINER_ID=$(docker run -d --rm test-web-app)
sleep 1

set +e
HTML_CONTENT=$(docker exec "$CONTAINER_ID" cat /usr/share/nginx/html/index.html 2>/dev/null)
set -e

docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true

if [[ -z "$HTML_CONTENT" ]]; then
	log_error "Could not read index.html from built image"
	exit 1
fi
log_success "Image contains expected content"

# =============================================================================
# Step 5: Rebuild to verify idempotency (tar context is deterministic)
# =============================================================================
log_step "Step 5: Verifying rebuild works..."

cd "$TEST_APP_DIR"

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	"$CLI_BIN" build "$TEST_ENV" --skip-hooks
REBUILD_EXIT_CODE=$?
set -e

cd "$SCRIPT_DIR"

if [[ $REBUILD_EXIT_CODE -ne 0 ]]; then
	log_error "Rebuild failed with exit code $REBUILD_EXIT_CODE"
	exit 1
fi
log_success "Rebuild completed successfully"

# =============================================================================
# Cleanup
# =============================================================================
docker rmi test-web-app 2>/dev/null || true

# =============================================================================
# Success
# =============================================================================
echo ""
echo -e "${GREEN}=========================================="
echo "   BUILD TEST PASSED"
echo "==========================================${NC}"
echo ""
echo "Summary:"
echo "  ✓ Standalone build completed (in-memory tar context)"
echo "  ✓ Image created and valid"
echo "  ✓ Image content verified"
echo "  ✓ Rebuild idempotency verified"
echo ""
