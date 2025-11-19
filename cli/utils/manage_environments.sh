#!/bin/bash

# ============================================
# ENVIRONMENT MANAGEMENT UTILITIES
# ============================================
# This script provides functions to manage
# deployment environments (.env files)
# ============================================

# List all environments
list_environments() {
    local env_dir="$CLI_PROJECT_DIR/.deployment/env"
    
    if [ ! -d "$env_dir" ]; then
        return 1
    fi
    
    # Find all main .env.* files (exclude host-specific)
    find "$env_dir" -maxdepth 1 -name ".env.*" -type f 2>/dev/null | while read -r env_file; do
        local filename
        filename=$(basename "$env_file")
        local env_name="${filename#.env.}"
        
        # Only list main env files (not host-specific)
        if [[ "$env_name" != *.* ]]; then
            echo "$env_name"
        fi
    done | sort
}

# Get environment file path
get_env_file_path() {
    local env_name="$1"
    echo "$CLI_PROJECT_DIR/.deployment/env/.env.${env_name}"
}

# Check if environment exists
environment_exists() {
    local env_name="$1"
    local env_file
    env_file=$(get_env_file_path "$env_name")
    
    if [ -f "$env_file" ]; then
        return 0
    else
        return 1
    fi
}

# Add new environment function
add_environment() {
    print_heading "ADD NEW ENVIRONMENT"
    
    echo -e "${CYAN}This will create a new deployment environment configuration.${NC}"
    echo ""
    
    # Ask for environment name with validation
    prompt_env_name "Environment name" ENV_NAME
    
    # Create env file path
    local env_file
    env_file=$(get_env_file_path "$ENV_NAME")
    
    # Check if environment already exists
    if environment_exists "$ENV_NAME"; then
        print_warning "Environment '$ENV_NAME' already exists"
        echo ""
        if ! confirm_action "Do you want to overwrite it?" "n"; then
            print_warning "Cancelled"
            return 1
        fi
        echo ""
    fi
    
    # Ask for HOST with validation
    echo -e "${CYAN}Enter the remote server address:${NC}"
    echo "  • Can be an IP address (e.g., 192.168.1.10)"
    echo "  • Or a hostname (e.g., server.example.com)"
    echo ""
    prompt_host "Remote server IP or hostname" HOST_VALUE
    
    # Ask for USER with validation
    echo ""
    prompt_username "User name" USER_VALUE "dockflow"
    
    # Create the environment file
    mkdir -p "$CLI_PROJECT_DIR/.deployment/env"
    
        # Write the .env file with basic structure
    cat > "$env_file" << EOF
# Server connection
DOCKFLOW_HOST=${DOCKFLOW_HOST_VALUE}
DOCKFLOW_PORT=22
EOF
    
    echo ""
    print_success "Environment file created: $env_file"
    echo ""
    echo -e "${CYAN}Configuration:${NC}"
    echo "  DOCKFLOW_HOST=${DOCKFLOW_HOST_VALUE}"
    echo "  DOCKFLOW_PORT=22"
    echo ""
    print_info "💡 You can add more environment variables by editing the file"
    echo ""
}

