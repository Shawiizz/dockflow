#!/bin/bash
# Global E2E test runner
# Runs all E2E tests for DockFlow

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=========================================="
echo "   DockFlow E2E Test Suite"
echo -e "==========================================${NC}"
echo ""

# Parse arguments
TEST_TYPE="${1:-all}"

run_cli_tests() {
    echo -e "${YELLOW}=========================================="
    echo "   Running CLI E2E Tests"
    echo -e "==========================================${NC}"
    echo ""
    
    cd "$SCRIPT_DIR/cli"
    bash setup.sh
    echo ""
    bash run-tests.sh
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ CLI tests passed${NC}"
        return 0
    else
        echo -e "${RED}✗ CLI tests failed${NC}"
        return 1
    fi
}

run_deployment_tests() {
    echo -e "${YELLOW}=========================================="
    echo "   Running Deployment E2E Tests"
    echo -e "==========================================${NC}"
    echo ""
    
    cd "$SCRIPT_DIR/common"
    bash setup.sh
    echo ""
    bash run-tests.sh
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Deployment tests passed${NC}"
        return 0
    else
        echo -e "${RED}✗ Deployment tests failed${NC}"
        return 1
    fi
}

cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up test environment...${NC}"
    cd "$SCRIPT_DIR"
    bash teardown.sh
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

# Main test execution
case "$TEST_TYPE" in
    cli)
        echo "Running CLI tests only..."
        echo ""
        run_cli_tests
        TEST_RESULT=$?
        cleanup
        exit $TEST_RESULT
        ;;
    deployment)
        echo "Running deployment tests only..."
        echo ""
        run_deployment_tests
        TEST_RESULT=$?
        cleanup
        exit $TEST_RESULT
        ;;
    all)
        echo "Running all E2E tests..."
        echo ""
        
        CLI_RESULT=0
        DEPLOY_RESULT=0
        
        # Run CLI tests
        run_cli_tests || CLI_RESULT=$?
        
        # Cleanup between tests
        cleanup
        echo ""
        
        # Run deployment tests
        run_deployment_tests || DEPLOY_RESULT=$?
        
        # Final cleanup
        cleanup
        
        echo ""
        echo -e "${BLUE}=========================================="
        echo "   Test Summary"
        echo -e "==========================================${NC}"
        
        if [ $CLI_RESULT -eq 0 ]; then
            echo -e "CLI Tests:        ${GREEN}✓ PASSED${NC}"
        else
            echo -e "CLI Tests:        ${RED}✗ FAILED${NC}"
        fi
        
        if [ $DEPLOY_RESULT -eq 0 ]; then
            echo -e "Deployment Tests: ${GREEN}✓ PASSED${NC}"
        else
            echo -e "Deployment Tests: ${RED}✗ FAILED${NC}"
        fi
        
        echo -e "${BLUE}==========================================${NC}"
        
        if [ $CLI_RESULT -eq 0 ] && [ $DEPLOY_RESULT -eq 0 ]; then
            echo -e "${GREEN}✓ All tests passed!${NC}"
            exit 0
        else
            echo -e "${RED}✗ Some tests failed${NC}"
            exit 1
        fi
        ;;
    *)
        echo -e "${RED}Error: Invalid test type '$TEST_TYPE'${NC}"
        echo ""
        echo "Usage: $0 [cli|deployment|all]"
        echo ""
        echo "Options:"
        echo "  cli         Run CLI E2E tests only"
        echo "  deployment  Run deployment E2E tests only"
        echo "  all         Run all E2E tests (default)"
        exit 1
        ;;
esac
