#!/bin/bash
# =============================================================================
# Dockflow E2E Test - Backup & Restore
# =============================================================================
# Tests the backup/restore cycle on the Redis accessory deployed in test-app.
#
# Steps:
#   1. Inject test data into Redis
#   2. Create a backup (dockflow backup create)
#   3. Verify backup appears in list (dockflow backup list --json)
#   4. Corrupt the data in Redis
#   5. Restore from the backup (dockflow backup restore --yes)
#   6. Verify Redis is back up and data is intact
#
# Redis is pinned to the manager node in the test accessories config so the
# backup CLI (running from WSL, where worker hostnames are not resolvable) can
# always reach it via SSH. The helpers below still search all nodes defensively.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_APP_DIR="$SCRIPT_DIR/test-app"

TEST_ENV="test"
MANAGER_NODE="dockflow-test-manager"
WORKER_NODES=("dockflow-test-worker-1")
ACCESSORIES_STACK="test-app-${TEST_ENV}-accessories"
REDIS_SERVICE="${ACCESSORIES_STACK}_redis"

source "$SCRIPT_DIR/common.sh"

# Load Docker port configuration
E2E_ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$E2E_ENV_FILE" ]]; then
	# shellcheck source=/dev/null
	source "$E2E_ENV_FILE"
fi
SSH_PORT_MANAGER="${SSH_PORT_MANAGER:-2222}"
SSH_PORT_WORKER_1="${SSH_PORT_WORKER_1:-2223}"
DEPLOY_USER="${DEPLOY_USER:-deploytest}"

echo ""
echo -e "${BLUE}=========================================="
echo "   Dockflow E2E - Backup & Restore Test"
echo "==========================================${NC}"
echo ""

# =============================================================================
# Pre-checks
# =============================================================================
log_step "Checking environment..."

if ! check_vms_running; then
	log_error "Test VMs not running. Run run-tests.sh first."
	exit 1
fi

CLI_BIN="$DOCKFLOW_ROOT/cli-ts/dist/$(get_cli_binary)"
if [[ ! -f "$CLI_BIN" ]]; then
	log_error "CLI binary not found at $CLI_BIN"
	exit 1
fi

REDIS_REPLICAS=$(docker exec $MANAGER_NODE docker service ls \
	--filter "name=${REDIS_SERVICE}" \
	--format '{{.Replicas}}' 2>/dev/null || echo "")

if [[ "$REDIS_REPLICAS" != "1/1" ]]; then
	log_error "Redis accessory not running (replicas: ${REDIS_REPLICAS:-none})"
	log_info "Deploy test-app first with: bash run-tests.sh"
	exit 1
fi
log_success "Redis accessory running (1/1)"

# =============================================================================
# Rewrite .env.dockflow with localhost ports (WSL-accessible)
# The file normally contains Docker-internal hostnames (dockflow-test-mgr/w1)
# which are only reachable from inside the Docker network. The CLI runs from
# WSL, so we replace them with localhost + exposed ports for the duration of
# this test, then restore the original file afterwards.
# =============================================================================

make_wsl_connection() {
	local original_b64="$1"
	local port="$2"
	local json
	json=$(echo "$original_b64" | base64 -d)
	json=$(echo "$json" | jq --arg port "$port" '.host = "localhost" | .port = ($port | tonumber)')
	echo "$json" | base64 -w 0
}

ENV_FILE="$TEST_APP_DIR/.env.dockflow"
ORIGINAL_ENV_CONTENT=$(cat "$ENV_FILE")

# shellcheck source=/dev/null
source "$ENV_FILE"

MANAGER_WSL=$(make_wsl_connection "$TEST_MAIN_SERVER_CONNECTION" "$SSH_PORT_MANAGER")
WORKER_1_WSL=$(make_wsl_connection "$TEST_WORKER_1_CONNECTION" "$SSH_PORT_WORKER_1")

cat >"$ENV_FILE" <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_WSL
TEST_WORKER_1_CONNECTION=$WORKER_1_WSL
EOF

# Restore .env.dockflow on exit (success or failure)
restore_env() {
	echo "$ORIGINAL_ENV_CONTENT" >"$ENV_FILE"
}
trap restore_env EXIT

# =============================================================================
# Helpers
# =============================================================================

get_redis_container() {
	# Returns "NODE_NAME CONTAINER_ID" for whichever node is running Redis
	for node in "$MANAGER_NODE" "${WORKER_NODES[@]}"; do
		local id
		id=$(docker exec "$node" docker ps \
			--filter "label=com.docker.swarm.service.name=${REDIS_SERVICE}" \
			--format '{{.ID}}' 2>/dev/null | head -1)
		if [[ -n "$id" ]]; then
			echo "$node $id"
			return 0
		fi
	done
	return 1
}

redis_exec() {
	local location node container
	location=$(get_redis_container)
	if [[ -z "$location" ]]; then
		log_error "Redis container not found on any node"
		return 1
	fi
	node=$(echo "$location" | cut -d' ' -f1)
	container=$(echo "$location" | cut -d' ' -f2)
	docker exec "$node" docker exec "$container" redis-cli "$@"
}

