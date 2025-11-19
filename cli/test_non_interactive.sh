#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# ============================================
# TEST SCRIPT FOR NON-INTERACTIVE MODE
# ============================================
# This script tests argument parsing and validation
# without actually connecting to remote servers
# ============================================

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# Test helper functions
test_case() {
    echo -e "\n${YELLOW}TEST: $1${NC}"
    TEST_COUNT=$((TEST_COUNT + 1))
}

assert_pass() {
    echo -e "${GREEN}✓ PASS${NC}"
    PASS_COUNT=$((PASS_COUNT + 1))
}

assert_fail() {
    echo -e "${RED}✗ FAIL: $1${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

# Setup test environment
setup_test_env() {
    echo "  → Setting environment variables..."
    export CLI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    export CLI_UTILS_DIR="$CLI_ROOT_DIR/utils"
    export CLI_COMMANDS_DIR="$CLI_ROOT_DIR/commands"
    
    echo "  → Sourcing dependencies..."
    echo "     - functions.sh"
    source "$CLI_UTILS_DIR/functions.sh" 2>/dev/null || echo "     Warning: Could not source functions.sh"
    echo "     - validators.sh"
    source "$CLI_UTILS_DIR/validators.sh" 2>/dev/null || echo "     Warning: Could not source validators.sh"
    echo "     - parse_args.sh"
    source "$CLI_UTILS_DIR/parse_args.sh" 2>/dev/null || echo "     Warning: Could not source parse_args.sh"
    
    echo "  → Creating test SSH keys..."
    # Create dummy SSH keys for testing
    mkdir -p /tmp/test_ssh
    # Remove existing keys first
    rm -f /tmp/test_ssh/test_key /tmp/test_ssh/test_key.pub
    # Generate key with -q for quiet and ensure no interaction
    ssh-keygen -q -t ed25519 -f /tmp/test_ssh/test_key -N "" -C "test" <<<y >/dev/null 2>&1 || true
    echo "  → SSH keys created"
}

echo "=========================================="
echo "  NON-INTERACTIVE MODE - ARGUMENT TESTS"
echo "=========================================="

echo "Setting up test environment..."
setup_test_env
echo "✓ Test environment ready"
echo ""

# Test 1: Valid minimal setup with password
test_case "Valid minimal setup with password"
if parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "password123"; then
    if [[ "$ARG_HOST" == "192.168.1.10" ]] && \
       [[ "$ARG_REMOTE_USER" == "root" ]] && \
       [[ "$ARG_REMOTE_PASSWORD" == "password123" ]]; then
        assert_pass
    else
        assert_fail "Variables not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Test 2: Valid setup with SSH key
test_case "Valid setup with SSH key"
if parse_setup_machine_args \
    --host "server.example.com" \
    --remote-user "admin" \
    --remote-key "/tmp/test_ssh/test_key"; then
    if [[ "$ARG_HOST" == "server.example.com" ]] && \
       [[ "$ARG_REMOTE_USER" == "admin" ]] && \
       [[ "$ARG_REMOTE_KEY" == "/tmp/test_ssh/test_key" ]]; then
        assert_pass
    else
        assert_fail "Variables not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Test 3: Valid setup with deploy user creation
test_case "Valid setup with deploy user creation"
if parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --deploy-user "dockflow" \
    --deploy-password "deploypass" \
    --generate-key "y"; then
    if [[ "$ARG_DEPLOY_USER" == "dockflow" ]] && \
       [[ "$ARG_DEPLOY_PASSWORD" == "deploypass" ]] && \
       [[ "$ARG_GENERATE_KEY" == "y" ]]; then
        assert_pass
    else
        assert_fail "Deploy user variables not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Test 4: Valid setup with Portainer
test_case "Valid setup with Portainer installation"
if parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --install-portainer "y" \
    --portainer-password "portainerpass" \
    --portainer-domain "portainer.example.com"; then
    if [[ "$ARG_INSTALL_PORTAINER" == "y" ]] && \
       [[ "$ARG_PORTAINER_PASSWORD" == "portainerpass" ]] && \
       [[ "$ARG_PORTAINER_DOMAIN" == "portainer.example.com" ]]; then
        assert_pass
    else
        assert_fail "Portainer variables not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Test 5: Missing required --host
test_case "Missing required --host (should fail)"
if (parse_setup_machine_args \
    --remote-user "root" \
    --remote-password "pass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 6: Missing required --remote-user
test_case "Missing required --remote-user (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-password "pass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 7: Missing authentication method
test_case "Missing authentication method (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 8: Both password and key provided (should fail)
test_case "Both password and key provided (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --remote-key "/tmp/test_ssh/test_key" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 9: Invalid IP address
test_case "Invalid IP address (should fail)"
if (parse_setup_machine_args \
    --host "999.999.999.999" \
    --remote-user "root" \
    --remote-password "pass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 10: Invalid port number
test_case "Invalid port number (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --port "99999" \
    --remote-user "root" \
    --remote-password "pass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 11: Deploy user without password
test_case "Deploy user without password (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --deploy-user "dockflow" \
    --generate-key "y" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 12: Deploy user without key method
test_case "Deploy user without key method (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --deploy-user "dockflow" \
    --deploy-password "deploypass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 13: Portainer without password
test_case "Portainer installation without password (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --install-portainer "y" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 14: Invalid username format
test_case "Invalid username format (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "INVALID USER" \
    --remote-password "pass" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 15: Invalid domain name
test_case "Invalid domain name for Portainer (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --install-portainer "y" \
    --portainer-password "pass" \
    --portainer-domain "invalid_domain" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 16: Non-existent SSH key file
test_case "Non-existent SSH key file (should fail)"
if (parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-key "/non/existent/key" >/dev/null 2>&1); then
    assert_fail "Should have failed but didn't"
else
    assert_pass
fi

# Test 17: Custom port
test_case "Valid custom SSH port"
if parse_setup_machine_args \
    --host "192.168.1.10" \
    --port "2222" \
    --remote-user "root" \
    --remote-password "pass"; then
    if [[ "$ARG_PORT" == "2222" ]]; then
        assert_pass
    else
        assert_fail "Port not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Test 18: Deploy user with existing key
test_case "Deploy user with existing SSH key"
if parse_setup_machine_args \
    --host "192.168.1.10" \
    --remote-user "root" \
    --remote-password "pass" \
    --deploy-user "dockflow" \
    --deploy-password "deploypass" \
    --deploy-key "/tmp/test_ssh/test_key"; then
    if [[ "$ARG_DEPLOY_KEY" == "/tmp/test_ssh/test_key" ]]; then
        assert_pass
    else
        assert_fail "Deploy key not set correctly"
    fi
else
    assert_fail "Parsing failed"
fi

# Cleanup
rm -rf /tmp/test_ssh

# Summary
echo ""
echo "=========================================="
echo "  TEST RESULTS"
echo "=========================================="
echo -e "Total tests: $TEST_COUNT"
echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "${RED}Failed: $FAIL_COUNT${NC}"
echo "=========================================="

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
