#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# ============================================
# QUICK PROJECT SCAN
# ============================================
# Lightweight scan for project detection
# ============================================

# Quick check if project exists
quick_scan_project() {
    if [ ! -d "$CLI_PROJECT_DIR/.deployment" ]; then
        return 1
    fi
    return 0
}

# Count environments
count_environments() {
    local env_dir="$CLI_PROJECT_DIR/.deployment/env"
    
    if [ ! -d "$env_dir" ]; then
        echo "0"
        return
    fi
    
    # Count unique base environments (exclude host-specific files)
    find "$env_dir" -maxdepth 1 -name ".env.*" -type f 2>/dev/null | while read -r env_file; do
        local filename=$(basename "$env_file")
        local env_name="${filename#.env.}"
        
        # Only count main env files (not host-specific)
        if [[ "$env_name" != *.* ]]; then
            echo "$env_name"
        fi
    done | wc -l | tr -d ' '
}

# Count Docker services
count_docker_services() {
    local compose_file="$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml"
    
    if [ ! -f "$compose_file" ]; then
        echo "0"
        return
    fi
    
    if command -v yq &> /dev/null; then
        yq eval '.services | keys | .[]' "$compose_file" 2>/dev/null | wc -l | tr -d ' '
    else
        grep -E "^  [a-z0-9_-]+:" "$compose_file" 2>/dev/null | grep -v "^#" | wc -l | tr -d ' '
    fi
}

# Display quick scan summary
display_quick_scan() {
    if ! quick_scan_project; then
        return 1
    fi
    
    local env_count=$(count_environments)
    local service_count=$(count_docker_services)
    
    echo ""
    echo -e "${GREEN}✓ Project detected${NC}"
    echo -e "  ${CYAN}Environments:${NC} ${env_count}"
    echo -e "  ${CYAN}Docker services:${NC} ${service_count}"
    echo ""
    
    return 0
}

export -f quick_scan_project
export -f count_environments
export -f count_docker_services
export -f display_quick_scan
