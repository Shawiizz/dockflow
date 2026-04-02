#!/bin/bash
# =============================================================================
# Dockflow E2E Test - Remote Build
# =============================================================================
# Tests that remote_build: true works correctly.
# Copies test app files to the manager, creates a git repo there,
# and deploys using the remote build flow (git clone + docker build on remote).
#
# Can run standalone (will setup VMs if needed) or after run-tests.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_DIR="$DOCKFLOW_ROOT/cli-ts"
TEST_APP_DIR="$SCRIPT_DIR/test-app-remote"
PRIMARY_TEST_APP_DIR="$SCRIPT_DIR/test-app"

TEST_ENV="test"
TEST_VERSION="1.0.0-remote"
MANAGER_NODE="dockflow-test-manager"
WORKER_NODE="dockflow-test-worker-1"
REMOTE_REPO_PATH="/home/deploytest/repos/test-app-remote"

# Load common functions
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/common/assertions.sh"
source "$SCRIPT_DIR/common/verify-deployment.sh"
source "$SCRIPT_DIR/common/setup-vms.sh"

# Load environment
source "$SCRIPT_DIR/.env" 2>/dev/null || true

echo ""
echo -e "${BLUE}=========================================="
echo "   Dockflow E2E - Remote Build Test"
echo "==========================================${NC}"
echo ""

# =============================================================================
# Pre-checks / Setup
# =============================================================================
log_step "Checking environment..."

SKIP_SETUP=false
if [[ "${1:-}" == "--skip-setup" ]]; then
	SKIP_SETUP=true
	log_info "Skipping setup (--skip-setup flag)"
fi

if check_vms_running 2>/dev/null && check_swarm_ready 2>/dev/null; then
	log_success "VMs already running and Swarm ready"
	CLI_BINARY=$(get_cli_binary)
	CLI_BIN="$CLI_DIR/dist/$CLI_BINARY"

	if [[ ! -f "$CLI_BIN" ]]; then
		build_cli || exit 1
		CLI_BIN="$CLI_BIN_PATH"
	fi
elif [[ "$SKIP_SETUP" == "true" ]]; then
	log_error "VMs not running but --skip-setup was specified"
	exit 1
else
	log_info "Setting up E2E environment (VMs + Swarm)..."
	setup_e2e_environment "$PRIMARY_TEST_APP_DIR" "$TEST_ENV" || exit 1
	CLI_BIN="$CLI_BIN_PATH"
fi

NODE_COUNT=$(check_swarm_ready) || exit 1
log_success "Environment ready (Swarm with $NODE_COUNT nodes)"

# =============================================================================
# Step 1: Create git repo on manager via docker cp
# =============================================================================
log_step "Step 1: Creating git repo on manager..."

# Clean any previous repo and ensure parent directory exists
docker exec $MANAGER_NODE bash -c "rm -rf $REMOTE_REPO_PATH && mkdir -p $(dirname $REMOTE_REPO_PATH) && chown deploytest:deploytest $(dirname $REMOTE_REPO_PATH)"

# Copy test app files to the manager
docker cp "$TEST_APP_DIR/." "$MANAGER_NODE:$REMOTE_REPO_PATH"

# Init a git repo and commit (as deploytest user)
docker exec $MANAGER_NODE bash -c "
    chown -R deploytest:deploytest $REMOTE_REPO_PATH
    cd $REMOTE_REPO_PATH
    sudo -u deploytest git init
    sudo -u deploytest git config user.email 'test@dockflow.local'
    sudo -u deploytest git config user.name 'Dockflow E2E Test'
    sudo -u deploytest git add -A
    sudo -u deploytest git commit -m 'Initial commit for remote build test'
"
log_success "Git repo created at $REMOTE_REPO_PATH on manager"

# =============================================================================
# Step 2: Prepare local git repo and connection strings
# =============================================================================
log_step "Step 2: Preparing local repo and connection strings..."

cd "$TEST_APP_DIR"

# Init a local git repo with origin pointing to the manager's local path.
# The CLI reads this URL and passes it to `git clone` on the remote server.
rm -rf .git
git init -q
git config user.email "test@dockflow.local"
git config user.name "Dockflow E2E Test"
git add -A
git commit -q -m "init"
git remote add origin "$REMOTE_REPO_PATH"

# Load connection strings from the main test's .env.dockflow
TEST_APP_ENV="$SCRIPT_DIR/test-app/.env.dockflow"
if [[ ! -f "$TEST_APP_ENV" ]]; then
	log_error "test-app/.env.dockflow not found - run run-tests.sh first"
	exit 1
fi
source "$TEST_APP_ENV"

cat >"$TEST_APP_DIR/.env.dockflow" <<EOF
TEST_MAIN_SERVER_CONNECTION=$TEST_MAIN_SERVER_CONNECTION
TEST_WORKER_1_CONNECTION=$TEST_WORKER_1_CONNECTION
EOF

log_success "Local repo and connection strings ready"

# =============================================================================
# Step 3: Deploy with remote build
# =============================================================================
log_step "Step 3: Deploying with remote_build: true..."

cd "$TEST_APP_DIR"

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	"$CLI_BIN" deploy "$TEST_ENV" "$TEST_VERSION" --force 2>&1
DEPLOY_EXIT_CODE=$?
set -e

if [[ $DEPLOY_EXIT_CODE -ne 0 ]]; then
	log_error "Remote build deployment failed with exit code $DEPLOY_EXIT_CODE"
	echo ""
	log_info "Debug: Checking if image was built..."
	docker exec $MANAGER_NODE docker images | grep -E "test-remote|REPOSITORY" || true
	echo ""
	log_info "Debug: Checking services..."
	docker exec $MANAGER_NODE docker service ls 2>/dev/null || true
	exit 1
fi
log_success "Remote build deployment completed"

# =============================================================================
# Step 4: Deployment verification
# =============================================================================
log_step "Step 4: Running deployment verification..."

STACK_NAME="test-app-remote-${TEST_ENV}"
SERVICE_NAME="${STACK_NAME}_web"

wait_for_service "$SERVICE_NAME" "1/1" 60 || exit 1

# Verify the image was built on the remote server (not locally)
log_info "Checking image was built remotely..."
if check_image_exists "test-remote-web-app"; then
	log_success "Image 'test-remote-web-app' exists on manager (remote build verified)"
else
	log_error "Image not found on manager - remote build may have failed"
	exit 1
fi

if ! verify_deployment "$STACK_NAME" "$SERVICE_NAME" "1/1" "$MANAGER_NODE" "$WORKER_NODE"; then
	log_error "Deployment verification failed!"
	exit 1
fi

log_success "All deployment verifications passed"

# =============================================================================
# Cleanup
# =============================================================================
log_step "Cleanup..."

rm -rf "$TEST_APP_DIR/.git"
rm -f "$TEST_APP_DIR/.env.dockflow"

log_success "Cleanup complete"

# =============================================================================
# Success
# =============================================================================
echo ""
echo -e "${GREEN}=========================================="
echo "   REMOTE BUILD TEST PASSED ✓"
echo "==========================================${NC}"
echo ""
echo "Summary:"
echo "  ✓ Git repo created on manager (docker cp)"
echo "  ✓ Deploy with remote_build: true succeeded"
echo "  ✓ Image built on remote server"
echo "  ✓ Service running correctly"
echo ""
