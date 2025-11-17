#!/bin/bash

setup_machine_interactive() {
    echo -e "${GREEN}=========================================================="
    echo "   MACHINE SETUP"
    echo -e "==========================================================${NC}"
    
    print_heading "SETUP TYPE"
    echo ""
    echo -e "${CYAN}Choose the type of setup:${NC}"
    echo ""
    
    local options=(
        "Setup a remote machine (via SSH)"
        "Setup this local machine (localhost)"
    )
    
    interactive_menu "Select setup type:" "${options[@]}"
    SETUP_TYPE=$?
    
    if [ "$SETUP_TYPE" = "0" ]; then
        # Remote setup - normal flow
        setup_machine
    elif [ "$SETUP_TYPE" = "1" ]; then
        # Local setup - pre-fill variables and use normal flow
        echo ""
        echo -e "${CYAN}Setting up the current machine for Docker deployment...${NC}"
        echo ""
        
        # Get current user
        CURRENT_USER=$(whoami)
        
        echo -e "${CYAN}Detected configuration:${NC}"
        echo -e "${BLUE}  • Server:${NC} 127.0.0.1 (local machine)"
        echo -e "${BLUE}  • Current user:${NC} $CURRENT_USER"
        echo ""
        
        # Pre-fill the server variables
        export SERVER_IP="127.0.0.1"
        export SSH_PORT="22"
        export REMOTE_USER="$CURRENT_USER"
        
        # Ask for sudo password for the current user
        read -srp "Enter your sudo password: " BECOME_PASSWORD
        echo ""
        echo ""
        
        export REMOTE_PASSWORD="$BECOME_PASSWORD"
        export AUTH_METHOD="password"
        
        # Ask if user wants to create a deployment user
        echo ""
        if confirm_action "Do you want to create a dedicated deployment user (dockflow)?" "y"; then
            SETUP_USER="y"
        else
            SETUP_USER="n"
        fi
        
        if [ "$SETUP_USER" = "y" ] || [ "$SETUP_USER" = "Y" ]; then
            # User wants to create a deployment user
            setup_ansible_user
            generate_ansible_ssh_key
            USER_NEEDS_SETUP=true
            
            # For local, we'll create the user with Ansible
            # The user will be created during the playbook run
        else
            # Use current user for deployment
            print_heading "USING CURRENT USER FOR DEPLOYMENT"
            
            export USER="$CURRENT_USER"
            export USER_PASSWORD="$BECOME_PASSWORD"
            
            # Generate SSH key if needed for current user
            SHOULD_GENERATE=false
            USER_SSH_KEY="$HOME/.ssh/dockflow_key"
            
            if [ ! -f "$USER_SSH_KEY" ]; then
                print_step "Generating SSH key for local deployment (user: $CURRENT_USER)..."
                SHOULD_GENERATE=true
            else
                print_step "SSH key already exists for user $CURRENT_USER at $USER_SSH_KEY"
                echo ""
                if confirm_action "Do you want to regenerate the SSH key?" "n"; then
                    print_warning "Regenerating SSH key..."
                    SHOULD_GENERATE=true
                else
                    print_success "Using existing SSH key"
                fi
            fi
            
            if [ "$SHOULD_GENERATE" = true ]; then
                ssh-keygen -t ed25519 -f "$USER_SSH_KEY" -N "" -C "dockflow-local-$(hostname)"
                cat "${USER_SSH_KEY}.pub" >> ~/.ssh/authorized_keys
                chmod 600 ~/.ssh/authorized_keys
                print_success "SSH key generated successfully"
            fi
            
            # Ensure the key is in authorized_keys for local SSH
            if ! grep -q "$(cat ${USER_SSH_KEY}.pub)" ~/.ssh/authorized_keys 2>/dev/null; then
                cat "${USER_SSH_KEY}.pub" >> ~/.ssh/authorized_keys
                chmod 600 ~/.ssh/authorized_keys
            fi
            
            export USER_PRIVATE_KEY_PATH="$HOME/.ssh/dockflow_key"
            USER_NEEDS_SETUP=false
        fi
        
        print_heading "CONFIGURATION SUMMARY"
        echo ""
        echo -e "${CYAN}Target:${NC} Local machine (127.0.0.1)"
        echo -e "${CYAN}Current user:${NC} $CURRENT_USER"
        echo -e "${CYAN}Deployment user:${NC} $USER"
        if [ "$USER_NEEDS_SETUP" = true ]; then
            echo -e "${CYAN}Deployment user will be created:${NC} Yes"
        else
            echo -e "${CYAN}Using current user for deployment:${NC} Yes"
        fi
        echo ""
        
        if ! confirm_action "Do you want to proceed with this configuration?" "y"; then
            print_warning "Setup aborted by user"
            exit 0
        fi
        
        # Configure services (Portainer, etc.)
        configure_services
        
        # Create deployment user if needed
        if [ "$USER_NEEDS_SETUP" = true ]; then
            create_ansible_user_locally
        fi
        
        # Override the ansible playbook run for local connection
        print_heading "EXECUTING ANSIBLE PLAYBOOK"
        
        SKIP_TAGS="deploy"
        if [[ "$INSTALL_PORTAINER" != "y" && "$INSTALL_PORTAINER" != "Y" && "${PORTAINER_INSTALL:-false}" != "true" ]]; then
            SKIP_TAGS="$SKIP_TAGS,portainer,nginx"
        fi
        
        export HOST=$SERVER_IP
        export PORT=$SSH_PORT
        
        echo "Running Ansible playbook on local machine..."
        export ANSIBLE_HOST_KEY_CHECKING=False
        ansible-galaxy role install geerlingguy.docker
        
        cd "$CLI_ROOT_DIR/.." || exit 1
        
        # Create a temporary inventory file for local setup
        # We can't use "localhost" because the playbook excludes it with "all:!localhost"
        # So we use "local" as the hostname with ansible_connection=local
        TEMP_INVENTORY=$(mktemp)
        cat > "$TEMP_INVENTORY" << EOF
[all]
local ansible_connection=local ansible_become_password=$BECOME_PASSWORD
EOF
        
        # Pass the become password directly via inventory instead of extra-vars for security
        ansible-playbook ansible/configure_host.yml \
            --inventory="$TEMP_INVENTORY" \
            --become \
            --become-method=sudo \
            --skip-tags "$SKIP_TAGS" \
            --extra-vars "skip_docker_install=${SKIP_DOCKER_INSTALL:-false} ansible_user=$USER"
        
        ANSIBLE_RETURN_CODE=$?
        
        # Clean up temporary inventory
        rm -f "$TEMP_INVENTORY"
        
        if [ $ANSIBLE_RETURN_CODE -eq 0 ]; then
            echo -e "\n${GREEN}==========================================================="
            echo "   LOCAL MACHINE SETUP COMPLETED"
            echo -e "===========================================================${NC}"
            echo ""
            echo -e "${YELLOW}Here is the SSH private key for deployment user $USER (keep it secure):${NC}"
            
            # Retrieve the private key from deployment user's home
            if [ "$USER" != "$(whoami)" ]; then
                # Different user - read from their home with sudo
                echo "${BECOME_PASSWORD}" | sudo -S cat "/home/$USER/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            else
                # Same user - read from current home
                cat "$HOME/.ssh/dockflow_key" 2>/dev/null || echo "[Error: Could not retrieve private key]"
            fi
            
            echo ""
            echo -e "${GREEN}This machine is now ready to receive deployments of Docker applications.${NC}"
            echo ""
        else
            echo -e "${RED}==========================================================="
            echo "   ANSIBLE PLAYBOOK FAILED!"
            echo -e "===========================================================${NC}"
            echo -e "${YELLOW}The setup process encountered errors. Please check the logs above for details.${NC}"
            echo ""
        fi
        
        echo ""
        read -p "Press Enter to exit..." -n 1 -r
        echo ""
        exit 0
    else
        print_warning "Invalid option."
        exit 1
    fi
}

export -f setup_machine_interactive
