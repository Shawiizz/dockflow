#!/bin/bash
# =============================================================================
# Dockflow E2E Test - Remote Build
# =============================================================================
# This test verifies that remote_build: true works correctly.
# It creates a Git repository on the manager, pushes code, and deploys.
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
# Pre-checks / Setup (auto-setup if needed, skip with --skip-setup)
# =============================================================================
log_step "Checking environment..."

SKIP_SETUP=false
if [[ "${1:-}" == "--skip-setup" ]]; then
	SKIP_SETUP=true
	log_info "Skipping setup (--skip-setup flag)"
fi

# Try to setup or verify existing environment
if check_vms_running 2>/dev/null && check_swarm_ready 2>/dev/null; then
	log_success "VMs already running and Swarm ready"
	CLI_BINARY=$(get_cli_binary)
	CLI_BIN="$CLI_DIR/dist/$CLI_BINARY"

	# Build CLI if not present
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
# Step 1: Setup Git repository on manager
# =============================================================================
log_step "Step 1: Setting up Git repository on manager..."

REPO_NAME="test-app-remote"
REPO_PATH="/home/deploytest/repos/${REPO_NAME}.git"

# Create bare Git repository on manager
docker exec dockflow-test-manager bash -c "
    # Create repos directory
    mkdir -p /home/deploytest/repos
    chown deploytest:deploytest /home/deploytest/repos
    
    # Remove old repo if exists
    rm -rf $REPO_PATH
    
    # Create bare repository as deploytest user
    sudo -u deploytest git init --bare $REPO_PATH
    
    # Configure git to allow push (run as deploytest)
    sudo -u deploytest git -C $REPO_PATH config receive.denyCurrentBranch ignore
    
    # Setup SSH for root user to clone locally (for remote-build)
    # The deploytest user's authorized_keys already has the key, we just need root to use it
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    
    # Generate a key for root if it doesn't exist
    if [[ ! -f /root/.ssh/id_rsa ]]; then
        ssh-keygen -t rsa -b 2048 -f /root/.ssh/id_rsa -N '' -q
    fi
    
    # Add root's public key to deploytest's authorized_keys
    cat /root/.ssh/id_rsa.pub >> /home/deploytest/.ssh/authorized_keys
    
    # Configure SSH to not check host keys for localhost
    cat > /root/.ssh/config <<SSHCONFIG
Host localhost dockflow-test-mgr
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
SSHCONFIG
    chmod 600 /root/.ssh/config
"
log_success "Bare Git repository created at $REPO_PATH"

# =============================================================================
# Step 2: Initialize local Git repo and push
# =============================================================================
log_step "Step 2: Initializing local Git repo and pushing to manager..."

cd "$TEST_APP_DIR"

# Clean any existing git
rm -rf .git

# Initialize git repo
git init
git config user.email "test@dockflow.local"
git config user.name "Dockflow E2E Test"
git add -A
git commit -m "Initial commit for remote build test"

# Get the deploytest user's SSH key from the connection string saved by run-tests.sh
# The key is stored in the test-app/.env.dockflow file created during main test
TEST_APP_ENV="$SCRIPT_DIR/test-app/.env.dockflow"
if [[ ! -f "$TEST_APP_ENV" ]]; then
	log_error "test-app/.env.dockflow not found - run run-tests.sh first"
	exit 1
fi

# Extract the connection string and decode the private key
source "$TEST_APP_ENV"
DEPLOY_KEY=$(echo "$TEST_MAIN_SERVER_CONNECTION" | base64 -d | jq -r '.privateKey')

if [[ -z "$DEPLOY_KEY" || "$DEPLOY_KEY" == "null" ]]; then
	log_error "Could not extract deploy user SSH key from connection string"
	exit 1
fi

# Create temporary SSH key file
TEMP_KEY=$(mktemp)
echo "$DEPLOY_KEY" >"$TEMP_KEY"
chmod 600 "$TEMP_KEY"

# Push to manager using SSH
# We need to use the external port (2222) from host
GIT_SSH_COMMAND="ssh -i $TEMP_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $SSH_PORT_MANAGER" \
	git remote add origin "deploytest@localhost:$REPO_PATH" 2>/dev/null ||
	git remote set-url origin "deploytest@localhost:$REPO_PATH"

