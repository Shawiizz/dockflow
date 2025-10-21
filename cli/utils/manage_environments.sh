#!/bin/bash

# ============================================
# ENVIRONMENT MANAGEMENT UTILITIES
# ============================================
# This script provides functions to manage
# deployment environments (.env files)
# ============================================

# Add new environment function
add_environment() {
    print_heading "ADD NEW ENVIRONMENT"
    
    # Ask for environment name
    read -rp "Environment name (e.g., production, staging, dev): " ENV_NAME
    
    # Validate environment name
    if [ -z "$ENV_NAME" ]; then
        print_warning "Environment name cannot be empty"
        return 1
    fi
    
    # Create env file path
    local env_file="$CLI_PROJECT_DIR/.deployment/env/.env.${ENV_NAME}"
    
    # Check if environment already exists
    if [ -f "$env_file" ]; then
        print_warning "Environment '$ENV_NAME' already exists at $env_file"
        read -rp "Do you want to overwrite it? (y/n) [default: n]: " OVERWRITE
        if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
            print_warning "Cancelled"
            return 1
        fi
    fi
    
    # Ask for HOST
    read -rp "Remote server IP or hostname: " HOST_VALUE
    
    if [ -z "$HOST_VALUE" ]; then
        print_warning "HOST cannot be empty"
        return 1
    fi
    
    # Ask for ANSIBLE_USER
    read -rp "Ansible user name [default: ansible]: " ANSIBLE_USER_VALUE
    ANSIBLE_USER_VALUE=${ANSIBLE_USER_VALUE:-ansible}
    
    # Create the environment file
    mkdir -p "$CLI_PROJECT_DIR/.deployment/env"
    
    cat > "$env_file" <<EOF
HOST=${HOST_VALUE}
ANSIBLE_USER=${ANSIBLE_USER_VALUE}
EOF
    
    print_success "Environment '${ENV_NAME}' created successfully!"
    echo ""
    echo -e "${CYAN}File created: ${env_file}${NC}"
    echo -e "${CYAN}Content:${NC}"
    echo "  HOST=${HOST_VALUE}"
    echo "  ANSIBLE_USER=${ANSIBLE_USER_VALUE}"
    echo ""
    print_info "You can add more environment variables by editing: .deployment/env/.env.${ENV_NAME}"
}

export -f add_environment
