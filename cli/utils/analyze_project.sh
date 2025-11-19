#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# ============================================
# PROJECT ANALYSIS UTILITIES
# ============================================
# This script provides functions to analyze
# the project structure and detect existing
# deployment configurations
# ============================================

# Check if .deployment directory exists
check_deployment_dir() {
    if [ -d "$CLI_PROJECT_DIR/.deployment" ]; then
        return 0
    else
        return 1
    fi
}

# Detect environments from .deployment/env/
detect_environments() {
    local env_dir="$CLI_PROJECT_DIR/.deployment/env"
    
    if [ ! -d "$env_dir" ]; then
        echo ""
        return
    fi
    
    # Find all .env.* files
    find "$env_dir" -maxdepth 1 -name ".env.*" -type f 2>/dev/null | while read -r env_file; do
        local filename
        filename=$(basename "$env_file")
        # Extract environment name (e.g., .env.production -> production)
        local env_name="${filename#.env.}"
        
        # Check if it's a multi-host file (e.g., .env.production.host_a)
        if [[ "$env_name" == *.* ]]; then
            # It's a host-specific file, extract base env and host
            local base_env="${env_name%%.*}"
            local host_name="${env_name#*.}"
            echo "${base_env}|${host_name}|${env_file}"
        else
            # It's a main environment file
            echo "${env_name}|main|${env_file}"
        fi
    done | sort -u
}

# Parse environment file and extract variables
parse_env_file() {
    local env_file="$1"
    
    if [ ! -f "$env_file" ]; then
        return
    fi
    
    # Extract key variables
    local host
    host=$(grep "^HOST=" "$env_file" 2>/dev/null | cut -d'=' -f2-)
    local user
    user=$(grep "^USER=" "$env_file" 2>/dev/null | cut -d'=' -f2-)
    local var_count
    var_count=$(grep -c "^[A-Z_]\+\=" "$env_file" 2>/dev/null || echo "0")
    
    echo "DOCKFLOW_HOST:${host}|USER:${user}|VAR_COUNT:${var_count}"
}

# Detect CI/CD platform
detect_cicd_platform() {
    if [ -d "$CLI_PROJECT_DIR/.github/workflows" ]; then
        local workflow_files
        workflow_files=$(find "$CLI_PROJECT_DIR/.github/workflows" -name "*.yml" -o -name "*.yaml" 2>/dev/null | wc -l)
        if [ "$workflow_files" -gt 0 ]; then
            echo "github"
            return
        fi
    fi
    
    if [ -f "$CLI_PROJECT_DIR/.gitlab-ci.yml" ]; then
        echo "gitlab"
        return
    fi
    
    echo "none"
}

# Parse docker-compose.yml and extract services
parse_docker_compose() {
    local compose_file="$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml"
    
    if [ ! -f "$compose_file" ]; then
        echo ""
        return
    fi
    
    # Check if yq is available
    if command -v yq &> /dev/null; then
        # Use yq for proper YAML parsing
        yq eval '.services | keys | .[]' "$compose_file" 2>/dev/null
    else
        # Fallback: Simple grep-based parsing (less reliable but works for basic cases)
        grep -E "^  [a-z0-9_-]+:" "$compose_file" | sed 's/://g' | sed 's/^  //g' | grep -v "^#"
    fi
}

