#!/bin/bash
# =============================================================================
# Robust Deployment Verification for E2E Tests
# Performs comprehensive checks to ensure deployment is truly successful
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Guard: only source if not already loaded
if [[ -z "$RED" ]]; then
	source "$SCRIPT_DIR/common.sh"
fi
if [[ -z "$ASSERTION_FAILURES" ]]; then
	source "$SCRIPT_DIR/common/assertions.sh"
fi

# =============================================================================
# Image Verification
# =============================================================================

# Verify image exists on all specified nodes
# Usage: verify_image_on_nodes "image:tag" "node1 node2 ..."
verify_image_on_nodes() {
	local image="$1"
	shift
	local nodes=("$@")

	log_info "Verifying image '$image' on ${#nodes[@]} node(s)..."

	local all_ok=true
	for node in "${nodes[@]}"; do
		if assert_image_on_node "$image" "$node"; then
			log_success "  ✓ Image found on $node"
		else
			log_error "  ✗ Image MISSING on $node"
			all_ok=false
		fi
	done

	$all_ok
}

# Verify all images for a stack exist on all nodes
# Usage: verify_stack_images_distributed "stack-name" "manager-node" "worker-nodes..."
verify_stack_images_distributed() {
	local stack="$1"
	local manager="$2"
	shift 2
	local workers=("$@")

	log_info "Verifying all stack images are distributed..."

	# Get all images used by the stack
	local images
	images=$(docker exec "$manager" docker stack ps "$stack" \
		--format '{{.Image}}' 2>/dev/null | sort -u)

	if [[ -z "$images" ]]; then
		assertion_fail "No images found for stack '$stack'"
		return 1
	fi

	local all_nodes=("$manager" "${workers[@]}")
	local all_ok=true

	while IFS= read -r image; do
		[[ -z "$image" ]] && continue
		if ! verify_image_on_nodes "$image" "${all_nodes[@]}"; then
			all_ok=false
		fi
	done <<<"$images"

	$all_ok
}

# =============================================================================
# Task/Service Verification
# =============================================================================

# Verify no rejected or failed tasks exist
# Usage: verify_no_task_failures "stack-name"
verify_no_task_failures() {
	local stack="$1"

	log_info "Checking for rejected/failed tasks in '$stack'..."

	if assert_no_rejected_tasks "$stack"; then
		log_success "No rejected/failed tasks found"
		return 0
	fi
	return 1
}

# Verify tasks are properly distributed across nodes
# Usage: verify_task_distribution "stack-name" "service-name" "expected-min-nodes"
verify_task_distribution() {
	local stack="$1"
	local service="$2"
	local min_nodes="$3"

	log_info "Verifying task distribution for '$service'..."

	local nodes_with_tasks
	nodes_with_tasks=$(docker exec dockflow-test-manager docker stack ps "$stack" \
		--filter "name=${service}" \
		--filter "desired-state=running" \
		--format '{{.Node}}' 2>/dev/null | sort -u)

	local node_count
	node_count=$(echo "$nodes_with_tasks" | grep -c . || echo "0")

	echo "  Tasks running on nodes:"
	echo "$nodes_with_tasks" | while read -r node; do
		[[ -n "$node" ]] && echo "    - $node"
	done

	if assert_ge "$node_count" "$min_nodes" "Task distribution"; then
		log_success "Tasks distributed across $node_count node(s)"
		return 0
	fi
	return 1
}

# Verify service stability (no restarts during observation period)
# Usage: verify_service_stability "stack-name" "service-name" "seconds"
verify_service_stability() {
	local stack="$1"
	local service="$2"
	local wait_seconds="${3:-10}"

	log_info "Verifying service stability over ${wait_seconds}s..."

	# Get current running task IDs
	local tasks_before
	tasks_before=$(docker exec dockflow-test-manager docker stack ps "$stack" \
		--filter "name=${service}" \
		--filter "desired-state=running" \
		--format '{{.ID}}' 2>/dev/null | sort)

	# Wait
	sleep "$wait_seconds"

	# Get task IDs again
	local tasks_after
	tasks_after=$(docker exec dockflow-test-manager docker stack ps "$stack" \
		--filter "name=${service}" \
		--filter "desired-state=running" \
		--format '{{.ID}}' 2>/dev/null | sort)

	if [[ "$tasks_before" == "$tasks_after" ]]; then
		log_success "Service stable - no task restarts detected"
		return 0
	fi

	log_error "Tasks changed during stability check:"
	echo "  Before: $(echo "$tasks_before" | tr '\n' ' ')"
	echo "  After:  $(echo "$tasks_after" | tr '\n' ' ')"

	assertion_fail "Service '$service' is unstable - tasks restarted"
	return 1
}