# Git creates 'master' by default, push it
set +e
GIT_SSH_COMMAND="ssh -i $TEMP_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $SSH_PORT_MANAGER" \
	git push -u origin master --force 2>&1
PUSH_EXIT=$?
set -e

# Cleanup temp key
rm -f "$TEMP_KEY"

if [[ $PUSH_EXIT -ne 0 ]]; then
	log_error "Failed to push to git repository"
	exit 1
fi

log_success "Code pushed to manager Git repository"

# Verify repo on manager
COMMIT_COUNT=$(docker exec dockflow-test-manager bash -c "cd $REPO_PATH && git rev-list --count HEAD 2>/dev/null || echo 0")
log_info "Repository has $COMMIT_COUNT commit(s)"

# =============================================================================
# Step 3: Create connection strings for deploy
# =============================================================================
log_step "Step 3: Preparing connection strings..."

# Connection strings are already loaded from test-app/.env.dockflow (source'd earlier)
# Transform them for Docker network (container to container)
MANAGER_CONN=$(transform_connection_for_docker "$TEST_MAIN_SERVER_CONNECTION" "dockflow-test-mgr")
WORKER_CONN=$(transform_connection_for_docker "$TEST_WORKER_1_CONNECTION" "dockflow-test-w1")

# Create .env.dockflow for test-app-remote
cat >"$TEST_APP_DIR/.env.dockflow" <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONN
TEST_WORKER_1_CONNECTION=$WORKER_CONN
EOF

log_success "Connection strings created"

# =============================================================================
# Step 4: Deploy with remote build
# =============================================================================
log_step "Step 4: Deploying with remote_build: true..."

cd "$TEST_APP_DIR"

# Configure git remote URL to use localhost since the manager clones from itself
# This simulates a real scenario where the repo URL is accessible from the build server
git remote set-url origin "deploytest@localhost:$REPO_PATH"

set +e
DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
	DOCKFLOW_DOCKER_NETWORK="docker_test-network" \
	"$CLI_BIN" deploy "$TEST_ENV" "$TEST_VERSION" --force --skip-docker-install 2>&1
DEPLOY_EXIT_CODE=$?
set -e

if [[ $DEPLOY_EXIT_CODE -ne 0 ]]; then
	log_error "Remote build deployment failed with exit code $DEPLOY_EXIT_CODE"

	# Show some debug info
	echo ""
	log_info "Debug: Checking if image was built..."
	docker exec dockflow-test-manager docker images | grep -E "test-remote|REPOSITORY" || true

	echo ""
	log_info "Debug: Checking services..."
	docker exec dockflow-test-manager docker service ls 2>/dev/null || true

	exit 1
fi
log_success "Remote build deployment completed"

# =============================================================================
# Step 5: Comprehensive Deployment Verification
# =============================================================================
log_step "Step 5: Running comprehensive deployment verification..."

STACK_NAME="test-app-remote-${TEST_ENV}"
SERVICE_NAME="${STACK_NAME}_web"
MANAGER_NODE="dockflow-test-manager"
WORKER_NODE="dockflow-test-worker-1"

# Wait for service to reach desired state first
wait_for_service "$SERVICE_NAME" "1/1" 60 || exit 1

# Verify the image was built on the remote server (not locally)
log_info "Checking image was built remotely..."
if check_image_exists "test-remote-web-app"; then
	log_success "Image 'test-remote-web-app' exists on manager (remote build verified)"
else
	log_error "Image not found on manager - remote build may have failed"
	exit 1
fi

# Run comprehensive verification (single replica, check manager + worker for images)
# For remote build with no registry, images should be distributed to workers
if ! verify_deployment "$STACK_NAME" "$SERVICE_NAME" "1/1" "$MANAGER_NODE" "$WORKER_NODE"; then
	log_error "Deployment verification failed!"
	exit 1
fi

log_success "All deployment verifications passed"

# =============================================================================
# Cleanup
# =============================================================================
log_step "Cleanup..."

# Remove the git repo from test app (keep it clean for re-runs)
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
echo "  ✓ Git repository created on manager"
echo "  ✓ Code pushed to remote repository"
echo "  ✓ Deploy with remote_build: true succeeded"
echo "  ✓ Image built on remote server"
echo "  ✓ Service running correctly"
echo ""
