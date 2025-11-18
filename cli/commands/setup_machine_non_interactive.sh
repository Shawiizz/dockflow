#!/bin/bash

# ============================================
# NON-INTERACTIVE MACHINE SETUP
# ============================================
# Setup remote machine without user interaction
# Uses command-line arguments only
# ============================================

setup_machine_non_interactive() {
    echo -e "${GREEN}=========================================================="
    echo "   SETUP REMOTE MACHINE FOR DEPLOYMENT (NON-INTERACTIVE)"
    echo -e "==========================================================${NC}"
    echo ""
    
    # Set variables from arguments
    export SERVER_IP="$ARG_HOST"
    export SSH_PORT="$ARG_PORT"
    export REMOTE_USER="$ARG_REMOTE_USER"
    
    # Determine if we're creating a new user
    local CREATE_USER=false
    if [ -n "$ARG_DEPLOY_USER" ]; then
        CREATE_USER=true
        export DOCKFLOW_USER="$ARG_DEPLOY_USER"
        export DOCKFLOW_PASSWORD="$ARG_DEPLOY_PASSWORD"
    else
        # Use remote user as deploy user
        export DOCKFLOW_USER="$ARG_REMOTE_USER"
    fi
    
    # Setup authentication method for remote connection
    if [ -n "$ARG_REMOTE_PASSWORD" ]; then
        export REMOTE_PASSWORD="$ARG_REMOTE_PASSWORD"
        export AUTH_METHOD="password"
    else
        export SSH_PRIVATE_KEY_PATH="$ARG_REMOTE_KEY"
        export AUTH_METHOD="key"
    fi
    
    # Display configuration
    print_heading "CONFIGURATION SUMMARY"
    echo ""
    echo -e "${CYAN}Remote server:${NC} $SERVER_IP:$SSH_PORT"
    echo -e "${CYAN}Remote user (for connection):${NC} $REMOTE_USER"
    echo -e "${CYAN}Authentication method:${NC} $AUTH_METHOD"
    
    if [ "$CREATE_USER" = true ]; then
        echo -e "${CYAN}Deployment user (to be created):${NC} $DOCKFLOW_USER"
        echo -e "${CYAN}Create new user:${NC} Yes"
    else
        echo -e "${CYAN}Deployment user:${NC} $DOCKFLOW_USER (existing user)"
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
            export ANSIBLE_PUBLIC_KEY=$(cat "$TEMP_KEY_DIR/deploy_key.pub")
            
            print_success "SSH key pair generated"
            echo ""
            echo -e "${CYAN}Public key:${NC}"
            echo "$ANSIBLE_PUBLIC_KEY"
            echo ""
            
            # Save private key
            print_step "Saving private key to ~/.ssh/deploy_key"
            mkdir -p ~/.ssh
            cat "$TEMP_KEY_DIR/deploy_key" > ~/.ssh/deploy_key
            chmod 600 ~/.ssh/deploy_key
            print_success "Private key saved"
            
            rm -rf "$TEMP_KEY_DIR"
        else
            # Use provided deploy key
            print_step "Using provided SSH key: $ARG_DEPLOY_KEY"
            
            # Check if public key exists
            local pub_key_path="${ARG_DEPLOY_KEY}.pub"
            if [ -f "$pub_key_path" ]; then
                export ANSIBLE_PUBLIC_KEY=$(cat "$pub_key_path")
            else
                # Try to generate public key from private key
                print_step "Generating public key from private key..."
                export ANSIBLE_PUBLIC_KEY=$(ssh-keygen -y -f "$ARG_DEPLOY_KEY" 2>/dev/null)
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
            print_success "Private key copied"
        fi
        echo ""
        
        # Create user on remote
        print_heading "CREATING DEPLOYMENT USER ON REMOTE SERVER"
        create_ansible_user_on_remote
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
        elif [ -n "$ARG_REMOTE_KEY" ]; then
            # Use remote key as deploy key
            print_step "Using remote connection key as deploy key"
            mkdir -p ~/.ssh
            cp "$ARG_REMOTE_KEY" ~/.ssh/deploy_key
            chmod 600 ~/.ssh/deploy_key
            export USER_PRIVATE_KEY_PATH="$ARG_REMOTE_KEY"
        else
            echo -e "${RED}Error: No deploy key available${NC}"
            exit 1
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
    
    # Set user password for Ansible (needed for sudo)
    if [ -z "$DOCKFLOW_PASSWORD" ]; then
        # If we're not creating a user and no password was provided,
        # we need to prompt or use remote password
        if [ -n "$ARG_REMOTE_PASSWORD" ]; then
            export DOCKFLOW_PASSWORD="$ARG_REMOTE_PASSWORD"
        else
            # For key-based auth without user creation, we might not have a password
            # This is okay if the user has NOPASSWD sudo configured
            echo -e "${YELLOW}Warning: No password provided for sudo operations${NC}"
            echo -e "${YELLOW}Make sure the user has NOPASSWD sudo configured, or provide --deploy-password${NC}"
            export DOCKFLOW_PASSWORD=""
        fi
    fi
    
    # Run Ansible playbook
    run_ansible_playbook
    
    # Display completion
    display_completion
}

export -f setup_machine_non_interactive
