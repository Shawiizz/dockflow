#!/bin/bash

# ============================================
# NON-INTERACTIVE MACHINE SETUP
# ============================================
# Setup local machine without user interaction
# Uses command-line arguments only
# ============================================

setup_machine_non_interactive() {
    echo -e "${GREEN}=========================================================="
    echo "   SETUP LOCAL MACHINE FOR DEPLOYMENT (NON-INTERACTIVE)"
    echo -e "==========================================================${NC}"
    echo ""
    
    # Set variables from arguments
    export SERVER_IP="127.0.0.1"
    
    # Determine Public Host
    if [ -n "$ARG_HOST" ]; then
        export PUBLIC_HOST="$ARG_HOST"
    else
        # Auto-detect if not provided
        export PUBLIC_HOST=$(detect_public_ip)
    fi
    
    # Determine SSH Port
    if [ -n "$ARG_PORT" ]; then
        export SSH_PORT="$ARG_PORT"
    else
        # Auto-detect if not provided
        export SSH_PORT=$(detect_ssh_port)
    fi
    
    export IS_LOCAL_RUN="true"
    export SKIP_DOCKER_INSTALL="${ARG_SKIP_DOCKER_INSTALL:-false}"
    
    # Determine if we're creating a new user
    local CREATE_USER=false
    if [ -n "$ARG_DEPLOY_USER" ]; then
        CREATE_USER=true
        export DOCKFLOW_USER="$ARG_DEPLOY_USER"
        export DOCKFLOW_PASSWORD="$ARG_DEPLOY_PASSWORD"
    else
        # Use current user as deploy user
        export DOCKFLOW_USER="$(whoami)"
    fi
    
    # Display configuration
    print_heading "CONFIGURATION SUMMARY"
    echo ""
    echo -e "${CYAN}Target:${NC} Local Machine"
    echo -e "${CYAN}Public Host (for connection string):${NC} $PUBLIC_HOST"
    echo -e "${CYAN}SSH Port:${NC} $SSH_PORT"
    
    if [ "$CREATE_USER" = true ]; then
        echo -e "${CYAN}Deployment user (to be created):${NC} $DOCKFLOW_USER"
        echo -e "${CYAN}Create new user:${NC} Yes"
    else
        echo -e "${CYAN}Deployment user:${NC} $DOCKFLOW_USER (current user)"
        echo -e "${CYAN}Create new user:${NC} No"
    fi
    
    if [ "$ARG_INSTALL_PORTAINER" = "y" ]; then
        echo -e "${CYAN}Install Portainer:${NC} Yes"
        echo -e "${CYAN}Portainer port:${NC} $ARG_PORTAINER_PORT"
        if [ -n "$ARG_PORTAINER_DOMAIN" ]; then
            echo -e "${CYAN}Portainer domain:${NC} $ARG_PORTAINER_DOMAIN"
        fi
    else
        echo -e "${CYAN}Install Portainer:${NC} No"
    fi
    echo ""
    
    # Setup deploy user SSH key
    if [ "$CREATE_USER" = true ]; then
        print_heading "DEPLOY USER SSH KEY SETUP"
        
        if [ "$ARG_GENERATE_KEY" = "y" ]; then
            # Generate new SSH key
            print_step "Generating new SSH key for deployment user..."
            TEMP_KEY_DIR=$(mktemp -d)
            ssh-keygen -t ed25519 -f "$TEMP_KEY_DIR/deploy_key" -N "" -C "dockflow"
            ANSIBLE_PUBLIC_KEY=$(cat "$TEMP_KEY_DIR/deploy_key.pub")
            export ANSIBLE_PUBLIC_KEY
            
            print_success "SSH key pair generated"
            echo ""
            echo -e "${CYAN}Public key:${NC}"
            echo "$ANSIBLE_PUBLIC_KEY"
            echo ""
            
            # Save private key
            print_step "Saving private key to ~/.ssh/deploy_key"
            mkdir -p ~/.ssh
            cp "$TEMP_KEY_DIR/deploy_key" ~/.ssh/deploy_key
            chmod 600 ~/.ssh/deploy_key
            
            # Export private key for user creation script
            ANSIBLE_PRIVATE_KEY=$(cat "$TEMP_KEY_DIR/deploy_key")
            export ANSIBLE_PRIVATE_KEY
            
            print_success "Private key saved"
            
            rm -rf "$TEMP_KEY_DIR"
        else
            # Use provided deploy key
            print_step "Using provided SSH key: $ARG_DEPLOY_KEY"
            
            # Check if public key exists
            local pub_key_path="${ARG_DEPLOY_KEY}.pub"
            if [ -f "$pub_key_path" ]; then
                ANSIBLE_PUBLIC_KEY=$(cat "$pub_key_path")
                export ANSIBLE_PUBLIC_KEY
            else
                # Try to generate public key from private key
                print_step "Generating public key from private key..."
                ANSIBLE_PUBLIC_KEY=$(ssh-keygen -y -f "$ARG_DEPLOY_KEY" 2>/dev/null)
                export ANSIBLE_PUBLIC_KEY
                if [ -z "$ANSIBLE_PUBLIC_KEY" ]; then
                    echo -e "${RED}Error: Cannot read public key from $ARG_DEPLOY_KEY${NC}"
                    exit 1
                fi
            fi
            
            # Copy to ~/.ssh/deploy_key
            print_step "Copying private key to ~/.ssh/deploy_key"
            mkdir -p ~/.ssh
            cp "$ARG_DEPLOY_KEY" ~/.ssh/deploy_key
            chmod 600 ~/.ssh/deploy_key
            
            # Export private key for user creation script
            ANSIBLE_PRIVATE_KEY=$(cat "$ARG_DEPLOY_KEY")
            export ANSIBLE_PRIVATE_KEY
            
            print_success "Private key copied"
        fi
        echo ""
        
        # Create user locally
        print_heading "CREATING DEPLOYMENT USER"
        create_ansible_user_locally
        echo ""
    else
        # Not creating a user, but we need a deploy key for Ansible
        print_heading "DEPLOY KEY SETUP"
        
        if [ -n "$ARG_DEPLOY_KEY" ]; then
            print_step "Using provided SSH key: $ARG_DEPLOY_KEY"
            mkdir -p ~/.ssh
            cp "$ARG_DEPLOY_KEY" ~/.ssh/deploy_key
            chmod 600 ~/.ssh/deploy_key
            export USER_PRIVATE_KEY_PATH="$ARG_DEPLOY_KEY"
        else
            echo -e "${YELLOW}No deploy key provided. Assuming existing key or passwordless sudo.${NC}"
        fi
        echo ""
    fi
    
    # Setup Portainer if requested
    if [ "$ARG_INSTALL_PORTAINER" = "y" ]; then
        export PORTAINER_INSTALL=true
        export PORTAINER_PASSWORD="$ARG_PORTAINER_PASSWORD"
        export PORTAINER_HTTP_PORT="$ARG_PORTAINER_PORT"
        export PORTAINER_DOMAIN_NAME="$ARG_PORTAINER_DOMAIN"
    fi
    
    # Run Ansible playbook
    run_ansible_playbook
    
    # Display completion
    display_completion
}

display_completion() {
    print_heading "SETUP COMPLETE"
    
    echo -e "${GREEN}The machine has been successfully configured!${NC}"
    echo ""
    
    # Display connection string
    display_deployment_connection_info "$PUBLIC_HOST" "$SSH_PORT" "$DOCKFLOW_USER" "$DOCKFLOW_PASSWORD"
}

export -f setup_machine_non_interactive