# Edit existing environment
edit_environment() {
    print_heading "EDIT ENVIRONMENT"
    
    # List available environments
    local envs=($(list_environments))
    
    if [ ${#envs[@]} -eq 0 ]; then
        print_warning "No environments found"
        echo ""
        print_info "Create a new environment first"
        return 1
    fi
    
    echo -e "${CYAN}Available environments:${NC}"
    for env in "${envs[@]}"; do
        echo "  • $env"
    done
    echo ""
    
    # Ask which environment to edit
    read -rp "Enter environment name to edit: " ENV_NAME
    
    if [ -z "$ENV_NAME" ]; then
        print_warning "Environment name cannot be empty"
        return 1
    fi
    
    # Check if environment exists
    if ! environment_exists "$ENV_NAME"; then
        print_warning "Environment '$ENV_NAME' does not exist"
        return 1
    fi
    
    local env_file
    env_file=$(get_env_file_path "$ENV_NAME")
    
    echo ""
    print_info "Current configuration for '${ENV_NAME}':"
    echo ""
    while IFS= read -r line; do
        if [[ "$line" =~ ^[A-Z_]+= ]]; then
            echo "  $line"
        fi
    done < "$env_file"
    echo ""
    
    # Ask what to edit
    local options=(
        "Edit HOST value"
        "Edit USER value"
        "Add/Edit custom variable"
        "Remove a variable"
        "Cancel"
    )
    
    interactive_menu "What would you like to edit?" "${options[@]}"
    local EDIT_OPTION=$?
    
    case "$EDIT_OPTION" in
        0)
            # Edit HOST
            echo ""
            local current_host
            current_host=$(grep "^HOST=" "$env_file" 2>/dev/null | cut -d'=' -f2-)
            echo -e "${CYAN}Current HOST:${NC} $current_host"
            echo ""
            prompt_host "New HOST value" NEW_HOST_VALUE
            
            # Update file
            sed -i "s|^HOST=.*|HOST=${NEW_HOST_VALUE}|" "$env_file"
            print_success "HOST updated to: $NEW_HOST_VALUE"
            ;;
        1)
            # Edit USER
            echo ""
            local current_user
            current_user=$(grep "^USER=" "$env_file" 2>/dev/null | cut -d'=' -f2-)
            echo -e "${CYAN}Current USER:${NC} $current_user"
            echo ""
            prompt_username "New USER value" NEW_USER_VALUE "dockflow"
            
            # Update file
            sed -i "s|^USER=.*|USER=${NEW_USER_VALUE}|" "$env_file"
            print_success "USER updated to: $NEW_USER_VALUE"
            ;;
        2)
            # Add/Edit custom variable
            echo ""
            read -rp "Variable name (uppercase, e.g., DB_PASSWORD): " VAR_NAME
            
            if [ -z "$VAR_NAME" ]; then
                print_warning "Variable name cannot be empty"
                return 1
            fi
            
            # Convert to uppercase
            VAR_NAME=$(echo "$VAR_NAME" | tr '[:lower:]' '[:upper:]')
            
            read -rp "Variable value: " VAR_VALUE
            
            # Check if variable already exists
            if grep -q "^${VAR_NAME}=" "$env_file" 2>/dev/null; then
                sed -i "s|^${VAR_NAME}=.*|${VAR_NAME}=${VAR_VALUE}|" "$env_file"
                print_success "Variable ${VAR_NAME} updated"
            else
                echo "${VAR_NAME}=${VAR_VALUE}" >> "$env_file"
                print_success "Variable ${VAR_NAME} added"
            fi
            ;;
        3)
            # Remove a variable
            echo ""
            read -rp "Variable name to remove: " VAR_NAME
            
            if [ -z "$VAR_NAME" ]; then
                print_warning "Variable name cannot be empty"
                return 1
            fi
            
            # Convert to uppercase
            VAR_NAME=$(echo "$VAR_NAME" | tr '[:lower:]' '[:upper:]')
            
                        
            # Prevent removing DOCKFLOW_HOST and USER
            if [ "$VAR_NAME" = "DOCKFLOW_HOST" ] || [ "$VAR_NAME" = "USER" ]; then
                print_error "Cannot remove $VAR_NAME (required variable)"
            
            if grep -q "^${VAR_NAME}=" "$env_file" 2>/dev/null; then
                if confirm_action "Are you sure you want to remove ${VAR_NAME}?" "n"; then
                    sed -i "/^${VAR_NAME}=/d" "$env_file"
                    print_success "Variable ${VAR_NAME} removed"
                fi
            else
                print_warning "Variable ${VAR_NAME} not found"
            fi
            ;;
        4)
            print_info "Cancelled"
            return 0
            ;;
    esac
    
    echo ""
    print_success "Environment '${ENV_NAME}' updated successfully"
}