wait_for_redis() {
	local max_wait=30
	for ((i = 1; i <= max_wait; i++)); do
		local pong
		pong=$(redis_exec PING 2>/dev/null || echo "")
		if [[ "$pong" == "PONG" ]]; then
			return 0
		fi
		sleep 1
	done
	log_error "Redis did not become responsive within ${max_wait}s"
	return 1
}

# =============================================================================
# Step 1: Inject test data
# =============================================================================
log_step "Step 1: Injecting test data into Redis..."

redis_exec SET dockflow_e2e_key "backup_test_value_$$" >/dev/null

STORED=$(redis_exec GET dockflow_e2e_key 2>/dev/null)
if [[ -z "$STORED" ]]; then
	log_error "Failed to write test key to Redis"
	exit 1
fi
log_success "Test key written: dockflow_e2e_key = $STORED"

# =============================================================================
# Step 2: Create backup
# =============================================================================
log_step "Step 2: Creating backup..."

cd "$TEST_APP_DIR"

set +e
BACKUP_OUTPUT=$("$CLI_BIN" backup create "$TEST_ENV" redis 2>&1)
BACKUP_EXIT=$?
set -e

echo "$BACKUP_OUTPUT"

if [[ $BACKUP_EXIT -ne 0 ]]; then
	log_error "Backup create failed (exit $BACKUP_EXIT)"
	exit 1
fi

BACKUP_ID=$(echo "$BACKUP_OUTPUT" | grep -oE '[0-9]{8}-[0-9]{6}-[a-f0-9]{4}' | head -1 || true)
if [[ -z "$BACKUP_ID" ]]; then
	log_error "Could not extract backup ID from output"
	exit 1
fi
log_success "Backup created: $BACKUP_ID"

# =============================================================================
# Step 3: Verify backup appears in list
# =============================================================================
log_step "Step 3: Verifying backup appears in list..."

set +e
LIST_OUTPUT=$("$CLI_BIN" backup list "$TEST_ENV" redis --json 2>&1)
LIST_EXIT=$?
set -e

if [[ $LIST_EXIT -ne 0 ]]; then
	log_error "Backup list failed (exit $LIST_EXIT)"
	exit 1
fi

FOUND_ID=$(echo "$LIST_OUTPUT" | sed -n '/^\[/,$p' | jq -r --arg id "$BACKUP_ID" '.[] | select(.id == $id) | .id' 2>/dev/null || true)
if [[ "$FOUND_ID" != "$BACKUP_ID" ]]; then
	log_error "Backup $BACKUP_ID not found in list"
	echo "$LIST_OUTPUT"
	exit 1
fi
log_success "Backup $BACKUP_ID found in list"

# =============================================================================
# Step 4: Corrupt data
# =============================================================================
log_step "Step 4: Corrupting Redis data..."

redis_exec SET dockflow_e2e_key "CORRUPTED" >/dev/null
redis_exec SET dockflow_e2e_extra "should_not_exist_after_restore" >/dev/null

CORRUPTED=$(redis_exec GET dockflow_e2e_key 2>/dev/null)
log_success "Data corrupted: dockflow_e2e_key = $CORRUPTED"

# =============================================================================
# Step 5: Restore from backup
# =============================================================================
log_step "Step 5: Restoring from backup $BACKUP_ID..."

set +e
RESTORE_OUTPUT=$("$CLI_BIN" backup restore "$TEST_ENV" redis --from "$BACKUP_ID" --yes 2>&1)
RESTORE_EXIT=$?
set -e

echo "$RESTORE_OUTPUT"

if [[ $RESTORE_EXIT -ne 0 ]]; then
	log_error "Restore failed (exit $RESTORE_EXIT)"
	exit 1
fi
log_success "Restore command completed"

# =============================================================================
# Step 6: Verify data integrity
# =============================================================================
log_step "Step 6: Verifying data integrity after restore..."

log_info "Waiting for Redis to restart..."
if ! wait_for_redis; then
	exit 1
fi
log_success "Redis is back up"

RESTORED_VALUE=$(redis_exec GET dockflow_e2e_key 2>/dev/null)
if [[ "$RESTORED_VALUE" != "$STORED" ]]; then
	log_error "Data mismatch after restore: expected '$STORED', got '$RESTORED_VALUE'"
	exit 1
fi
log_success "Key dockflow_e2e_key restored correctly: $RESTORED_VALUE"

EXTRA=$(redis_exec EXISTS dockflow_e2e_extra 2>/dev/null)
if [[ "$EXTRA" != "0" ]]; then
	log_error "Extra key 'dockflow_e2e_extra' still exists after restore (expected gone)"
	exit 1
fi
log_success "Extra key correctly absent after restore"

cd "$SCRIPT_DIR"

echo ""
echo -e "${GREEN}=========================================="
echo "   BACKUP TEST PASSED"
echo "==========================================${NC}"
echo ""