# Get service details from docker-compose.yml
get_service_details() {
    local service_name="$1"
    local compose_file="$CLI_PROJECT_DIR/.deployment/docker/docker-compose.yml"
    
    if [ ! -f "$compose_file" ]; then
        return
    fi
    
    if command -v yq &> /dev/null; then
        local image
        image=$(yq eval ".services.${service_name}.image" "$compose_file" 2>/dev/null)
        local dockerfile
        dockerfile=$(yq eval ".services.${service_name}.build.dockerfile" "$compose_file" 2>/dev/null)
        local ports
        ports=$(yq eval ".services.${service_name}.ports[]" "$compose_file" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
        
        echo "IMAGE:${image}|DOCKERFILE:${dockerfile}|PORTS:${ports}"
    else
        # Fallback: basic grep parsing
        local image
        image=$(grep -A 20 "^  ${service_name}:" "$compose_file" | grep "image:" | head -n1 | awk '{print $2}')
        echo "IMAGE:${image}|DOCKERFILE:unknown|PORTS:unknown"
    fi
}

# Parse config.yml options
parse_config_yml() {
    local config_file="$CLI_PROJECT_DIR/.deployment/config.yml"
    
    if [ ! -f "$config_file" ]; then
        echo "ENVIRONMENTIZE:true|REMOTE_BUILD:false|DEBUG_LOGS:false"
        return
    fi
    
    if command -v yq &> /dev/null; then
        local environmentize
        environmentize=$(yq eval '.options.environmentize // true' "$config_file" 2>/dev/null)
        local remote_build
        remote_build=$(yq eval '.options.remote_build // false' "$config_file" 2>/dev/null)
        local debug_logs
        debug_logs=$(yq eval '.options.enable_debug_logs // false' "$config_file" 2>/dev/null)
        
        echo "ENVIRONMENTIZE:${environmentize}|REMOTE_BUILD:${remote_build}|DEBUG_LOGS:${debug_logs}"
    else
        # Fallback
        echo "ENVIRONMENTIZE:unknown|REMOTE_BUILD:unknown|DEBUG_LOGS:unknown"
    fi
}

# Display project analysis
display_project_analysis() {
    print_heading "PROJECT ANALYSIS"
    
    if ! check_deployment_dir; then
        echo -e "${YELLOW}⚠  No .deployment directory found${NC}"
        echo ""
        echo "This appears to be a new project. The CLI will help you set it up."
        echo ""
        return 1
    fi
    
    echo -e "${GREEN}✓ Deployment directory detected${NC}"
    echo ""
    
    # Detect environments
    echo -e "${CYAN}ENVIRONMENTS:${NC}"
    local envs
    envs=$(detect_environments)
    
    if [ -z "$envs" ]; then
        echo -e "  ${YELLOW}⚠ No environments found${NC}"
    else
        local current_env=""
        while IFS='|' read -r env_name host_name env_file; do
            if [ "$host_name" = "main" ]; then
                current_env="$env_name"
                echo -e "  ${GREEN}• ${env_name}${NC} (.env.${env_name})"
                
                # Parse and display env details
                local env_info
                env_info=$(parse_env_file "$env_file")
                IFS='|' read -ra INFO_PARTS <<< "$env_info"
                for part in "${INFO_PARTS[@]}"; do
                    local key="${part%%:*}"
                    local value="${part#*:}"
                    if [ ! -z "$value" ] && [ "$value" != "null" ]; then
                        echo -e "    ├─ ${key}: ${value}"
                    fi
                done
            else
                echo -e "    ${BLUE}└─ Host: ${host_name}${NC} (.env.${env_name}.${host_name})"
            fi
        done <<< "$envs"
    fi
    echo ""
    
    # Detect Docker services
    echo -e "${CYAN}DOCKER SERVICES:${NC}"
    local services
    services=$(parse_docker_compose)
    
    if [ -z "$services" ]; then
        echo -e "  ${YELLOW}⚠ No services found in docker-compose.yml${NC}"
    else
        while IFS= read -r service; do
            [ -z "$service" ] && continue
            echo -e "  ${GREEN}• ${service}${NC}"
        done <<< "$services"
    fi
    echo ""
    
    # Configuration
    echo -e "${CYAN}CONFIGURATION:${NC}"
    local config
    config=$(parse_config_yml)
    IFS='|' read -ra CONFIG_PARTS <<< "$config"
    for part in "${CONFIG_PARTS[@]}"; do
        local key="${part%%:*}"
        local value="${part#*:}"
        local display_key
        display_key=$(echo "$key" | tr '_' ' ' | awk '{for(i=1;i<=NF;i++) $i=tolower($i); print}')
        
        if [ "$value" = "true" ]; then
            echo -e "  ${GREEN}✓${NC} ${display_key}: enabled"
        elif [ "$value" = "false" ]; then
            echo -e "  ${RED}✗${NC} ${display_key}: disabled"
        else
            echo -e "  ${YELLOW}?${NC} ${display_key}: ${value}"
        fi
    done
    echo ""
    
    # CI/CD Platform
    echo -e "${CYAN}CI/CD PLATFORM:${NC}"
    local cicd
    cicd=$(detect_cicd_platform)
    case "$cicd" in
        github)
            echo -e "  ${GREEN}✓ GitHub Actions${NC}"
            ;;
        gitlab)
            echo -e "  ${GREEN}✓ GitLab CI${NC}"
            ;;
        none)
            echo -e "  ${YELLOW}⚠ No CI/CD configuration detected${NC}"
            ;;
    esac
    echo ""
    
    return 0
}

# Interactive menu after analysis
show_project_menu() {
    while true; do
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        
        local options=(
            "Add new environment"
            "Edit existing environment"
            "Delete environment"
            "View environment details"
            "Back to main menu"
        )
        
        interactive_menu "What would you like to do?" "${options[@]}"
        PROJECT_MENU_OPTION=$?
        
        case "$PROJECT_MENU_OPTION" in
            0)
                echo ""
                add_environment
                echo ""
                read -rp "Press Enter to continue..."
                echo ""
                ;;
            1)
                echo ""
                edit_environment
                echo ""
                read -rp "Press Enter to continue..."
                echo ""
                ;;
            2)
                echo ""
                delete_environment
                echo ""
                read -rp "Press Enter to continue..."
                echo ""
                ;;
            3)
                echo ""
                view_environment
                echo ""
                read -rp "Press Enter to continue..."
                echo ""
                ;;
            4)
                echo ""
                return 0
                ;;
            *)
                print_warning "Invalid option"
                echo ""
                ;;
        esac
    done
}

export -f check_deployment_dir
export -f detect_environments
export -f parse_env_file
export -f detect_cicd_platform
export -f parse_docker_compose
export -f get_service_details
export -f parse_config_yml
export -f display_project_analysis
export -f show_project_menu