# Verify all desired-state=running tasks are actually running
# Usage: verify_all_tasks_running "stack-name" "service-name"
verify_all_tasks_running() {
	local stack="$1"
	local service="$2"

	log_info "Verifying all tasks are in 'Running' state..."

	if assert_tasks_running "$stack" "$service"; then
		log_success "All tasks are running"
		return 0
	fi

	# Show details
	docker exec dockflow-test-manager docker stack ps "$stack" \
		--filter "name=${service}" \
		--format 'table {{.Name}}\t{{.CurrentState}}\t{{.Error}}' 2>/dev/null
	return 1
}

# =============================================================================
# Comprehensive Deployment Verification
# =============================================================================

# Full deployment verification suite
# Usage: verify_deployment "stack-name" "service-name" "expected-replicas" "manager-node" "worker-nodes..."
#
# Example: verify_deployment "test-app-test" "test-app-test_web" "2/2" "dockflow-test-manager" "dockflow-test-w1"
verify_deployment() {
	local stack="$1"
	local service="$2"
	local expected_replicas="$3"
	local manager="$4"
	shift 4
	local workers=("$@")

	local cluster_size=$((1 + ${#workers[@]}))

	echo ""
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	log_info "DEPLOYMENT VERIFICATION: $stack"
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""

	assertion_reset
	local verification_failed=false

	# 1. Check service replicas
	log_step "1. Checking service replicas..."
	if ! assert_service_replicas "$service" "$expected_replicas"; then
		verification_failed=true
	else
		log_success "Service has $expected_replicas replicas"
	fi

	# 2. Check for rejected/failed tasks
	log_step "2. Checking for task failures..."
	if ! verify_no_task_failures "$stack"; then
		verification_failed=true
	fi

	# 3. Verify all tasks are actually running
	log_step "3. Verifying task states..."
	if ! verify_all_tasks_running "$stack" "$service"; then
		verification_failed=true
	fi

	# 4. Check image distribution (only if workers exist)
	if [[ ${#workers[@]} -gt 0 ]]; then
		log_step "4. Verifying image distribution..."
		if ! verify_stack_images_distributed "$stack" "$manager" "${workers[@]}"; then
			verification_failed=true
		fi
	else
		log_step "4. Skipping image distribution check (no workers)"
	fi

	# 5. Check task distribution (only if expected replicas > 1 and workers exist)
	local desired_replicas
	desired_replicas=$(echo "$expected_replicas" | cut -d'/' -f2)

	if [[ "$desired_replicas" -gt 1 && ${#workers[@]} -gt 0 ]]; then
		log_step "5. Verifying task distribution..."
		# Expect tasks on at least 2 nodes if we have multiple replicas and workers
		local min_nodes=2
		if [[ "$desired_replicas" -lt "$cluster_size" ]]; then
			min_nodes="$desired_replicas"
		fi

		if ! verify_task_distribution "$stack" "$service" "$min_nodes"; then
			verification_failed=true
		fi
	else
		log_step "5. Skipping task distribution check (single replica or no workers)"
	fi

	# 6. Verify stability
	log_step "6. Verifying service stability..."
	if ! verify_service_stability "$stack" "$service" 5; then
		verification_failed=true
	fi

	# Summary
	echo ""
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	if $verification_failed; then
		log_error "DEPLOYMENT VERIFICATION FAILED"
		echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
		echo ""

		# Show full stack status for debugging
		log_info "Full stack status:"
		docker exec dockflow-test-manager docker stack ps "$stack" \
			--format 'table {{.Name}}\t{{.Node}}\t{{.CurrentState}}\t{{.Error}}' 2>/dev/null | head -30
		echo ""

		return 1
	else
		log_success "DEPLOYMENT VERIFICATION PASSED"
		echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
		echo ""
		return 0
	fi
}

# Simplified verification for single-replica deployments (like remote-build)
# Usage: verify_single_replica_deployment "stack-name" "service-name" "manager-node"
verify_single_replica_deployment() {
	local stack="$1"
	local service="$2"
	local manager="$3"

	verify_deployment "$stack" "$service" "1/1" "$manager"
}
