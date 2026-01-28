#!/bin/bash
# =============================================================================
# Assertion Functions for E2E Tests
# Provides robust test assertions with clear error messages
# =============================================================================

# Guard: only source common.sh if not already loaded
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "$RED" ]]; then
    source "$SCRIPT_DIR/common.sh"
fi

# Track assertion failures
ASSERTION_FAILURES=0

# =============================================================================
# Core Assertion Functions
# =============================================================================

# Fail with message and increment failure counter
# Usage: assertion_fail "message"
assertion_fail() {
    local message="$1"
    log_error "ASSERTION FAILED: $message"
    ((ASSERTION_FAILURES++))
    return 1
}

# Assert two values are equal
# Usage: assert_equals "actual" "expected" "description"
assert_equals() {
    local actual="$1"
    local expected="$2"
    local description="${3:-Values should be equal}"
    
    if [[ "$actual" == "$expected" ]]; then
        return 0
    fi
    assertion_fail "$description: expected '$expected', got '$actual'"
}

# Assert value is greater than or equal
# Usage: assert_ge "actual" "minimum" "description"
assert_ge() {
    local actual="$1"
    local minimum="$2"
    local description="${3:-Value should be >= minimum}"
    
    if [[ "$actual" -ge "$minimum" ]]; then
        return 0
    fi
    assertion_fail "$description: expected >= $minimum, got $actual"
}

# Assert value is greater than
# Usage: assert_gt "actual" "minimum" "description"
assert_gt() {
    local actual="$1"
    local minimum="$2"
    local description="${3:-Value should be > minimum}"
    
    if [[ "$actual" -gt "$minimum" ]]; then
        return 0
    fi
    assertion_fail "$description: expected > $minimum, got $actual"
}

# Assert string contains substring
# Usage: assert_contains "haystack" "needle" "description"
assert_contains() {
    local haystack="$1"
    local needle="$2"
    local description="${3:-String should contain substring}"
    
    if [[ "$haystack" == *"$needle"* ]]; then
        return 0
    fi
    assertion_fail "$description: '$haystack' does not contain '$needle'"
}

# Assert string does NOT contain substring
# Usage: assert_not_contains "haystack" "needle" "description"
assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local description="${3:-String should not contain substring}"
    
    if [[ "$haystack" != *"$needle"* ]]; then
        return 0
    fi
    assertion_fail "$description: '$haystack' should not contain '$needle'"
}

# Assert command exit code
# Usage: assert_exit_code "$?" "0" "description"
assert_exit_code() {
    local actual="$1"
    local expected="$2"
    local description="${3:-Command should exit with expected code}"
    
    if [[ "$actual" -eq "$expected" ]]; then
        return 0
    fi
    assertion_fail "$description: exit code $actual, expected $expected"
}

# Assert value is zero
# Usage: assert_zero "value" "description"
assert_zero() {
    local value="$1"
    local description="${2:-Value should be zero}"
    
    if [[ "$value" -eq 0 ]]; then
        return 0
    fi
    assertion_fail "$description: expected 0, got $value"
}

# Assert value is not empty
# Usage: assert_not_empty "value" "description"
assert_not_empty() {
    local value="$1"
    local description="${2:-Value should not be empty}"
    
    if [[ -n "$value" ]]; then
        return 0
    fi
    assertion_fail "$description: value is empty"
}

# =============================================================================
# Swarm-Specific Assertions
# =============================================================================

# Assert service is healthy with expected replicas
# Usage: assert_service_replicas "service-name" "2/2"
assert_service_replicas() {
    local service="$1"
    local expected="$2"
    
    local replicas
    replicas=$(docker exec dockflow-test-manager docker service ls \
        --filter "name=$service" \
        --format '{{.Replicas}}' 2>/dev/null || echo "0/0")
    
    if [[ "$replicas" == "$expected" ]]; then
        return 0
    fi
    assertion_fail "Service '$service' replicas: expected $expected, got $replicas"
}

# Assert no rejected or failed tasks in stack
# Usage: assert_no_rejected_tasks "stack-name"
assert_no_rejected_tasks() {
    local stack="$1"
    
    local rejected_count
    rejected_count=$(docker exec dockflow-test-manager docker stack ps "$stack" \
        --format '{{.CurrentState}}' 2>/dev/null | grep -ciE "rejected|failed" || true)
    rejected_count=$(echo "$rejected_count" | tr -d '\n\r ' | grep -E '^[0-9]+$' || echo "0")
    
    if [[ "$rejected_count" -eq 0 ]]; then
        return 0
    fi
    
    # Show details of failed tasks
    log_error "Found $rejected_count rejected/failed tasks:"
    docker exec dockflow-test-manager docker stack ps "$stack" \
        --format 'table {{.Name}}\t{{.Node}}\t{{.CurrentState}}\t{{.Error}}' 2>/dev/null | head -20
    
    assertion_fail "Stack '$stack' has $rejected_count rejected/failed tasks"
}

# Assert image exists on specific node
# Usage: assert_image_on_node "image:tag" "node-container-name"
assert_image_on_node() {
    local image="$1"
    local node="$2"
    
    local image_found
    image_found=$(docker exec "$node" docker images -q "$image" 2>/dev/null || echo "")
    
    if [[ -n "$image_found" ]]; then
        return 0
    fi
    assertion_fail "Image '$image' not found on node '$node'"
}

# Assert tasks are distributed across minimum number of nodes
# Usage: assert_task_distribution "stack-name" "service-name" "min-nodes"
assert_task_distribution() {
    local stack="$1"
    local service="$2"
    local min_nodes="$3"
    
    local nodes_with_tasks
    nodes_with_tasks=$(docker exec dockflow-test-manager docker stack ps "$stack" \
        --filter "name=${service}" \
        --filter "desired-state=running" \
        --format '{{.Node}}' 2>/dev/null | sort -u | wc -l)
    
    if [[ "$nodes_with_tasks" -ge "$min_nodes" ]]; then
        return 0
    fi
    assertion_fail "Service '$service' tasks on $nodes_with_tasks nodes, expected >= $min_nodes"
}

# Assert all running tasks are in "Running" state (not "Starting" or other)
# Usage: assert_tasks_running "stack-name" "service-name"
assert_tasks_running() {
    local stack="$1"
    local service="$2"
    
    local non_running
    non_running=$(docker exec dockflow-test-manager docker stack ps "$stack" \
        --filter "name=${service}" \
        --filter "desired-state=running" \
        --format '{{.CurrentState}}' 2>/dev/null | grep -cv "^Running" || true)
    non_running=$(echo "$non_running" | tr -d '\n\r ' | grep -E '^[0-9]+$' || echo "0")
    
    if [[ "$non_running" -eq 0 ]]; then
        return 0
    fi
    assertion_fail "Service '$service' has $non_running tasks not in 'Running' state"
}

# =============================================================================
# Summary Function
# =============================================================================

# Print assertion summary and exit with appropriate code
# Usage: assertion_summary
assertion_summary() {
    echo ""
    if [[ "$ASSERTION_FAILURES" -eq 0 ]]; then
        log_success "All assertions passed"
        return 0
    else
        log_error "$ASSERTION_FAILURES assertion(s) failed"
        return 1
    fi
}

# Reset assertion counter (for running multiple test suites)
# Usage: assertion_reset
assertion_reset() {
    ASSERTION_FAILURES=0
}
