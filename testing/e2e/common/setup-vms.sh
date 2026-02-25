#!/bin/bash
# =============================================================================
# Common VM Setup Functions for E2E Tests
# =============================================================================
# This script provides functions to:
#   - Build the CLI binary
#   - Start and wait for test VMs
#   - Setup machines (Docker installation)
#   - Initialize Swarm cluster
#
# Usage: source this file and call setup_e2e_environment
# =============================================================================

# Guard against multiple sourcing (for functions that define readonly vars)
if [[ -z "${_SETUP_VMS_LOADED:-}" ]]; then
	_SETUP_VMS_LOADED=1

	# Ensure common.sh is loaded
	if [[ -z "${_COMMON_SH_LOADED:-}" ]]; then
		SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
		source "$SCRIPT_DIR/common.sh"
	fi

	DOCKFLOW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
	CLI_DIR="$DOCKFLOW_ROOT/cli-ts"
	E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

	# =============================================================================
	# Build CLI
	# =============================================================================
	build_cli() {
		local cli_binary
		cli_binary=$(get_cli_binary)
		CLI_BIN_PATH="$CLI_DIR/dist/$cli_binary"

		log_step "Building CLI binary..."

		if ! command -v bun &>/dev/null; then
			log_error "Bun is required"
			return 1
		fi

		cd "$CLI_DIR"
		bun install --frozen-lockfile
		bun run build "$(echo "$cli_binary" | sed 's/dockflow-//')"
		cd "$E2E_DIR"

		if [[ ! -f "$CLI_BIN_PATH" ]]; then
			log_error "CLI binary not found at $CLI_BIN_PATH"
			return 1
		fi

		log_success "CLI built: $cli_binary"
		export CLI_BIN_PATH
	}

	# =============================================================================
	# Start VMs
	# =============================================================================
	start_vms() {
		log_step "Starting test VMs..."

		cd "$E2E_DIR/docker"
		docker compose --env-file "$E2E_DIR/.env" up -d --build

		# Wait for both containers to be healthy
		local max_wait=90
		log_info "Waiting for containers to be healthy..."

		for ((i = 1; i <= max_wait; i++)); do
			local healthy_count
			healthy_count=$(docker compose --env-file "$E2E_DIR/.env" ps 2>/dev/null | grep -E '\(healthy\)' | wc -l)
			healthy_count=$((healthy_count + 0))

			if [[ "$healthy_count" -ge 2 ]]; then
				log_success "Both VMs are healthy"
				cd "$E2E_DIR"
				return 0
			fi

			if [[ $i -eq $max_wait ]]; then
				log_error "VMs did not become healthy in ${max_wait}s"
				docker compose --env-file "$E2E_DIR/.env" ps
				cd "$E2E_DIR"
				return 1
			fi
			sleep 1
		done

		cd "$E2E_DIR"
	}

	# =============================================================================
	# Setup Machines (Docker installation)
	# =============================================================================
	setup_machines() {
		log_step "Setting up machines..."

		local temp_output
		temp_output=$(mktemp)

		set +e
		bash "$E2E_DIR/cli/run-tests.sh" 2>&1 | tee "$temp_output"
		local cli_exit_code=${PIPESTATUS[0]}
		set -e

		if [[ $cli_exit_code -ne 0 ]]; then
			log_error "CLI tests failed"
			rm -f "$temp_output"
			return 1
		fi
		log_success "Machines setup complete"

		# Extract connection strings
		MANAGER_CONNECTION=$(grep "^::MANAGER_CONNECTION::" "$temp_output" | tail -n 1 | sed 's/^::MANAGER_CONNECTION:://')
		WORKER_1_CONNECTION=$(grep "^::WORKER_1_CONNECTION::" "$temp_output" | tail -n 1 | sed 's/^::WORKER_1_CONNECTION:://')

		rm -f "$temp_output"

		if [[ -z "$MANAGER_CONNECTION" || -z "$WORKER_1_CONNECTION" ]]; then
			log_error "Could not capture connection strings"
			echo "Manager: ${MANAGER_CONNECTION:-MISSING}"
			echo "Worker: ${WORKER_1_CONNECTION:-MISSING}"
			return 1
		fi
		log_success "Connection strings captured"

		# Export for use by callers
		export MANAGER_CONNECTION
		export WORKER_1_CONNECTION
	}

	# =============================================================================
	# Setup Swarm Cluster
	# =============================================================================
	setup_swarm() {
		local test_app_dir="$1"
		local test_env="$2"
		local cli_bin="$3"

		log_step "Setting up Swarm cluster..."

		cd "$test_app_dir"

		# Connection strings for Swarm setup (localhost with mapped ports - runs on host)
		cat >.env.dockflow <<EOF
TEST_MAIN_SERVER_CONNECTION=$MANAGER_CONNECTION
TEST_WORKER_1_CONNECTION=$WORKER_1_CONNECTION
EOF

		set +e
		DOCKFLOW_DEV_PATH="$DOCKFLOW_ROOT" \
			"$cli_bin" setup swarm "$test_env"
		local swarm_exit_code=$?
		set -e

		if [[ $swarm_exit_code -ne 0 ]]; then
			log_error "Swarm setup failed with exit code $swarm_exit_code"
			rm -f .env.dockflow
			return 1
		fi
		log_success "Swarm cluster initialized"

		# Verify swarm nodes
		local node_count
		node_count=$(docker exec dockflow-test-manager docker node ls --format '{{.ID}}' 2>/dev/null | wc -l)
		if [[ "$node_count" -ge 2 ]]; then
			log_success "Swarm has $node_count nodes"
			docker exec dockflow-test-manager docker node ls
		else
			log_error "Expected 2 nodes, got $node_count"
			return 1
		fi

		cd "$E2E_DIR"
	}

	# =============================================================================
	# Full Setup (Build + VMs + Machines + Swarm)
	# =============================================================================
	# Sets CLI_BIN_PATH global variable
	setup_e2e_environment() {
		local test_app_dir="$1"
		local test_env="$2"

		# Check if VMs are already running and Swarm is ready
		if check_vms_running 2>/dev/null && check_swarm_ready 2>/dev/null; then
			log_success "VMs already running and Swarm ready, skipping setup"
			CLI_BIN_PATH="$CLI_DIR/dist/$(get_cli_binary)"

			# If CLI doesn't exist, build it
			if [[ ! -f "$CLI_BIN_PATH" ]]; then
				build_cli || return 1
			fi

			export CLI_BIN_PATH
			return 0
		fi

		# Full setup needed
		build_cli || return 1
		start_vms || return 1
		setup_machines || return 1
		setup_swarm "$test_app_dir" "$test_env" "$CLI_BIN_PATH" || return 1

		export CLI_BIN_PATH
	}

	# =============================================================================
	# Update connection strings for Docker network (container to container)
	# =============================================================================
	get_docker_connection_strings() {
		local test_app_dir="$1"

		# Read from test-app/.env.dockflow if this is a secondary test
		local env_file="$test_app_dir/.env.dockflow"
		if [[ ! -f "$env_file" ]]; then
			env_file="$E2E_DIR/test-app/.env.dockflow"
		fi

		if [[ -f "$env_file" ]]; then
			source "$env_file"
			MANAGER_CONNECTION="$TEST_MAIN_SERVER_CONNECTION"
			WORKER_1_CONNECTION="$TEST_WORKER_1_CONNECTION"
		fi

		if [[ -z "$MANAGER_CONNECTION" || -z "$WORKER_1_CONNECTION" ]]; then
			log_error "Connection strings not available"
			return 1
		fi

		MANAGER_CONNECTION_DOCKER=$(transform_connection_for_docker "$MANAGER_CONNECTION" "dockflow-test-mgr")
		WORKER_1_CONNECTION_DOCKER=$(transform_connection_for_docker "$WORKER_1_CONNECTION" "dockflow-test-w1")

		export MANAGER_CONNECTION_DOCKER
		export WORKER_1_CONNECTION_DOCKER
	}

fi # End of guard