# Delete environment
delete_environment() {
    print_heading "DELETE ENVIRONMENT"
    
    # List available environments
    local envs=($(list_environments))
    
    if [ ${#envs[@]} -eq 0 ]; then
        print_warning "No environments found"
        return 1
    fi
    
    echo -e "${CYAN}Available environments:${NC}"
    for env in "${envs[@]}"; do
        echo "  • $env"
    done
    echo ""
    
    # Ask which environment to delete
    read -rp "Enter environment name to delete: " ENV_NAME
    
    if [ -z "$ENV_NAME" ]; then
        print_warning "Environment name cannot be empty"
        return 1
    fi
    
    # Check if environment exists
    if ! environment_exists "$ENV_NAME"; then
        print_warning "Environment '$ENV_NAME' does not exist"
        return 1
    fi
    
    local env_file
    env_file=$(get_env_file_path "$ENV_NAME")
    
    echo ""
    print_warning "⚠️  This will permanently delete the environment '${ENV_NAME}'"
    echo ""
    print_info "File to be deleted: .deployment/env/.env.${ENV_NAME}"
    echo ""
    
    # Show content before deletion
    echo -e "${CYAN}Current content:${NC}"
    while IFS= read -r line; do
        if [[ "$line" =~ ^[A-Z_]+= ]]; then
            echo "  $line"
        fi
    done < "$env_file"
    echo ""
    
    # Confirm deletion
    if ! confirm_action "Are you sure you want to delete this environment?" "n"; then
        print_info "Cancelled - environment not deleted"
        return 1
    fi
    
    # Delete the file
    rm -f "$env_file"
    
    # Also delete any host-specific files for this environment
    local env_dir="$CLI_PROJECT_DIR/.deployment/env"
    local deleted_hosts=0
    
    if [ -d "$env_dir" ]; then
        for host_file in "$env_dir/.env.${ENV_NAME}."*; do
            if [ -f "$host_file" ]; then
                rm -f "$host_file"
                ((deleted_hosts++))
            fi
        done
    fi
    
    echo ""
    print_success "Environment '${ENV_NAME}' deleted successfully"
    
    if [ $deleted_hosts -gt 0 ]; then
        print_info "Also deleted $deleted_hosts host-specific configuration(s)"
    fi
}

# View environment details
view_environment() {
    print_heading "VIEW ENVIRONMENT"
    
    # List available environments
    local envs=($(list_environments))
    
    if [ ${#envs[@]} -eq 0 ]; then
        print_warning "No environments found"
        return 1
    fi
    
    echo -e "${CYAN}Available environments:${NC}"
    for env in "${envs[@]}"; do
        echo "  • $env"
    done
    echo ""
    
    # Ask which environment to view
    read -rp "Enter environment name to view (or press Enter to view all): " ENV_NAME
    
    if [ -z "$ENV_NAME" ]; then
        # View all environments
        for env in "${envs[@]}"; do
            echo ""
            echo -e "${GREEN}═══════════════════════════════════════${NC}"
            echo -e "${GREEN}Environment: ${env}${NC}"
            echo -e "${GREEN}═══════════════════════════════════════${NC}"
            
            local env_file
            env_file=$(get_env_file_path "$env")
            while IFS= read -r line; do
                if [[ "$line" =~ ^[A-Z_]+= ]]; then
                    local key="${line%%=*}"
                    local value="${line#*=}"
                    echo -e "  ${CYAN}${key}:${NC} ${value}"
                fi
            done < "$env_file"
            
            # Check for host-specific files
            local env_dir="$CLI_PROJECT_DIR/.deployment/env"
            local hosts_found=0
            
            for host_file in "$env_dir/.env.${env}."*; do
                if [ -f "$host_file" ]; then
                    local host_name
                    host_name=$(basename "$host_file" | sed "s/.env.${env}.//")
                    if [ $hosts_found -eq 0 ]; then
                        echo ""
                        echo -e "  ${YELLOW}Multi-host configurations:${NC}"
                        ((hosts_found++))
                    fi
                    echo -e "    • Host: ${host_name}"
                fi
            done
        done
    else
        # View specific environment
        if ! environment_exists "$ENV_NAME"; then
            print_warning "Environment '$ENV_NAME' does not exist"
            return 1
        fi
        
        local env_file
        env_file=$(get_env_file_path "$ENV_NAME")
        
        echo ""
        echo -e "${GREEN}Environment: ${ENV_NAME}${NC}"
        echo -e "${GREEN}File: .deployment/env/.env.${ENV_NAME}${NC}"
        echo ""
        
        while IFS= read -r line; do
            if [[ "$line" =~ ^[A-Z_]+= ]]; then
                local key="${line%%=*}"
                local value="${line#*=}"
                echo -e "  ${CYAN}${key}:${NC} ${value}"
            fi
        done < "$env_file"
    fi
    
    echo ""
}

export -f list_environments
export -f get_env_file_path
export -f environment_exists
export -f add_environment
export -f edit_environment
export -f delete_environment
export -f view_environment
